use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;

pub fn hav(a: [f64; 2], b: [f64; 2]) -> f64 {
    let p1 = a[0].to_radians();
    let p2 = b[0].to_radians();
    let dp = p2 - p1;
    let dl = (b[1] - a[1]).to_radians();
    let h = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * 6371.0 * h.sqrt().asin()
}

/// Rail graph built from the OSM extract (ways tagged railway=rail, plus
/// railway=ferry train-ferry links such as the Qiongzhou strait crossing,
/// whose edges are recorded in `ferry_edges` so routed pairs can be
/// reported honestly). After the adjacency is built, components whose
/// closest nodes lie within 250 m of each other are stitched with a
/// connector edge: OSM mappers often draw station trackwork as ways that
/// end a few metres short of the through line without sharing a node,
/// and tunnel sections are sometimes left unmapped for a few hundred
/// metres — both otherwise strand whole stations on tiny graph islands.
/// (The pair audits and the old-vs-new pair diff gate the result: a
/// stitch can shorten a pair's A* distance by at most its own length.)
pub struct Graph {
    pub coords: Vec<[f64; 2]>,
    pub adj: Vec<Vec<(u32, f32)>>,
    /// OSM node id for each internal index (ids[i] is the node id of node i).
    pub ids: Vec<u64>,
    /// Undirected edges (endpoint pairs, lower index first) that come from
    /// railway=ferry ways — water crossings, not track.
    pub ferry_edges: std::collections::HashSet<(u32, u32)>,
}

impl Graph {
    pub fn is_ferry_edge(&self, a: u32, b: u32) -> bool {
        let (x, y) = if a < b { (a, b) } else { (b, a) };
        self.ferry_edges.contains(&(x, y))
    }
}

/// Two passes over the XML: first collect railway=rail / railway=ferry
/// ways' member ids, then coordinates for exactly those nodes.
pub fn build_graph(osm_path: &std::path::Path) -> Graph {
    use std::collections::HashSet;
    // (member node ids, is_ferry)
    let mut ways: Vec<(Vec<u64>, bool)> = Vec::new();
    let mut needed: HashSet<u64> = HashSet::new();
    {
        let mut reader = Reader::from_file(osm_path).expect("open osm (graph pass 1)");
        let mut buf: Vec<u8> = Vec::with_capacity(1 << 16);
        let mut in_way = false;
        let mut is_rail = false;
        let mut is_ferry = false;
        let mut refs: Vec<u64> = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) if e.name().as_ref() == b"way" => {
                    in_way = true;
                    is_rail = false;
                    is_ferry = false;
                    refs = Vec::new();
                }
                Ok(Event::Empty(e)) if e.name().as_ref() == b"nd" && in_way => {
                    if let Ok(r) = attr(&e, "ref").parse::<u64>() {
                        refs.push(r);
                    }
                }
                Ok(Event::Empty(e)) if e.name().as_ref() == b"tag" && in_way => {
                    if attr(&e, "k") == "railway" {
                        match attr(&e, "v").as_str() {
                            "rail" => is_rail = true,
                            "ferry" => is_ferry = true,
                            _ => {}
                        }
                    }
                }
                Ok(Event::End(e)) if e.name().as_ref() == b"way" => {
                    in_way = false;
                    if (is_rail || is_ferry) && refs.len() >= 2 {
                        for r in &refs {
                            needed.insert(*r);
                        }
                        ways.push((std::mem::take(&mut refs), is_ferry));
                    }
                }
                Ok(Event::Eof) => break,
                Err(e) => panic!("XML error (graph pass 1): {:?}", e),
                _ => {}
            }
            buf.clear();
        }
    }
    let mut coord_map: HashMap<u64, [f64; 2]> = HashMap::with_capacity(needed.len());
    {
        let mut reader = Reader::from_file(osm_path).expect("open osm (graph pass 2)");
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
                Ok(Event::Eof) => break,
                Err(e) => panic!("XML error (graph pass 2): {:?}", e),
                _ => {}
            }
            buf.clear();
        }
    }
    let mut ids: Vec<u64> = coord_map.keys().copied().collect();
    ids.sort_unstable();
    let idx_of: HashMap<u64, u32> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i as u32))
        .collect();
    let coords: Vec<[f64; 2]> = ids.iter().map(|id| coord_map[id]).collect();
    let mut adj: Vec<Vec<(u32, f32)>> = vec![Vec::new(); ids.len()];
    let mut edge_count = 0usize;
    let mut ferry_edges: HashSet<(u32, u32)> = HashSet::new();
    for (refs, is_ferry) in &ways {
        for w in refs.windows(2) {
            if let (Some(&a), Some(&b)) = (idx_of.get(&w[0]), idx_of.get(&w[1])) {
                if a == b {
                    continue;
                }
                let d = hav(coords[a as usize], coords[b as usize]) as f32;
                if d > 0.0 {
                    adj[a as usize].push((b, d));
                    adj[b as usize].push((a, d));
                    edge_count += 1;
                    if *is_ferry {
                        ferry_edges.insert((a.min(b), a.max(b)));
                    }
                }
            }
        }
    }

    // ---- stitch near-touching components (<= 250 m) ----
    // Label components, then for every pair of components keep the single
    // closest node pair within 250 m (0.02-degree grid, 3x3 neighbourhood
    // — a 250 m gap can span at most one cell boundary) and add it as a
    // connector edge weighted by its true length.
    let n = ids.len();
    let mut comp = vec![-1i32; n];
    let mut n_comp = 0i32;
    for s in 0..n {
        if comp[s] >= 0 {
            continue;
        }
        let mut stack = vec![s as u32];
        comp[s] = n_comp;
        while let Some(u) = stack.pop() {
            for &(v, _) in &adj[u as usize] {
                if comp[v as usize] < 0 {
                    comp[v as usize] = n_comp;
                    stack.push(v);
                }
            }
        }
        n_comp += 1;
    }
    let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for (i, c) in coords.iter().enumerate() {
        grid.entry(((c[0] * 50.0) as i32, (c[1] * 50.0) as i32))
            .or_default()
            .push(i as u32);
    }
    let mut stitch_best: HashMap<(i32, i32), (f64, u32, u32)> = HashMap::new();
    for u in 0..n as u32 {
        let cu = comp[u as usize];
        let pt = coords[u as usize];
        let (cx, cy) = ((pt[0] * 50.0) as i32, (pt[1] * 50.0) as i32);
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(nodes) = grid.get(&(cx + dx, cy + dy)) {
                    for &v in nodes {
                        let cv = comp[v as usize];
                        if cv == cu {
                            continue;
                        }
                        let d = hav(pt, coords[v as usize]);
                        if d <= 0.25 {
                            let key = (cu.min(cv), cu.max(cv));
                            let e = stitch_best.entry(key).or_insert((f64::INFINITY, 0, 0));
                            if d < e.0 {
                                *e = (d, u, v);
                            }
                        }
                    }
                }
            }
        }
    }
    let mut stitch_max = 0.0f64;
    for &(d, u, v) in stitch_best.values() {
        adj[u as usize].push((v, d as f32));
        adj[v as usize].push((u, d as f32));
        stitch_max = stitch_max.max(d);
    }
    println!(
        "rail graph: {} nodes, {} undirected edges (from {} rail/ferry ways, {} ferry edges); {} components, {} stitch connectors (max {:.3} km)",
        ids.len(),
        edge_count,
        ways.len(),
        ferry_edges.len(),
        n_comp,
        stitch_best.len(),
        stitch_max
    );
    Graph {
        coords,
        adj,
        ids,
        ferry_edges,
    }
}

