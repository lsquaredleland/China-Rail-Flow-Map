//! Network seam: OSM extract -> attributed rail graph. With the default
//! `NetworkConfig` this is the same topology as `analyze/src/graph.rs`
//! (railway=rail + railway=ferry ways, components stitched at <= 250 m),
//! but every edge also carries a speed limit, a high-speed flag, a
//! service flag and its line name, so paths can be costed in time.
//! Which ways count as track, which tag names a line, the stitch radius
//! and the speed defaults all come from `NetworkConfig`.
use crate::config::NetworkConfig;
use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;

pub const F_HSR: u8 = 1;
pub const F_FERRY: u8 = 2;
pub const F_STITCH: u8 = 4;
pub const F_SERVICE: u8 = 8;
/// Edge used by production pair geometry. On double track (two parallel
/// OSM ways) searches prefer this track, so a re-routed train lands on
/// the same edges the atlas already draws for that line instead of
/// splitting the corridor's flow across the parallel way.
pub const F_PROD: u8 = 16;
/// Cost factor on F_PROD edges.
const PROD_DISCOUNT: f64 = 0.97;
pub const NO_LINE: u32 = u32::MAX;

/// Great-circle distance in km between two [lat, lon] points.
pub fn hav(a: [f64; 2], b: [f64; 2]) -> f64 {
    let p1 = a[0].to_radians();
    let p2 = b[0].to_radians();
    let dl = (b[1] - a[1]).to_radians();
    let h = ((p2 - p1) / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * 6371.0 * h.sqrt().asin()
}

/// Initial bearing in degrees from `a` to `b` ([lat, lon] points).
pub fn bearing(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (p1, p2) = (a[0].to_radians(), b[0].to_radians());
    let dl = (b[1] - a[1]).to_radians();
    let y = dl.sin() * p2.cos();
    let x = p1.cos() * p2.sin() - p1.sin() * p2.cos() * dl.cos();
    y.atan2(x).to_degrees().rem_euclid(360.0)
}

#[derive(Clone, Copy)]
pub struct Edge {
    pub to: u32,
    pub km: f32,
    pub vmax: u16,
    pub flags: u8,
    pub line: u32,
}

pub struct Graph {
    /// [lat, lon] per node.
    pub coords: Vec<[f64; 2]>,
    /// OSM node id per node.
    pub ids: Vec<u64>,
    pub adj: Vec<Vec<Edge>>,
    /// Interned way names (`Edge::line` indexes this).
    pub lines: Vec<String>,
    /// Distinct track neighbours before stitching; 1 marks a dangling
    /// track end, where unmapped gaps start.
    pub degree: Vec<u8>,
}

impl Graph {
    /// Flag every edge on the given OSM node-id paths as F_PROD; returns
    /// how many undirected edges were flagged.
    pub fn mark_prod(&mut self, paths: &[&Vec<u64>]) -> usize {
        let mut n = 0;
        for p in paths {
            let idx: Vec<Option<u32>> = p.iter().map(|id| self.index_of(*id)).collect();
            for w in idx.windows(2) {
                let (Some(a), Some(b)) = (w[0], w[1]) else {
                    continue;
                };
                for (x, y) in [(a, b), (b, a)] {
                    for e in self.adj[x as usize].iter_mut() {
                        if e.to == y && e.flags & F_PROD == 0 {
                            e.flags |= F_PROD;
                            if x < y {
                                n += 1;
                            }
                        }
                    }
                }
            }
        }
        n
    }

    pub fn index_of(&self, osm_id: u64) -> Option<u32> {
        self.ids.binary_search(&osm_id).ok().map(|i| i as u32)
    }

    /// The edge u->v, if the two nodes are adjacent.
    pub fn edge(&self, u: u32, v: u32) -> Option<&Edge> {
        self.adj[u as usize].iter().find(|e| e.to == v)
    }
}

/// First numeric value of an OSM maxspeed tag in km/h ("350",
/// "160 km/h", "60 mph", "350;250"); None for "signals", "none", junk.
pub fn parse_speed(v: &str) -> Option<f64> {
    let first = v.split([';', ',']).next()?.trim();
    let num: String = first
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let x: f64 = num.parse().ok()?;
    let x = if first.ends_with("mph") { x * 1.609 } else { x };
    (5.0..=450.0).contains(&x).then_some(x)
}

#[derive(Default)]
struct WayTags {
    rail: bool,
    ferry: bool,
    maxspeed: Option<f64>,
    highspeed: bool,
    service: bool,
    usage: String,
    name: String,
}

impl WayTags {
    /// Speed limit used for routing: the tagged maxspeed, else a default
    /// from the way's role (high-speed line, main line, branch, sidings).
    fn vmax(&self, cfg: &NetworkConfig) -> f64 {
        if self.ferry {
            return cfg.ferry_kmh;
        }
        if self.service {
            return cfg.service_kmh;
        }
        if let Some(v) = self.maxspeed {
            return v.clamp(cfg.maxspeed_min, cfg.maxspeed_max);
        }
        if self.highspeed {
            return cfg.highspeed_kmh;
        }
        cfg.usage_kmh
            .get(self.usage.as_str())
            .copied()
            .unwrap_or(cfg.default_kmh)
    }

    fn flags(&self) -> u8 {
        let mut f = 0;
        if self.highspeed {
            f |= F_HSR;
        }
        if self.ferry {
            f |= F_FERRY;
        }
        if self.service {
            f |= F_SERVICE;
        }
        f
    }
}

fn attr(e: &quick_xml::events::BytesStart, key: &str) -> String {
    for a in e.attributes().flatten() {
        if a.key.as_ref() == key.as_bytes() {
            return a
                .unescape_value()
                .map(|c| c.into_owned())
                .unwrap_or_default();
        }
    }
    String::new()
}

/// Two passes over the rail extract (ways with tags, then node coords),
/// then the component stitching used by the production graph.
pub fn build(osm_path: &std::path::Path, cfg: &NetworkConfig) -> Graph {
    assert!(
        cfg.stitch_km <= 1.0,
        "network.stitch_km must be <= 1.0 (stitch grid reach)"
    );
    assert!(
        cfg.maxspeed_max <= 350.0 && cfg.highspeed_kmh <= 350.0,
        "edge speeds above 350 km/h break the A* bound (Metric::bound)"
    );
    let mut ways: Vec<(Vec<u64>, u16, u8, u32)> = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    let mut line_idx: HashMap<String, u32> = HashMap::new();
    let mut needed: std::collections::HashSet<u64> = std::collections::HashSet::new();
    {
        let mut reader = Reader::from_file(osm_path).expect("open osm (pass 1)");
        let mut buf: Vec<u8> = Vec::with_capacity(1 << 16);
        let mut in_way = false;
        let mut tags = WayTags::default();
        let mut refs: Vec<u64> = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) if e.name().as_ref() == b"way" => {
                    in_way = true;
                    tags = WayTags::default();
                    refs = Vec::new();
                }
                Ok(Event::Empty(e)) if in_way && e.name().as_ref() == b"nd" => {
                    if let Ok(r) = attr(&e, "ref").parse::<u64>() {
                        refs.push(r);
                    }
                }
                Ok(Event::Empty(e)) if in_way && e.name().as_ref() == b"tag" => {
                    let v = attr(&e, "v");
                    let k = attr(&e, "k");
                    if k == cfg.way_key {
                        if cfg.rail_values.contains(&v) {
                            tags.rail = true;
                        } else if cfg.ferry_values.contains(&v) {
                            tags.ferry = true;
                        }
                    } else if k == cfg.name_key {
                        tags.name = v;
                    } else {
                        match k.as_str() {
                            "maxspeed" => tags.maxspeed = parse_speed(&v),
                            "highspeed" => tags.highspeed = v == "yes",
                            "service" => tags.service = true,
                            "usage" => tags.usage = v,
                            _ => {}
                        }
                    }
                }
                Ok(Event::End(e)) if e.name().as_ref() == b"way" => {
                    in_way = false;
                    if (tags.rail || tags.ferry) && refs.len() >= 2 {
                        needed.extend(refs.iter().copied());
                        let line = if tags.name.is_empty() {
                            NO_LINE
                        } else {
                            *line_idx.entry(tags.name.clone()).or_insert_with(|| {
                                lines.push(tags.name.clone());
                                (lines.len() - 1) as u32
                            })
                        };
                        ways.push((
                            std::mem::take(&mut refs),
                            tags.vmax(cfg).round() as u16,
                            tags.flags(),
                            line,
                        ));
                    }
                }
                Ok(Event::Eof) => break,
                Err(e) => panic!("XML error (pass 1): {e:?}"),
                _ => {}
            }
            buf.clear();
        }
    }
    let mut coord_map: HashMap<u64, [f64; 2]> = HashMap::with_capacity(needed.len());
    {
        let mut reader = Reader::from_file(osm_path).expect("open osm (pass 2)");
        let mut buf: Vec<u8> = Vec::with_capacity(1 << 16);
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.name().as_ref() == b"node" => {
                    if let Ok(id) = attr(&e, "id").parse::<u64>() {
                        if needed.contains(&id) {
                            coord_map.insert(
                                id,
                                [
                                    attr(&e, "lat").parse().unwrap_or(0.0),
                                    attr(&e, "lon").parse().unwrap_or(0.0),
                                ],
                            );
                        }
                    }
                }
                Ok(Event::Start(e)) if e.name().as_ref() == b"way" => break,
                Ok(Event::Eof) => break,
                Err(e) => panic!("XML error (pass 2): {e:?}"),
                _ => {}
            }
            buf.clear();
        }
    }
    let mut ids: Vec<u64> = coord_map.keys().copied().collect();
    ids.sort_unstable();
    let idx_of = |id: u64| ids.binary_search(&id).ok().map(|i| i as u32);
    let coords: Vec<[f64; 2]> = ids.iter().map(|id| coord_map[id]).collect();
    let n = ids.len();
    let mut adj: Vec<Vec<Edge>> = vec![Vec::new(); n];
    for (refs, vmax, flags, line) in &ways {
        for w in refs.windows(2) {
            let (Some(a), Some(b)) = (idx_of(w[0]), idx_of(w[1])) else {
                continue;
            };
            let km = hav(coords[a as usize], coords[b as usize]) as f32;
            if a == b || km <= 0.0 {
                continue;
            }
            for (x, y) in [(a, b), (b, a)] {
                adj[x as usize].push(Edge {
                    to: y,
                    km,
                    vmax: *vmax,
                    flags: *flags,
                    line: *line,
                });
            }
        }
    }
    let degree: Vec<u8> = adj
        .iter()
        .map(|es| {
            let mut t: Vec<u32> = es.iter().map(|e| e.to).collect();
            t.sort_unstable();
            t.dedup();
            t.len().min(255) as u8
        })
        .collect();

    // ---- stitch near-touching components (<= stitch_km), as in production ----
    let mut comp = vec![-1i32; n];
    let mut n_comp = 0i32;
    for s in 0..n {
        if comp[s] >= 0 {
            continue;
        }
        let mut stack = vec![s as u32];
        comp[s] = n_comp;
        while let Some(u) = stack.pop() {
            for e in &adj[u as usize] {
                if comp[e.to as usize] < 0 {
                    comp[e.to as usize] = n_comp;
                    stack.push(e.to);
                }
            }
        }
        n_comp += 1;
    }
    let cell = |p: [f64; 2]| ((p[0] * 50.0) as i32, (p[1] * 50.0) as i32);
    let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for (i, c) in coords.iter().enumerate() {
        grid.entry(cell(*c)).or_default().push(i as u32);
    }
    let mut best: HashMap<(i32, i32), (f64, u32, u32)> = HashMap::new();
    for u in 0..n as u32 {
        let (cu, pt) = (comp[u as usize], coords[u as usize]);
        let (cx, cy) = cell(pt);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for &v in grid.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                    let cv = comp[v as usize];
                    if cv == cu {
                        continue;
                    }
                    let d = hav(pt, coords[v as usize]);
                    if d <= cfg.stitch_km {
                        let e =
                            best.entry((cu.min(cv), cu.max(cv)))
                                .or_insert((f64::INFINITY, 0, 0));
                        if d < e.0 {
                            *e = (d, u, v);
                        }
                    }
                }
            }
        }
    }
    // stitch edges in component-pair order, not hash order, so adjacency
    // (and with it every exact-cost tie in A*/Dijkstra) is reproducible
    let n_stitch = best.len();
    let stitch_vmax = cfg.stitch_kmh.round() as u16;
    let mut stitches: Vec<_> = best.into_iter().collect();
    stitches.sort_unstable_by_key(|(k, _)| *k);
    for (_, (d, u, v)) in stitches {
        for (x, y) in [(u, v), (v, u)] {
            adj[x as usize].push(Edge {
                to: y,
                km: d as f32,
                vmax: stitch_vmax,
                flags: F_STITCH,
                line: NO_LINE,
            });
        }
    }
    println!(
        "graph: {} nodes, {} ways, {} components, {} stitches, {} named lines",
        n,
        ways.len(),
        n_comp,
        n_stitch,
        lines.len()
    );
    Graph {
        coords,
        ids,
        adj,
        lines,
        degree,
    }
}

/// How a search prices an edge.
#[derive(Clone, Copy)]
pub enum Metric {
    /// Hours at min(edge limit, `cap`) km/h; edges of dedicated
    /// high-speed lines (highspeed=yes, limit >= 250) cost `hsr_mult`
    /// times as much (conventional trains cannot use them).
    Time { cap: f64, hsr_mult: f64 },
    /// Plain track kilometres.
    Distance,
}

impl Metric {
    pub fn cost(&self, e: &Edge) -> f64 {
        let c = self.raw_cost(e);
        if e.flags & F_PROD != 0 {
            c * PROD_DISCOUNT
        } else {
            c
        }
    }

    fn raw_cost(&self, e: &Edge) -> f64 {
        let km = e.km as f64;
        match *self {
            Metric::Distance => km,
            Metric::Time { cap, hsr_mult } => {
                let t = km / (e.vmax as f64).min(cap);
                if e.flags & F_HSR != 0 && e.vmax >= 250 {
                    t * hsr_mult
                } else {
                    t
                }
            }
        }
    }

    /// Admissible lower bound for `km` of straight-line distance.
    fn bound(&self, km: f64) -> f64 {
        let b = match *self {
            Metric::Distance => km,
            Metric::Time { .. } => km / 350.0,
        };
        b * PROD_DISCOUNT
    }