/// A* shortest path (distance only). g/stamp buffers are caller-owned so
/// parallel workers don't share mutable state.
pub fn astar(
    g: &Graph,
    src: u32,
    dst: u32,
    gscore: &mut [f64],
    stamp: &mut [u32],
    run: u32,
) -> Option<f64> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    if src == dst {
        return Some(0.0);
    }
    let target = g.coords[dst as usize];
    let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::new();
    stamp[src as usize] = run;
    gscore[src as usize] = 0.0;
    heap.push(Reverse((
        hav(g.coords[src as usize], target).to_bits(),
        src,
    )));
    while let Some(Reverse((_, u))) = heap.pop() {
        if u == dst {
            return Some(gscore[u as usize]);
        }
        let gu = gscore[u as usize];
        // stale heap entry check: if a shorter g was recorded after push, the
        // pop order still guarantees first pop of dst is optimal; neighbors
        // relax against current best g.
        for &(v, w) in &g.adj[u as usize] {
            let ng = gu + w as f64;
            if stamp[v as usize] != run || ng < gscore[v as usize] {
                stamp[v as usize] = run;
                gscore[v as usize] = ng;
                let f = ng + hav(g.coords[v as usize], target);
                heap.push(Reverse((f.to_bits(), v)));
            }
        }
    }
    None
}

/// A* like `astar`, additionally reporting whether the shortest path
/// traverses a railway=ferry edge. `ferry_flag` is a caller-owned buffer
/// parallel to gscore/stamp: ferry_flag[v] is the ferry usage of the best
/// known path to v in this run, updated on every relaxation that improves
/// v's gscore, so at destination pop time it describes an optimal path.
pub fn astar_ferry(
    g: &Graph,
    src: u32,
    dst: u32,
    gscore: &mut [f64],
    stamp: &mut [u32],
    ferry_flag: &mut [bool],
    run: u32,
) -> Option<(f64, bool)> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    if src == dst {
        return Some((0.0, false));
    }
    let target = g.coords[dst as usize];
    let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::new();
    stamp[src as usize] = run;
    gscore[src as usize] = 0.0;
    ferry_flag[src as usize] = false;
    heap.push(Reverse((
        hav(g.coords[src as usize], target).to_bits(),
        src,
    )));
    while let Some(Reverse((_, u))) = heap.pop() {
        if u == dst {
            return Some((gscore[u as usize], ferry_flag[u as usize]));
        }
        let gu = gscore[u as usize];
        let fu = ferry_flag[u as usize];
        for &(v, w) in &g.adj[u as usize] {
            let ng = gu + w as f64;
            if stamp[v as usize] != run || ng < gscore[v as usize] {
                stamp[v as usize] = run;
                gscore[v as usize] = ng;
                ferry_flag[v as usize] = fu || g.is_ferry_edge(u, v);
                let f = ng + hav(g.coords[v as usize], target);
                heap.push(Reverse((f.to_bits(), v)));
            }
        }
    }
    None
}