    /// Cost of reaching the track from a station point `km` away.
    pub fn snap_cost(&self, km: f64) -> f64 {
        match *self {
            Metric::Distance => km * 2.0,
            Metric::Time { .. } => km / 30.0,
        }
    }
}

/// Per-thread search state, reused across searches (stamped, never cleared).
pub struct Buffers {
    g: Vec<f64>,
    stamp: Vec<u32>,
    parent: Vec<u32>,
    run: u32,
}

impl Buffers {
    pub fn new(n: usize) -> Self {
        Buffers {
            g: vec![0.0; n],
            stamp: vec![0; n],
            parent: vec![0; n],
            run: 0,
        }
    }
}

/// Station attachment: track nodes near a station point with their
/// straight-line distance (km), nearest first.
pub type Snap = Vec<(u32, f64)>;

pub struct SnapIndex {
    grid: HashMap<(i32, i32), Vec<u32>>,
}

impl SnapIndex {
    pub fn new(g: &Graph) -> Self {
        let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for (i, c) in g.coords.iter().enumerate() {
            grid.entry(((c[0] * 50.0) as i32, (c[1] * 50.0) as i32))
                .or_default()
                .push(i as u32);
        }
        SnapIndex { grid }
    }

    /// Track nodes within 1.5 km of `pt` (up to 48, nearest first); if
    /// none, the single nearest node within 6 km (the production rule).
    pub fn snap(&self, g: &Graph, pt: [f64; 2]) -> Snap {
        let (cx, cy) = ((pt[0] * 50.0) as i32, (pt[1] * 50.0) as i32);
        let mut near: Vec<(u32, f64)> = Vec::new();
        for dx in -4..=4 {
            for dy in -4..=4 {
                for &v in self.grid.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                    near.push((v, hav(pt, g.coords[v as usize])));
                }
            }
        }
        near.sort_by(|a, b| a.1.total_cmp(&b.1));
        let close: Snap = near
            .iter()
            .copied()
            .filter(|x| x.1 <= 1.5)
            .take(48)
            .collect();
        if !close.is_empty() {
            return close;
        }
        if let Some(&x) = near.first().filter(|x| x.1 <= 6.0) {
            return vec![x];
        }
        // wider ring for stations further than ~8 km grid reach
        let mut best: Option<(u32, f64)> = None;
        for dx in -16..=16 {
            for dy in -16..=16 {
                for &v in self.grid.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                    let d = hav(pt, g.coords[v as usize]);
                    if d <= 6.0 && best.is_none_or(|b| d < b.1) {
                        best = Some((v, d));
                    }
                }
            }
        }
        best.into_iter().collect()
    }
}

/// Fine (~0.28 km) grid over all graph nodes, for "everything near this
/// corridor" queries.
pub struct FineIndex {
    grid: HashMap<(i32, i32), Vec<u32>>,
}

const FINE_CELL: f64 = 400.0;

impl FineIndex {
    pub fn new(g: &Graph) -> Self {
        let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for (i, c) in g.coords.iter().enumerate() {
            grid.entry(((c[0] * FINE_CELL) as i32, (c[1] * FINE_CELL) as i32))
                .or_default()
                .push(i as u32);
        }
        FineIndex { grid }
    }

    /// Graph nodes within `km` (<= ~0.28) of `p`.
    pub fn near<'a>(
        &'a self,
        g: &'a Graph,
        p: [f64; 2],
        km: f64,
    ) -> impl Iterator<Item = u32> + 'a {
        let (cx, cy) = ((p[0] * FINE_CELL) as i32, (p[1] * FINE_CELL) as i32);
        (-1..=1)
            .flat_map(move |dx| (-1..=1).map(move |dy| (cx + dx, cy + dy)))
            .filter_map(|c| self.grid.get(&c))
            .flatten()
            .copied()
            .filter(move |&v| hav(p, g.coords[v as usize]) <= km)
    }
}

/// Multi-source / multi-target A*: from the `from` snap set to the `to`
/// snap set (each node entered/left at its snap cost), edges priced by
/// `metric` and multiplied by `penalty` where listed. Gives up once
/// the bound exceeds `max_cost`. Returns (cost, node path).
#[allow(clippy::too_many_arguments)]
pub fn route(
    g: &Graph,
    buf: &mut Buffers,
    from: &Snap,
    to: &Snap,
    to_pt: [f64; 2],
    metric: Metric,
    penalty: &HashMap<(u32, u32), f64>,
    max_cost: f64,
) -> Option<(f64, Vec<u32>)> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    buf.run = buf.run.wrapping_add(1);
    if buf.run == 0 {
        buf.stamp.iter_mut().for_each(|s| *s = 0);
        buf.run = 1;
    }
    let run = buf.run;
    let radius = to.iter().map(|x| x.1).fold(0.0, f64::max);
    let targets: HashMap<u32, f64> = to.iter().map(|&(v, d)| (v, metric.snap_cost(d))).collect();
    let h = |v: u32| metric.bound((hav(g.coords[v as usize], to_pt) - radius).max(0.0));
    let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::new();
    for &(s, d) in from {
        let c = metric.snap_cost(d);
        if buf.stamp[s as usize] != run || c < buf.g[s as usize] {
            buf.stamp[s as usize] = run;
            buf.g[s as usize] = c;
            buf.parent[s as usize] = s;
            heap.push(Reverse(((c + h(s)).to_bits(), s)));
        }
    }
    let mut best: Option<(f64, u32)> = None;
    while let Some(Reverse((fb, u))) = heap.pop() {
        let f = f64::from_bits(fb);
        if f > max_cost || best.is_some_and(|b| f >= b.0) {
            break;
        }
        let gu = buf.g[u as usize];
        if f > gu + h(u) + 1e-9 {
            continue; // stale entry
        }
        if let Some(tc) = targets.get(&u) {
            let total = gu + tc;
            if best.is_none_or(|b| total < b.0) {
                best = Some((total, u));
            }
        }
        for e in &g.adj[u as usize] {
            let mut c = metric.cost(e);
            if let Some(p) = penalty.get(&(u.min(e.to), u.max(e.to))) {
                c *= p;
            }
            let ng = gu + c;
            let v = e.to as usize;
            if buf.stamp[v] != run || ng < buf.g[v] {
                buf.stamp[v] = run;
                buf.g[v] = ng;
                buf.parent[v] = u;
                heap.push(Reverse(((ng + h(e.to)).to_bits(), e.to)));
            }
        }
    }
    let (cost, end) = best?;
    let mut path = vec![end];
    let mut cur = end;
    while buf.parent[cur as usize] != cur {
        cur = buf.parent[cur as usize];
        path.push(cur);
    }
    path.reverse();
    Some((cost, path))
}