pub fn attr(e: &quick_xml::events::BytesStart, key: &str) -> String {
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

/// Dijkstra from `src`, expanding only nodes within `max_dist` km along the
/// graph. Fills caller-owned dist/stamp buffers; `visited` returns the
/// reached node ids (cleared first). Used for gap-bridging probes.
pub fn dijkstra_limited(
    g: &Graph,
    src: u32,
    max_dist: f64,
    dist: &mut [f64],
    stamp: &mut [u32],
    run: u32,
    visited: &mut Vec<u32>,
) {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    visited.clear();
    let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::new();
    stamp[src as usize] = run;
    dist[src as usize] = 0.0;
    visited.push(src);
    heap.push(Reverse((0u64, src)));
    while let Some(Reverse((_, u))) = heap.pop() {
        let du = dist[u as usize];
        if du > max_dist {
            continue;
        }
        for &(v, w) in &g.adj[u as usize] {
            let nd = du + w as f64;
            if nd <= max_dist && (stamp[v as usize] != run || nd < dist[v as usize]) {
                if stamp[v as usize] != run {
                    visited.push(v);
                }
                stamp[v as usize] = run;
                dist[v as usize] = nd;
                heap.push(Reverse((nd.to_bits(), v)));
            }
        }
    }
}

/// A* with parent tracking: returns (distance, node path src..dst inclusive).
/// `parent` is a caller-owned buffer parallel to gscore/stamp.
pub fn astar_path(
    g: &Graph,
    src: u32,
    dst: u32,
    gscore: &mut [f64],
    stamp: &mut [u32],
    parent: &mut [u32],
    run: u32,
) -> Option<(f64, Vec<u32>)> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    if src == dst {
        return Some((0.0, vec![src]));
    }
    let target = g.coords[dst as usize];
    let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::new();
    stamp[src as usize] = run;
    gscore[src as usize] = 0.0;
    parent[src as usize] = src;
    heap.push(Reverse((
        hav(g.coords[src as usize], target).to_bits(),
        src,
    )));
    while let Some(Reverse((_, u))) = heap.pop() {
        if u == dst {
            let mut path = vec![dst];
            let mut cur = dst;
            while cur != src {
                cur = parent[cur as usize];
                path.push(cur);
            }
            path.reverse();
            return Some((gscore[dst as usize], path));
        }
        let gu = gscore[u as usize];
        for &(v, w) in &g.adj[u as usize] {
            let ng = gu + w as f64;
            if stamp[v as usize] != run || ng < gscore[v as usize] {
                stamp[v as usize] = run;
                gscore[v as usize] = ng;
                parent[v as usize] = u;
                let f = ng + hav(g.coords[v as usize], target);
                heap.push(Reverse((f.to_bits(), v)));
            }
        }
    }
    None
}

/// Dijkstra (radius-limited) with parent tracking. Fills dist/stamp/parent;
/// `visited` returns reached node ids. Reconstruct a path to any visited
/// node by walking parent[] back to src.
#[allow(clippy::too_many_arguments)]
pub fn dijkstra_parents(
    g: &Graph,
    src: u32,
    max_dist: f64,
    dist: &mut [f64],
    stamp: &mut [u32],
    parent: &mut [u32],
    run: u32,
    visited: &mut Vec<u32>,
) {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    visited.clear();
    let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::new();
    stamp[src as usize] = run;
    dist[src as usize] = 0.0;
    parent[src as usize] = src;
    visited.push(src);
    heap.push(Reverse((0u64, src)));
    while let Some(Reverse((_, u))) = heap.pop() {
        let du = dist[u as usize];
        if du > max_dist {
            continue;
        }
        for &(v, w) in &g.adj[u as usize] {
            let nd = du + w as f64;
            if nd <= max_dist && (stamp[v as usize] != run || nd < dist[v as usize]) {
                if stamp[v as usize] != run {
                    visited.push(v);
                }
                stamp[v as usize] = run;
                dist[v as usize] = nd;
                parent[v as usize] = u;
                heap.push(Reverse((nd.to_bits(), v)));
            }
        }
    }
}

/// Walk parent[] from `node` back to the Dijkstra/A* source, returning the
/// path in source..node order.
pub fn reconstruct(parent: &[u32], src: u32, node: u32) -> Vec<u32> {
    let mut path = vec![node];
    let mut cur = node;
    while cur != src {
        cur = parent[cur as usize];
        path.push(cur);
    }
    path.reverse();
    path
}