/// Parallel-track hop for map redraws: OSM maps double track as separate
/// ways joined only at (often unmapped) crossovers. A redraw may step to
/// a node within HOP_KM on a way of the SAME named line, at the hop
/// length plus HOP_COST; distinct lines (e.g. an HSR beside a
/// conventional line) are never merged.
pub const HOP_KM: f64 = 0.03;
const HOP_COST: f64 = 0.002;

fn line_ids(g: &Graph, v: u32) -> impl Iterator<Item = u32> + '_ {
    g.adj[v as usize]
        .iter()
        .map(|e| e.line)
        .filter(|l| *l != NO_LINE)
}

fn same_line(g: &Graph, u: u32, v: u32) -> bool {
    line_ids(g, u).any(|a| line_ids(g, v).any(|b| a == b))
}

/// Dijkstra from node `src` to node `dst` with a caller-supplied edge
/// cost (used to redraw a chosen corridor on the most-used track). With
/// `hop`, same-line parallel tracks are joined by virtual hops (see
/// HOP_KM); hop steps appear in the path as consecutive non-adjacent
/// nodes.
pub fn route_custom(
    g: &Graph,
    buf: &mut Buffers,
    src: u32,
    dst: u32,
    cost: impl Fn(u32, &Edge) -> f64,
    hop: Option<&FineIndex>,
    max_cost: f64,
) -> Option<Vec<u32>> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    buf.run = buf.run.wrapping_add(1);
    if buf.run == 0 {
        buf.stamp.iter_mut().for_each(|s| *s = 0);
        buf.run = 1;
    }
    let run = buf.run;
    buf.stamp[src as usize] = run;
    buf.g[src as usize] = 0.0;
    buf.parent[src as usize] = src;
    let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::new();
    heap.push(Reverse((0f64.to_bits(), src)));
    while let Some(Reverse((db, u))) = heap.pop() {
        let du = f64::from_bits(db);
        if du > buf.g[u as usize] + 1e-12 {
            continue;
        }
        if du > max_cost {
            return None;
        }
        if u == dst {
            let mut path = vec![dst];
            let mut cur = dst;
            while buf.parent[cur as usize] != cur {
                cur = buf.parent[cur as usize];
                path.push(cur);
            }
            path.reverse();
            return Some(path);
        }
        let mut relax = |v: u32, nd: f64, heap: &mut BinaryHeap<Reverse<(u64, u32)>>| {
            let vi = v as usize;
            if buf.stamp[vi] != run || nd < buf.g[vi] {
                buf.stamp[vi] = run;
                buf.g[vi] = nd;
                buf.parent[vi] = u;
                heap.push(Reverse((nd.to_bits(), v)));
            }
        };
        for e in &g.adj[u as usize] {
            relax(e.to, du + cost(u, e), &mut heap);
        }
        if let Some(fine) = hop {
            let pu = g.coords[u as usize];
            for v in fine.near(g, pu, HOP_KM) {
                if v != u && g.edge(u, v).is_none() && same_line(g, u, v) {
                    relax(v, du + hav(pu, g.coords[v as usize]) + HOP_COST, &mut heap);
                }
            }
        }
    }
    None
}

/// Distance-limited Dijkstra from a snap set; returns the reached nodes
/// with their track distance (km) and parent pointers for reconstruction.
pub fn reach(g: &Graph, from: &Snap, max_km: f64) -> HashMap<u32, (f64, u32)> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    let mut out: HashMap<u32, (f64, u32)> = HashMap::new();
    let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::new();
    for &(s, d) in from {
        if out.get(&s).is_none_or(|x| d < x.0) {
            out.insert(s, (d, s));
            heap.push(Reverse((d.to_bits(), s)));
        }
    }
    while let Some(Reverse((db, u))) = heap.pop() {
        let du = f64::from_bits(db);
        if du > out[&u].0 + 1e-12 {
            continue;
        }
        for e in &g.adj[u as usize] {
            if e.flags & F_FERRY != 0 {
                continue;
            }
            let nd = du + e.km as f64;
            if nd <= max_km && out.get(&e.to).is_none_or(|x| nd < x.0) {
                out.insert(e.to, (nd, u));
                heap.push(Reverse((nd.to_bits(), e.to)));
            }
        }
    }
    out
}

/// Path from the reach() source to `node`, source first.
pub fn reach_path(tree: &HashMap<u32, (f64, u32)>, node: u32) -> Vec<u32> {
    let mut path = vec![node];
    let mut cur = node;
    while let Some(&(_, p)) = tree.get(&cur) {
        if p == cur {
            break;
        }
        path.push(p);
        cur = p;
    }
    path.reverse();
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speeds_parse() {
        assert_eq!(parse_speed("350"), Some(350.0));
        assert_eq!(parse_speed("160 km/h"), Some(160.0));
        assert_eq!(parse_speed("350;250"), Some(350.0));
        assert!((parse_speed("60 mph").unwrap() - 96.54).abs() < 0.01);
        assert_eq!(parse_speed("signals"), None);
        assert_eq!(parse_speed("none"), None);
    }

    #[test]
    fn way_filter_and_speeds_follow_network_config() {
        let osm = r#"<osm>
<node id="1" lat="30.0" lon="120.0"/><node id="2" lat="30.0" lon="120.01"/><node id="3" lat="30.0" lon="120.02"/>
<way id="1"><nd ref="1"/><nd ref="2"/><tag k="railway" v="rail"/><tag k="usage" v="main"/><tag k="name" v="A"/></way>
<way id="2"><nd ref="2"/><nd ref="3"/><tag k="railway" v="light_rail"/><tag k="name:en" v="B"/></way>
</osm>"#;
        let p = std::env::temp_dir().join(format!("router-graph-test-{}.osm", std::process::id()));
        std::fs::write(&p, osm).unwrap();
        let china = build(&p, &NetworkConfig::default());
        assert_eq!(china.ids, vec![1, 2]);
        assert_eq!(china.adj[0][0].vmax, 120);
        assert_eq!(china.lines, vec!["A".to_string()]);
        let cfg = NetworkConfig {
            rail_values: vec!["rail".into(), "light_rail".into()],
            name_key: "name:en".into(),
            default_kmh: 70.0,
            ..NetworkConfig::default()
        };
        let other = build(&p, &cfg);
        std::fs::remove_file(&p).unwrap();
        assert_eq!(other.ids, vec![1, 2, 3]);
        assert_eq!(other.edge(1, 2).unwrap().vmax, 70);
        assert_eq!(other.lines, vec!["B".to_string()]);
    }

    #[test]
    fn bearings() {
        assert!((bearing([0.0, 0.0], [1.0, 0.0]) - 0.0).abs() < 1e-6);
        assert!((bearing([0.0, 0.0], [0.0, 1.0]) - 90.0).abs() < 1e-6);
        assert!((bearing([0.0, 0.0], [-1.0, 0.0]) - 180.0).abs() < 1e-6);
    }
}
