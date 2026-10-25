// corridor-router — per-train corridor inference (staging, corridor-v3).
//
// Production draws every train between two consecutive stops on ONE
// stored geometry per station pair. This tool instead:
//   1. builds the rail graph with OSM speed limits / high-speed flags;
//   2. generates several genuinely different candidate corridors per
//      pair (fastest per class group, shortest, penalty-diversified
//      alternatives, plus the production geometry itself);
//   3. learns how scheduled minutes relate to modelled run time per
//      class from legs whose corridor is not in doubt;
//   4. re-bridges gapped pairs choosing the SMALLEST plausible gap
//      (production minimises total length, which favours the largest
//      allowed straight-line shortcut);
//   5. scores every train leg against every candidate, links each
//      train's consecutive legs (reversal penalty), and takes the
//      posterior;
//   6. switches a leg away from production geometry only on decisive
//      evidence, and writes per-leg paths for atlas.rs (ATLAS_LEG_PATHS);
//   7. self-checks on stopping trains: hide the stop, ask the model
//      which corridor the train took, compare with where it stopped.
//
// Usage: corridor-router [--project <dir>] [--files <dir>] [--out <dir>]
//                        [--limit <n pairs>] [--pair "A,B"] [--threads <n>]
//                        [--station-fixes <station_resolution-format json>]
mod graph;
mod inputs;
mod model;

use graph::{hav, route, route_custom, Buffers, FineIndex, Graph, Metric, Snap, SnapIndex};
use inputs::{clean, dwell, travel_time, Train};
use model::{class_index, Calibration, Cand, LegObs, Shape, CLASS_NAMES, NCLASS};
use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

type Key = (String, String);

/// Candidate acceptance: length bounds vs chord and vs the shortest.
const MAX_LEN_CHORD: f64 = 2.0;
const MAX_LEN_SHORTEST: f64 = 1.6;
const DISTINCT_OVERLAP: f64 = 0.8;
const BASE_SAME_OVERLAP: f64 = 0.9;
const PENALTY_ROUNDS: usize = 3;
const PENALTY_MULT: f64 = 4.0;
/// Corridor buffer for the map redraw of a chosen candidate.
const REDRAW_BUFFER_KM: f64 = 0.2;
/// Canonical-geometry rounds: each round re-weights tracks by the
/// previous round's usage, so the busier of two parallel tracks wins.
const REDRAW_ROUNDS: usize = 4;
/// Calibration: legs whose feasible candidates predict within this
/// ratio of each other have an undisputed corridor.
const UNDISPUTED_SPREAD: f64 = 1.04;
/// Bridging limits (as production) and the gap-improvement threshold.
const BRIDGE_MAX_GAP_KM: f64 = 10.0;
const BRIDGE_RATIO: (f64, f64) = (0.95, 1.45);
const BRIDGE_MAX_KMH: f64 = 355.0;
const BRIDGE_GAP_GAIN_KM: f64 = 0.5;

fn argval(flag: &str) -> Option<String> {
    let a: Vec<String> = env::args().collect();
    a.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
}

struct Timer {
    t0: Instant,
    last: Instant,
    marks: Vec<(String, f64)>,
}

impl Timer {
    fn new() -> Self {
        let now = Instant::now();
        Timer {
            t0: now,
            last: now,
            marks: Vec::new(),
        }
    }
    fn mark(&mut self, what: &str) {
        let s = self.last.elapsed().as_secs_f64();
        println!(
            "[{:7.2}s] {what} ({s:.2}s)",
            self.t0.elapsed().as_secs_f64()
        );
        self.marks.push((what.to_string(), s));
        self.last = Instant::now();
    }
}

/// A train's leg between consecutive stops `j` -> `j + 1`.
struct Leg {
    train: usize,
    j: usize,
    key: Key,
    forward: bool,
    class: usize,
    minutes: Option<f64>,
}

struct PairInfo {
    key: Key,
    pa: [f64; 2],
    pb: [f64; 2],
    chord: f64,
    prod_status: String,
    prod_gap: Option<f64>,
    prod_track: Option<f64>,
    class_mask: u32,
    dominant: usize,
    min_minutes: Option<f64>,
}

fn pick_points(
    pts_a: &[[f64; 2]],
    pts_b: &[[f64; 2]],
    chord: Option<f64>,
    snaps: &dyn Fn([f64; 2]) -> bool,
) -> Option<([f64; 2], [f64; 2])> {
    let mut best: Option<(f64, [f64; 2], [f64; 2])> = None;
    let mut best_snap: Option<(f64, [f64; 2], [f64; 2])> = None;
    for &a in pts_a {
        for &b in pts_b {
            let err = match chord {
                Some(c) => (hav(a, b) - c).abs(),
                None => hav(a, b),
            };
            if best.is_none_or(|x| err < x.0) {
                best = Some((err, a, b));
            }
            if snaps(a) && snaps(b) && best_snap.is_none_or(|x| err < x.0) {
                best_snap = Some((err, a, b));
            }
        }
    }
    best_snap.or(best).map(|(_, a, b)| (a, b))
}

/// Candidate corridors for one pair.
fn gen_candidates(
    g: &Graph,
    fine: &FineIndex,
    buf: &mut Buffers,
    p: &PairInfo,
    sa: &Snap,
    sb: &Snap,
    base: Option<&(String, Vec<Vec<u64>>)>,
) -> Vec<Cand> {
    let mut cands: Vec<Cand> = Vec::new();
    let mut sets: Vec<Shape> = Vec::new();
    let no_pen: HashMap<(u32, u32), f64> = HashMap::new();
    let dist_cap = (MAX_LEN_CHORD * p.chord + 40.0).max(p.chord * 2.5 + 5.0);
    let time_cap = dist_cap / 40.0;
    let accept = |c: Cand, cands: &mut Vec<Cand>, sets: &mut Vec<Shape>| {
        if c.km > dist_cap {
            return;
        }
        let kmin = cands.iter().map(|k| k.km).fold(c.km, f64::min);
        if c.km > MAX_LEN_SHORTEST * kmin + 30.0 {
            return;
        }
        // distinct = a real share of the new path runs away from every
        // existing corridor
        let sh = Shape::of(g, &c);
        if sets.iter().all(|s| sh.covered_by(s) < DISTINCT_OVERLAP) {
            cands.push(c);
            sets.push(sh);
        }
    };
    // fastest per class group present on the pair, then shortest
    let mut metrics: Vec<(String, Metric)> = Vec::new();
    let mut seen_caps: HashSet<(u64, u64)> = HashSet::new();
    for (c, name) in CLASS_NAMES.iter().enumerate() {
        if p.class_mask & (1 << c) == 0 {
            continue;
        }
        let m = model::class_metric(c);
        if let Metric::Time { cap, hsr_mult } = m {
            if seen_caps.insert((cap.to_bits(), hsr_mult.to_bits())) {
                metrics.push((format!("fast-{name}"), m));
            }
        }
    }
    metrics.push(("shortest".into(), Metric::Distance));
    for (name, m) in &metrics {
        let cap = if matches!(m, Metric::Distance) {
            dist_cap
        } else {
            time_cap
        };
        if let Some((_, path)) = route(g, buf, sa, sb, p.pb, *m, &no_pen, cap) {
            accept(Cand::measure(g, path, name), &mut cands, &mut sets);
        }
    }
    // penalty-diversified alternatives under the dominant class's metric
    let dm = model::class_metric(p.dominant);
    let mut pen: HashMap<(u32, u32), f64> = HashMap::new();
    for r in 0..PENALTY_ROUNDS {
        if cands.is_empty() {
            break;
        }
        // penalise every edge within 150 m of a found corridor (both
        // tracks of double-track lines, station loops), not just its own
        for s in &sets {
            for &p in s.samples() {
                for u in fine.near(g, p, 0.15) {
                    for e in &g.adj[u as usize] {
                        pen.insert((u.min(e.to), u.max(e.to)), PENALTY_MULT);
                    }
                }
            }
        }
        let before = cands.len();
        if let Some((_, path)) = route(g, buf, sa, sb, p.pb, dm, &pen, time_cap * 2.0) {
            accept(
                Cand::measure(g, path, &format!("alt-{}", r + 1)),
                &mut cands,
                &mut sets,
            );
        }
        if cands.len() == before {
            break;
        }
    }
    // the production geometry
    if let Some((_, segs)) = base {
        let mut nodes: Vec<u32> = Vec::new();
        let mut ok = !segs.is_empty();
        for s in segs {
            for id in s {
                match g.index_of(*id) {
                    Some(i) => {
                        if nodes.last() != Some(&i) {
                            nodes.push(i)
                        }
                    }
                    None => ok = false,
                }
            }
        }
        if ok && nodes.len() >= 2 {
            let mut bc = Cand::measure(g, nodes, "production");
            bc.is_base = true;
            let sh = Shape::of(g, &bc);
            let same = sets.iter().position(|s| {
                bc.gap_km == 0.0
                    && sh.covered_by(s) >= BASE_SAME_OVERLAP
                    && s.covered_by(&sh) >= BASE_SAME_OVERLAP
            });
            match same {
                Some(i) => {
                    // keep production's exact geometry for that corridor
                    cands[i] = bc;
                    sets[i] = sh;
                }
                None => {
                    cands.push(bc);
                    sets.push(sh);
                }
            }
        }
    }
    cands
}

/// The bridge to draw among `(gap, total, a-node, b-node)` candidates: the
/// smallest gap, or any within 50 m of it; those compete on total length,
/// then node ids. Depends on the set only, never on its order.
fn pick_bridge(found: Vec<(f64, f64, u32, u32)>) -> Option<(u32, u32)> {
    let gmin = found.iter().map(|c| c.0).fold(f64::INFINITY, f64::min);
    found
        .into_iter()
        .filter(|c| c.0 <= gmin + 0.05)
        .min_by(|a, b| a.1.total_cmp(&b.1).then(a.2.cmp(&b.2)).then(a.3.cmp(&b.3)))
        .map(|c| (c.2, c.3))
}

/// Smallest-gap bridge between the two stations' track networks: the
/// connection must start at a dangling track end on one side, and the
/// bridged length must pass production's audits. Among plausible
/// connections the smallest gap wins; connections within 50 m of that gap
/// compete on total length, then on node ids, so the winner depends on the
/// candidate set only, never on iteration order.
fn min_gap_bridge(g: &Graph, p: &PairInfo, sa: &Snap, sb: &Snap) -> Option<Cand> {
    let radius = (p.chord * 1.2 + 15.0).min(130.0);
    let ta = graph::reach(g, sa, radius);
    let tb = graph::reach(g, sb, radius);
    let grid_of = |t: &HashMap<u32, (f64, u32)>| {
        let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for &v in t.keys() {
            let c = g.coords[v as usize];
            grid.entry(((c[0] * 20.0) as i32, (c[1] * 20.0) as i32))
                .or_default()
                .push(v);
        }
        grid
    };
    let (ga, gb) = (grid_of(&ta), grid_of(&tb));
    let speed_ok = |total: f64| match p.min_minutes {
        Some(m) if m > 0.0 => total / (m / 60.0) <= BRIDGE_MAX_KMH,
        _ => true,
    };
    // (gap, total, a-node, b-node) of every plausible connection
    let mut found: Vec<(f64, f64, u32, u32)> = Vec::new();
    let scan = |from: &HashMap<u32, (f64, u32)>,
                other: &HashMap<u32, (f64, u32)>,
                grid: &HashMap<(i32, i32), Vec<u32>>,
                a_side: bool,
                dangling_only: bool,
                found: &mut Vec<(f64, f64, u32, u32)>| {
        for (&u, &(du, _)) in from {
            if dangling_only && g.degree[u as usize] != 1 {
                continue;
            }
            if !dangling_only && du > 4.0 {
                continue;
            }
            let cu = g.coords[u as usize];
            let (cx, cy) = ((cu[0] * 20.0) as i32, (cu[1] * 20.0) as i32);
            for dx in -2..=2 {
                for dy in -2..=2 {
                    for &v in grid.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                        let gap = hav(cu, g.coords[v as usize]);
                        if gap > BRIDGE_MAX_GAP_KM || gap < 0.001 {
                            continue;
                        }
                        let total = du + gap + other[&v].0;
                        let ratio = total / p.chord;
                        if ratio < BRIDGE_RATIO.0 || ratio > BRIDGE_RATIO.1 || !speed_ok(total) {
                            continue;
                        }
                        found.push(if a_side {
                            (gap, total, u, v)
                        } else {
                            (gap, total, v, u)
                        });
                    }
                }
            }
        }
    };
    scan(&ta, &tb, &gb, true, true, &mut found);
    scan(&tb, &ta, &ga, false, true, &mut found);
    if found.is_empty() {
        scan(&ta, &tb, &gb, true, false, &mut found);
        scan(&tb, &ta, &ga, false, false, &mut found);
    }
    let (u, v) = pick_bridge(found)?;
    let mut nodes = graph::reach_path(&ta, u);
    let mut tail = graph::reach_path(&tb, v);
    tail.reverse();
    nodes.extend(tail);
    Some(Cand::measure(g, nodes, "min-gap-bridge"))
}

/// Minimum distance (km) from a point to a candidate's nodes.
fn dist_to_path(g: &Graph, k: &Cand, pt: [f64; 2]) -> f64 {
    k.nodes
        .iter()
        .map(|&n| hav(pt, g.coords[n as usize]))
        .fold(f64::INFINITY, f64::min)
}

/// Redraw a chosen corridor for the map: between the same end nodes
/// (per segment, for bridged paths), stay within 200 m of the corridor
/// and follow the track that carries the most production train-legs,
/// so a re-routed train joins the line already drawn instead of
/// creating a parallel one on the other track of a double-track line.
fn redraw(
    g: &Graph,
    fine: &FineIndex,
    buf: &mut Buffers,
    k: &Cand,
    usage: &HashMap<(u32, u32), u32>,
) -> Cand {
    let shape = Shape::of(g, k);
    let mut allowed: HashSet<(u32, u32)> = HashSet::new();
    for &p in shape.samples() {
        for u in fine.near(g, p, REDRAW_BUFFER_KM) {
            for e in &g.adj[u as usize] {
                allowed.insert((u.min(e.to), u.max(e.to)));
            }
        }
    }
    // also every edge of the path itself (samples are 0.3 km apart)
    for w in k.nodes.windows(2) {
        allowed.insert((w[0].min(w[1]), w[0].max(w[1])));
    }
    let cost = |u: u32, e: &graph::Edge| -> f64 {
        let key = (u.min(e.to), u.max(e.to));
        let base = e.km as f64;
        if !allowed.contains(&key) {
            return base * 50.0;
        }
        match usage.get(&key) {
            Some(&n) => base / (1.0 + n as f64).sqrt(),
            None => base,
        }
    };
    let mut cuts: Vec<usize> = vec![0];
    for &i in &k.gaps_at {
        cuts.push(i);
        cuts.push(i + 1);
    }
    cuts.push(k.nodes.len() - 1);
    let mut nodes: Vec<u32> = Vec::new();
    for seg in cuts.chunks(2) {
        let (a, b) = (k.nodes[seg[0]], k.nodes[seg[1]]);
        let part = if a == b {
            vec![a]
        } else {
            route_custom(g, buf, a, b, cost, Some(fine), k.km * 60.0)
                .unwrap_or_else(|| k.nodes[seg[0]..=seg[1]].to_vec())
        };
        nodes.extend(part);
    }
    let mut out = Cand::measure(g, nodes, &k.source);
    out.is_base = k.is_base;
    out
}

/// Train-legs per undirected edge over weighted paths.
fn edge_usage<'a>(paths: impl Iterator<Item = (&'a Cand, u32)>) -> HashMap<(u32, u32), u32> {
    let mut usage: HashMap<(u32, u32), u32> = HashMap::new();
    for (k, n) in paths {
        for w in k.nodes.windows(2) {
            *usage.entry((w[0].min(w[1]), w[0].max(w[1]))).or_default() += n;
        }
    }
    usage
}

/// OSM node-id segments for the atlas. A real gap (unmapped track)
/// splits the path; a parallel-track hop (<= HOP_KM) does not, so a
/// redrawn path stays one continuous line.
fn osm_segments(g: &Graph, k: &Cand) -> Vec<Vec<u64>> {
    let mut segs: Vec<Vec<u64>> = vec![Vec::new()];
    for (i, &n) in k.nodes.iter().enumerate() {
        segs.last_mut().unwrap().push(g.ids[n as usize]);
        if k.gaps_at.contains(&i) {
            let jump = hav(g.coords[n as usize], g.coords[k.nodes[i + 1] as usize]);
            if jump > graph::HOP_KM + 1e-9 {
                segs.push(Vec::new());
            }
        }
    }
    segs.retain(|s| s.len() >= 2);
    segs
}

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn main() {
    let mut timer = Timer::new();
    let project = PathBuf::from(argval("--project").unwrap_or_else(|| ".".into()));
    let data = argval("--data").map(PathBuf::from).unwrap_or_else(|| {
        if let Ok(d) = std::env::var("CRFM_DATA_DIR") {
            PathBuf::from(d)
        } else if PathBuf::from("data").exists() {
            PathBuf::from("data")
        } else {
            PathBuf::from("../data")
        }
    });
    let files = argval("--files").map(PathBuf::from).unwrap_or_else(|| {
        if let Ok(d) = std::env::var("CRFM_OUTPUT_DIR") {
            PathBuf::from(d)
        } else if PathBuf::from("output").exists() {
            PathBuf::from("output")
        } else {
            PathBuf::from("../output")
        }
    });
    let out = PathBuf::from(argval("--out").unwrap_or_else(|| "out".into()));
    fs::create_dir_all(&out).unwrap();
    if let Some(n) = argval("--threads").and_then(|s| s.parse().ok()) {
        rayon::ThreadPoolBuilder::new()
            .num_threads(n)
            .build_global()
            .unwrap();
    }
    let trains: Vec<Train> = inputs::load_trains(&[
        &files.join("china-rail-timetables-2026-10-21.json"),
        &files.join("china-rail-intercity-2026-10-28.json"),
    ]);
    let prod_pairs = inputs::load_pairs(&[
        &data.join("derived/pair_distances.json"),
        &data.join("derived/cs_out/pair_distances.json"),
    ]);
    let base_paths = inputs::load_base_paths(&[
        &data.join("derived/pair_paths.json"),
        &data.join("derived/cs_out/pair_paths.json"),
    ]);
    // --station-fixes (station_resolution format) is applied last, so it
    // replaces the analyzer's chosen clusters for the names it lists.
    let station_fixes = argval("--station-fixes").map(PathBuf::from);
    let mut resolutions = vec![
        data.join("station_resolution.json"),
        data.join("derived/cs_out/station_resolution.json"),
    ];
    resolutions.extend(station_fixes);
    let station_pts = inputs::load_station_points(
        &data.join("osm_stations.json"),
        &resolutions.iter().map(|p| p.as_path()).collect::<Vec<_>>(),
    );
    timer.mark(&format!(
        "inputs: {} trains, {} production pairs, {} base paths, {} station names",
        trains.len(),
        prod_pairs.len(),
        base_paths.len(),
        station_pts.len()
    ));

    let osm_path = argval("--osm").map(PathBuf::from).unwrap_or_else(|| {
        if data.join("osm/china-rail.osm").exists() {
            data.join("osm/china-rail.osm")
        } else {
            project.join("china-rail.osm")
        }
    });
    let mut g = graph::build(&osm_path);
    let prod_segs: Vec<&Vec<u64>> = base_paths.values().flat_map(|(_, s)| s.iter()).collect();
    let n_prod = g.mark_prod(&prod_segs);
    drop(prod_segs);
    println!("production track edges preferred on double track: {n_prod}");
    let g = g;
    let snapper = SnapIndex::new(&g);
    let fine = FineIndex::new(&g);
    timer.mark("graph");

    // ---- legs ----
    let mut legs: Vec<Leg> = Vec::new();
    for (ti, t) in trains.iter().enumerate() {
        let c = class_index(&t.class);
        for j in 0..t.stops.len().saturating_sub(1) {
            let (a, b) = (&t.stops[j].name, &t.stops[j + 1].name);
            if a == b {
                continue;
            }
            let forward = a < b;
            let key = if forward {
                (a.clone(), b.clone())
            } else {
                (b.clone(), a.clone())
            };
            legs.push(Leg {
                train: ti,
                j,
                key,
                forward,
                class: c,
                minutes: travel_time(&t.stops, j, j + 1)
                    .filter(|m| *m > 0)
                    .map(|m| m as f64),
            });
        }
    }
    let only_pair: Option<Key> = argval("--pair").map(|s| {
        let mut it = s.split(',').map(clean);
        let (a, b) = (it.next().unwrap(), it.next().unwrap());
        if a < b {
            (a, b)
        } else {
            (b, a)
        }
    });

    // ---- pairs ----
    let mut pair_legs: HashMap<Key, Vec<usize>> = HashMap::new();
    for (i, l) in legs.iter().enumerate() {
        pair_legs.entry(l.key.clone()).or_default().push(i);
    }
    let mut keys: Vec<Key> = pair_legs.keys().cloned().collect();
    keys.sort();
    if let Some(k) = &only_pair {
        keys.retain(|x| x == k);
    }
    if let Some(n) = argval("--limit").and_then(|s| s.parse::<usize>().ok()) {
        keys.truncate(n);
    }
    let snaps_ok = |pt: [f64; 2]| !snapper.snap(&g, pt).is_empty();
    let mut dup_pairs = 0usize;
    let mut pairs: Vec<PairInfo> = Vec::new();
    for key in &keys {
        let recs = prod_pairs.get(key);
        let chords: Vec<f64> = recs
            .map(|r| r.iter().map(|x| x.chord).collect())
            .unwrap_or_default();
        if chords.iter().any(|c| (c - chords[0]).abs() > 1.0) {
            dup_pairs += 1; // the names denote two different station pairs
            continue;
        }
        let (Some(pa), Some(pb)) = (station_pts.get(&key.0), station_pts.get(&key.1)) else {
            continue;
        };
        let Some((pa, pb)) = pick_points(pa, pb, chords.first().copied(), &snaps_ok) else {
            continue;
        };
        let mut mask = 0u32;
        let mut count = [0usize; NCLASS];
        let mut min_m: Option<f64> = None;
        for &li in &pair_legs[key] {
            mask |= 1 << legs[li].class;
            count[legs[li].class] += 1;
            if let Some(m) = legs[li].minutes {
                min_m = Some(min_m.map_or(m, |x: f64| x.min(m)));
            }
        }
        let dominant = (0..NCLASS).max_by_key(|&c| count[c]).unwrap();
        let rec = recs.and_then(|r| r.first());
        pairs.push(PairInfo {
            key: key.clone(),
            pa,
            pb,
            chord: hav(pa, pb).max(0.5),
            prod_status: rec.map(|r| r.status.clone()).unwrap_or_default(),
            prod_gap: rec.and_then(|r| r.gap),
            prod_track: rec.and_then(|r| r.track),
            class_mask: mask,
            dominant,
            min_minutes: min_m,
        });
    }
    timer.mark(&format!(
        "legs: {} legs, {} pairs to route ({} duplicate-name pairs left on production)",
        legs.len(),
        pairs.len(),
        dup_pairs
    ));

    // ---- candidates (parallel) ----
    let snaps: Vec<(Snap, Snap)> = pairs
        .par_iter()
        .map(|p| (snapper.snap(&g, p.pa), snapper.snap(&g, p.pb)))
        .collect();
    let mut cands: Vec<Vec<Cand>> = pairs
        .par_iter()
        .zip(snaps.par_iter())
        .map_init(
            || Buffers::new(g.coords.len()),
            |buf, (p, (sa, sb))| {
                if sa.is_empty() || sb.is_empty() {
                    return Vec::new();
                }
                gen_candidates(&g, &fine, buf, p, sa, sb, base_paths.get(&p.key))
            },
        )
        .collect();
    let ncand: usize = cands.iter().map(|c| c.len()).sum();
    timer.mark(&format!("candidates: {ncand} over {} pairs", pairs.len()));

    // ---- calibration on undisputed legs ----
    let pair_idx: HashMap<&Key, usize> =
        pairs.iter().enumerate().map(|(i, p)| (&p.key, i)).collect();
    let calib_samples: Vec<(usize, f64)> = legs
        .iter()
        .filter_map(|l| {
            let m = l.minutes?;
            let pi = *pair_idx.get(&l.key)?;
            let preds: Vec<f64> = cands[pi]
                .iter()
                .filter(|k| k.gap_km == 0.0)
                .filter_map(|k| k.predict(l.class))
                .collect();
            if preds.is_empty() {
                return None;
            }
            let lo = preds.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = preds.iter().copied().fold(0.0, f64::max);
            (hi / lo <= UNDISPUTED_SPREAD).then(|| (l.class, (m / lo).ln()))
        })
        .collect();
    let cal = Calibration::fit(&calib_samples);
    timer.mark(&format!(
        "calibration: {} undisputed legs",
        calib_samples.len()
    ));
    for (c, name) in CLASS_NAMES.iter().enumerate() {
        println!(
            "  {:>2}: n={:>6}  scheduled/model median {:.3}  p5 {:.3}  p95 {:.3}  floor {:.3}",
            name,
            cal.n[c],
            cal.median[c].exp(),
            cal.q05[c].exp(),
            cal.q95[c].exp(),
            cal.x_min[c].exp()
        );
    }

    // ---- min-gap bridging: production-bridged pairs, and pairs where
    // some leg fits no candidate ----
    let needs_bridge: Vec<usize> = (0..pairs.len())
        .filter(|&pi| {
            if snaps[pi].0.is_empty() || snaps[pi].1.is_empty() {
                return false;
            }
            if pairs[pi].prod_status == "bridged" || cands[pi].is_empty() {
                return true;
            }
            pair_legs[&pairs[pi].key].iter().any(|&li| {
                let l = &legs[li];
                l.minutes.is_some_and(|m| {
                    cands[pi].iter().all(|k| {
                        k.predict(l.class)
                            .is_none_or(|p| !cal.is_feasible(l.class, (m / p).ln()))
                    })
                })
            })
        })
        .collect();
    let bridges: Vec<(usize, Option<Cand>)> = needs_bridge
        .par_iter()
        .map(|&pi| {
            (
                pi,
                min_gap_bridge(&g, &pairs[pi], &snaps[pi].0, &snaps[pi].1),
            )
        })
        .collect();
    let mut bridge_rows: Vec<Value> = Vec::new();
    for (pi, b) in bridges {
        let p = &pairs[pi];
        if let Some(b) = &b {
            bridge_rows.push(json!({
                "from": p.key.0, "to": p.key.1, "chord_km": r1(p.chord),
                "prod_status": p.prod_status, "prod_gap_km": p.prod_gap, "prod_track_km": p.prod_track,
                "new_gap_km": (b.gap_km * 1000.0).round() / 1000.0, "new_total_km": r1(b.km),
            }));
        }
        if let Some(b) = b {
            cands[pi].push(b);
        }
    }
    timer.mark(&format!(
        "bridging: {} pairs searched, {} bridged",
        needs_bridge.len(),
        bridge_rows.len()
    ));

    // ---- demonstrated corridors: stopping services between a pair's
    // two stations (up to 6 intermediate stops), per routing group, and
    // which candidates their intermediate stops all lie on ----
    let shapes: Vec<Vec<Shape>> = cands
        .par_iter()
        .map(|cs| cs.iter().map(|k| Shape::of(&g, k)).collect())
        .collect();
    let svc = service_counts(&trains, &pairs, &cands, &shapes, &pair_idx, &station_pts);
    let n_svc: u32 = svc.iter().map(|x| x.1.iter().sum::<u32>()).sum();
    timer.mark(&format!("service evidence: {n_svc} stopping-service spans"));

    // ---- per-train inference (parallel over trains) ----
    let mut train_legs: Vec<Vec<usize>> = vec![Vec::new(); trains.len()];
    for (i, l) in legs.iter().enumerate() {
        train_legs[l.train].push(i);
    }
    struct Decision {
        leg: usize,
        chosen: Option<usize>,
        base: Option<usize>,
        post: Vec<f64>,
        decision: &'static str,
    }
    let decisions: Vec<Decision> = train_legs
        .par_iter()
        .flat_map_iter(|tl| {
            let mut out: Vec<Decision> = Vec::new();
            // split into chains of consecutive legs that have candidates
            let mut chain: Vec<usize> = Vec::new();
            let flush = |chain: &mut Vec<usize>, out: &mut Vec<Decision>| {
                if chain.is_empty() {
                    return;
                }
                let obs: Vec<LegObs> = chain
                    .iter()
                    .map(|&li| {
                        let l = &legs[li];
                        let pc = &cands[pair_idx[&l.key]];
                        let pi = pair_idx[&l.key];
                        let gidx = model::class_group(l.class);
                        let compat: Vec<u32> = svc[pi].0.iter().map(|x| x[gidx]).collect();
                        let sp = model::service_logprior(&compat, svc[pi].1[gidx]);
                        let emit = match l.minutes {
                            Some(m) => model::emissions(&cal, pc, l.class, m),
                            None => {
                                let kmin = pc.iter().map(|k| k.km).fold(f64::INFINITY, f64::min);
                                pc.iter()
                                    .map(|k| -model::params().length_prior * (k.km / kmin).ln())
                                    .collect()
                            }
                        };
                        let emit: Vec<f64> = emit.iter().zip(&sp).map(|(e, p)| e + p).collect();
                        let t = &trains[l.train];
                        LegObs {
                            cands: pc,
                            forward: l.forward,
                            emit,
                            dwell_end: dwell(&t.stops, l.j + 1),
                        }
                    })
                    .collect();
                let posts = model::posteriors(&obs);
                for (k, &li) in chain.iter().enumerate() {
                    let pc = obs[k].cands;
                    let post = posts[k].clone();
                    let emit = obs[k].emit.clone();
                    let best = (0..post.len()).max_by(|&a, &b| post[a].total_cmp(&post[b]));
                    let base = pc.iter().position(|c| c.is_base);
                    let feasible = |i: usize| emit[i] > -29.0;
                    let any_feasible = (0..pc.len()).any(feasible);
                    let bridge_fix = base.and_then(|bi| {
                        let bg = pc[bi].gap_km;
                        if bg <= 0.0 {
                            return None;
                        }
                        (0..pc.len())
                            .filter(|&i| {
                                feasible(i)
                                    && (pc[i].gap_km < bg - BRIDGE_GAP_GAIN_KM
                                        || (pc[i].gap_km == 0.0 && bg > 0.0))
                            })
                            .min_by(|&a, &b| {
                                pc[a]
                                    .gap_km
                                    .total_cmp(&pc[b].gap_km)
                                    .then_with(|| post[b].total_cmp(&post[a]))
                            })
                    });
                    let (chosen, decision) = match (best, base) {
                        (None, _) => (None, "no-candidates"),
                        (Some(_), _) if !any_feasible => (base, "infeasible-keep"),
                        (Some(b), Some(bi)) => {
                            if b != bi
                                && post[b] >= model::params().switch_post
                                && post[bi] <= model::params().base_max
                            {
                                (Some(b), "switched")
                            } else if let Some(fx) = bridge_fix {
                                (Some(fx), "bridge-fix")
                            } else if b != bi {
                                (Some(bi), "ambiguous-keep")
                            } else {
                                (Some(bi), "production")
                            }
                        }
                        (Some(b), None) => {
                            let fill_ok = feasible(b)
                                && (post[b] >= model::params().fill_post
                                    || (pc[b].gap_km < 1.0 && post[b] >= 0.35));
                            if fill_ok {
                                (Some(b), "filled")
                            } else {
                                (None, "chord")
                            }
                        }
                    };
                    out.push(Decision {
                        leg: li,
                        chosen,
                        base,
                        post,
                        decision,
                    });
                }
                chain.clear();
            };
            for &li in tl {
                let has = pair_idx
                    .get(&legs[li].key)
                    .is_some_and(|&pi| !cands[pi].is_empty());
                let contiguous = chain
                    .last()
                    .is_none_or(|&prev| legs[prev].j + 1 == legs[li].j);
                if !has || !contiguous {
                    flush(&mut chain, &mut out);
                }
                if has {
                    chain.push(li);
                } else {
                    out.push(Decision {
                        leg: li,
                        chosen: None,
                        base: None,
                        post: Vec::new(),
                        decision: if pair_idx.contains_key(&legs[li].key) {
                            "no-candidates"
                        } else {
                            "not-routed"
                        },
                    });
                }
            }
            flush(&mut chain, &mut out);
            out.into_iter()
        })
        .collect();
    timer.mark(&format!("inference: {} legs", decisions.len()));

    // ---- double track as one corridor, for the map: every production
    // pair path is redrawn within 200 m of itself onto the busiest track
    // (two rounds, so "busiest" is judged on already-merged usage), then
    // every chosen non-production corridor is redrawn the same way ----
    let weight = |pi: usize| pair_legs[&pairs[pi].key].len() as u32;
    let best_for_canon = |pi: usize| -> Option<&Cand> {
        cands[pi]
            .iter()
            .filter(|c| c.gap_km == 0.0)
            .min_by(|a, b| a.km.total_cmp(&b.km))
            .or_else(|| cands[pi].iter().find(|c| c.is_base))
    };
    let mut usage = edge_usage(
        cands
            .iter()
            .enumerate()
            .filter_map(|(pi, _)| best_for_canon(pi).map(|b| (b, weight(pi)))),
    );
    let mut canon: Vec<Option<Cand>> = vec![None; cands.len()];
    for _round in 0..REDRAW_ROUNDS {
        canon = (0..cands.len())
            .into_par_iter()
            .map_init(
                || Buffers::new(g.coords.len()),
                |buf, pi| best_for_canon(pi).map(|b| redraw(&g, &fine, buf, b, &usage)),
            )
            .collect();
        usage = edge_usage(
            canon
                .iter()
                .enumerate()
                .filter_map(|(pi, c)| c.as_ref().map(|c| (c, weight(pi)))),
        );
    }
    timer.mark(&format!(
        "canonical production geometry: {} pairs",
        canon.iter().filter(|c| c.is_some()).count()
    ));
    let mut todo: Vec<(usize, usize)> = decisions
        .iter()
        .filter(|d| matches!(d.decision, "switched" | "filled" | "bridge-fix"))
        .map(|d| (pair_idx[&legs[d.leg].key], d.chosen.unwrap()))
        .collect();
    todo.sort_unstable();
    todo.dedup();
    let drawn: HashMap<(usize, usize), Cand> = todo
        .par_iter()
        .map_init(
            || Buffers::new(g.coords.len()),
            |buf, &(pi, k)| ((pi, k), redraw(&g, &fine, buf, &cands[pi][k], &usage)),
        )
        .collect();
    timer.mark(&format!("map redraw: {} chosen corridors", drawn.len()));

    // ---- outputs ----
    let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
    let mut leg_rows: Vec<String> = Vec::with_capacity(decisions.len());
    let mut leg_paths: Vec<Value> = Vec::new();
    let mut trains_changed: HashSet<usize> = HashSet::new();
    for d in &decisions {
        *counts.entry(d.decision).or_default() += 1;
        let l = &legs[d.leg];
        let t = &trains[l.train];
        let pi = pair_idx.get(&l.key).copied();
        let (from, to) = (&t.stops[l.j].name, &t.stops[l.j + 1].name);
        let kdesc = |i: Option<usize>| -> Value {
            match (i, pi) {
                (Some(i), Some(pi)) => {
                    let k = &cands[pi][i];
                    json!({
                        "cand": i, "source": k.source, "km": r1(k.km),
                        "pred_min": k.predict(l.class).map(r1),
                        "post": d.post.get(i).map(|p| (p * 1000.0).round() / 1000.0),
                        "lines": k.lines.iter().map(|x| &x.0).collect::<Vec<_>>(),
                    })
                }
                _ => Value::Null,
            }
        };
        leg_rows.push(
            json!({
                "train_no": t.train_no, "code": t.code, "class": t.class,
                "from": from, "to": to, "minutes": l.minutes,
                "decision": d.decision, "chosen": kdesc(d.chosen), "production": kdesc(d.base),
            })
            .to_string(),
        );
        if matches!(d.decision, "switched" | "filled" | "bridge-fix") {
            let (pi, k) = (pi.unwrap(), d.chosen.unwrap());
            trains_changed.insert(l.train);
            leg_paths.push(json!({
                "train_no": t.train_no, "code": t.code, "from": from, "to": to,
                "id": format!("#cv3:{pi}:{k}"), "km": r1(cands[pi][k].km),
                "decision": d.decision,
                "segments": osm_segments(&g, &drawn[&(pi, k)]),
            }));
        }
    }
    fs::write(out.join("leg_routes.jsonl"), leg_rows.join("\n") + "\n").unwrap();
    fs::write(
        out.join("leg_paths.json"),
        serde_json::to_string(&leg_paths).unwrap(),
    )
    .unwrap();
    let mut all_keys: HashSet<&Key> = base_paths.keys().collect();
    for key in pair_idx.keys() {
        if canon[pair_idx[key]].is_some() {
            all_keys.insert(key);
        }
    }
    let mut pp_keys: Vec<&Key> = all_keys.into_iter().collect();
    pp_keys.sort();
    let pp_rows: Vec<Value> = pp_keys
        .into_iter()
        .map(|key| {
            let base_info = base_paths.get(key);
            let status = base_info.map(|(s, _)| s.as_str()).unwrap_or("ok");
            let segs = base_info.map(|(_, s)| s.clone()).unwrap_or_default();
            let segments = match pair_idx.get(key).and_then(|&pi| canon[pi].as_ref()) {
                Some(c) => osm_segments(&g, c),
                None => segs,
            };
            json!({"from": key.0, "to": key.1, "status": status, "segments": segments})
        })
        .collect();
    fs::write(
        out.join("pair_paths_canonical.json"),
        json!({
            "about": "Production pair geometry with double track merged: each pair path redrawn within 200 m of itself onto the track carrying the most train-legs (corridor-v3 staging). For atlas.rs via ATLAS_PAIR_PATHS.",
            "pairs": pp_rows,
        })
        .to_string(),
    )
    .unwrap();
    let cand_rows: Vec<Value> = pairs
        .iter()
        .zip(&cands)
        .map(|(p, cs)| {
            json!({
                "from": p.key.0, "to": p.key.1, "chord_km": r1(p.chord),
                "prod_status": p.prod_status, "prod_track_km": p.prod_track,
                "cands": cs.iter().map(|k| json!({
                    "source": k.source, "km": r1(k.km), "gap_km": r1(k.gap_km),
                    "hsr_km": r1(k.hsr_km), "production": k.is_base,
                    "lines": k.lines.iter().map(|x| json!([x.0, r1(x.1)])).collect::<Vec<_>>(),
                    "pred_min": (0..NCLASS).map(|c| k.predict(c).map(r1)).collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    fs::write(
        out.join("candidates.json"),
        serde_json::to_string(&cand_rows).unwrap(),
    )
    .unwrap();
    fs::write(
        out.join("bridges.json"),
        serde_json::to_string_pretty(&bridge_rows).unwrap(),
    )
    .unwrap();
    timer.mark("outputs");

    // ---- self-check on stopping trains ----
    let validation = validate(
        &g,
        &trains,
        &pairs,
        &cands,
        &shapes,
        &svc,
        &out,
        &pair_idx,
        &cal,
        &station_pts,
    );
    timer.mark("validation");

    let summary = json!({
        "decisions": counts,
        "trains_with_changed_legs": trains_changed.len(),
        "leg_paths": leg_paths.len(),
        "calibration": (0..NCLASS).map(|c| json!({
            "class": CLASS_NAMES[c], "n": cal.n[c],
            "median_ratio": (cal.median[c].exp() * 1000.0).round() / 1000.0,
            "p5": (cal.q05[c].exp() * 1000.0).round() / 1000.0,
            "p95": (cal.q95[c].exp() * 1000.0).round() / 1000.0,
            "feasibility_floor": (cal.x_min[c].exp() * 1000.0).round() / 1000.0,
        })).collect::<Vec<_>>(),
        "validation": validation,
        "timings_s": timer.marks.iter().map(|(k, s)| json!([k, (s * 100.0).round() / 100.0])).collect::<Vec<_>>(),
        "total_s": (timer.t0.elapsed().as_secs_f64() * 100.0).round() / 100.0,
    });
    fs::write(
        out.join("summary.json"),
        serde_json::to_string_pretty(&summary).unwrap(),
    )
    .unwrap();
    println!("decisions: {counts:?}");
    println!(
        "trains with >=1 changed leg: {}; leg paths written: {}",
        trains_changed.len(),
        leg_paths.len()
    );
    println!("validation: {validation}");
    println!("TOTAL {:.2}s", timer.t0.elapsed().as_secs_f64());
}

/// Per pair: per-candidate counts of compatible stopping services and
/// the number of services, each by routing group.
type SvcCounts = (Vec<[u32; model::NGROUP]>, [u32; model::NGROUP]);

/// A stop lies on a corridor when within this distance of its path.
const SVC_STOP_KM: f64 = 1.0;
const SVC_MAX_INTERMEDIATE: usize = 6;

/// The station point of `name` best placed between `pa` and `pb`.
fn stop_point(
    station_pts: &HashMap<String, Vec<[f64; 2]>>,
    name: &str,
    pa: [f64; 2],
    pb: [f64; 2],
) -> Option<[f64; 2]> {
    station_pts.get(name).and_then(|v| {
        v.iter()
            .copied()
            .min_by(|x, y| (hav(*x, pa) + hav(*x, pb)).total_cmp(&(hav(*y, pa) + hav(*y, pb))))
    })
}

fn service_counts(
    trains: &[Train],
    pairs: &[PairInfo],
    cands: &[Vec<Cand>],
    shapes: &[Vec<Shape>],
    pair_idx: &HashMap<&Key, usize>,
    station_pts: &HashMap<String, Vec<[f64; 2]>>,
) -> Vec<SvcCounts> {
    let spans: Vec<(usize, usize, Vec<bool>)> = trains
        .par_iter()
        .flat_map_iter(|t| {
            let gidx = model::class_group(class_index(&t.class));
            let names: Vec<&String> = t.stops.iter().map(|s| &s.name).collect();
            let mut out = Vec::new();
            for i in 0..names.len() {
                let hi = (i + SVC_MAX_INTERMEDIATE + 2).min(names.len());
                for j in i + 2..hi {
                    let (a, c) = (names[i], names[j]);
                    if a == c {
                        continue;
                    }
                    let key = if a < c {
                        (a.clone(), c.clone())
                    } else {
                        (c.clone(), a.clone())
                    };
                    let Some(&pi) = pair_idx.get(&key) else {
                        continue;
                    };
                    if cands[pi].is_empty() {
                        continue;
                    }
                    let p = &pairs[pi];
                    let pts: Option<Vec<[f64; 2]>> = names[i + 1..j]
                        .iter()
                        .map(|n| stop_point(station_pts, n, p.pa, p.pb))
                        .collect();
                    let Some(pts) = pts else {
                        continue;
                    };
                    let compat: Vec<bool> = shapes[pi]
                        .iter()
                        .map(|s| pts.iter().all(|q| s.near(*q, SVC_STOP_KM)))
                        .collect();
                    if compat.iter().any(|x| *x) {
                        out.push((pi, gidx, compat));
                    }
                }
            }
            out.into_iter()
        })
        .collect();
    let mut svc: Vec<SvcCounts> = cands
        .iter()
        .map(|cs| (vec![[0u32; model::NGROUP]; cs.len()], [0u32; model::NGROUP]))
        .collect();
    for (pi, gidx, compat) in spans {
        svc[pi].1[gidx] += 1;
        for (k, ok) in compat.iter().enumerate() {
            if *ok {
                svc[pi].0[k][gidx] += 1;
            }
        }
    }
    svc
}

/// Hide an intermediate stop B of a stopping train A->B->C and ask
/// which A-C corridor the train took; the truth is the corridor that
/// passes B. Only tests where some candidate passes B (<= 1 km) and
/// some other misses it by > 5 km count.
#[allow(clippy::too_many_arguments)]
fn validate(
    g: &Graph,
    trains: &[Train],
    pairs: &[PairInfo],
    cands: &[Vec<Cand>],
    shapes: &[Vec<Shape>],
    svc: &[SvcCounts],
    out: &std::path::Path,
    pair_idx: &HashMap<&Key, usize>,
    cal: &Calibration,
    station_pts: &HashMap<String, Vec<[f64; 2]>>,
) -> Value {
    struct T {
        detail: Option<Value>,
        model_ok: bool,
        model_switch: Option<bool>,
        base_ok: Option<bool>,
        short_ok: bool,
        class: usize,
    }
    let tests: Vec<T> = trains
        .par_iter()
        .flat_map_iter(|t| {
            let c = class_index(&t.class);
            let mut out = Vec::new();
            for j in 0..t.stops.len().saturating_sub(2) {
                let (a, b, cc) = (&t.stops[j].name, &t.stops[j + 1].name, &t.stops[j + 2].name);
                if a == b || b == cc || a == cc {
                    continue;
                }
                let key = if a < cc {
                    (a.clone(), cc.clone())
                } else {
                    (cc.clone(), a.clone())
                };
                let Some(&pi) = pair_idx.get(&key) else {
                    continue;
                };
                let pc = &cands[pi];
                if pc.len() < 2 {
                    continue;
                }
                let Some(total) = travel_time(&t.stops, j, j + 2) else {
                    continue;
                };
                let m = total as f64 - dwell(&t.stops, j + 1) as f64 - model::stop_loss_min(c);
                if m <= 0.0 {
                    continue;
                }
                let p = &pairs[pi];
                let Some(bp) = station_pts.get(b).and_then(|v| {
                    v.iter()
                        .copied()
                        .min_by(|x, y| (hav(*x, p.pa) + hav(*x, p.pb)).total_cmp(&(hav(*y, p.pa) + hav(*y, p.pb))))
                }) else {
                    continue;
                };
                let d: Vec<f64> = pc.iter().map(|k| dist_to_path(g, k, bp)).collect();
                let pass: Vec<bool> = d.iter().map(|x| *x <= 1.0).collect();
                if !pass.iter().any(|x| *x) || !d.iter().any(|x| *x > 5.0) {
                    continue;
                }
                // leave-one-out: remove this train's own A-[B]-C span
                let gidx = model::class_group(c);
                let own: Vec<bool> = shapes[pi].iter().map(|s| s.near(bp, SVC_STOP_KM)).collect();
                let counted = own.iter().any(|x| *x);
                let compat: Vec<u32> = svc[pi]
                    .0
                    .iter()
                    .zip(&own)
                    .map(|(x, o)| x[gidx] - u32::from(*o && x[gidx] > 0))
                    .collect();
                let n = svc[pi].1[gidx] - u32::from(counted && svc[pi].1[gidx] > 0);
                let sp = model::service_logprior(&compat, n);
                let emit: Vec<f64> = model::emissions(cal, pc, c, m)
                    .iter()
                    .zip(&sp)
                    .map(|(e, p)| e + p)
                    .collect();
                let z = emit.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let post: Vec<f64> = {
                    let e: Vec<f64> = emit.iter().map(|x| (x - z).exp()).collect();
                    let s: f64 = e.iter().sum();
                    e.iter().map(|x| x / s).collect()
                };
                let best = (0..pc.len()).max_by(|&x, &y| post[x].total_cmp(&post[y])).unwrap();
                let base = pc.iter().position(|k| k.is_base);
                let shortest = (0..pc.len())
                    .min_by(|&x, &y| pc[x].km.total_cmp(&pc[y].km))
                    .unwrap();
                let switch = base.and_then(|bi| {
                    (best != bi && post[best] >= model::params().switch_post && post[bi] <= model::params().base_max)
                        .then_some(pass[best])
                });
                let detail = (switch == Some(false)).then(|| {
                    let kd = |i: usize| {
                        json!({"source": pc[i].source, "km": r1(pc[i].km), "pred": pc[i].predict(c).map(r1),
                               "post": (post[i] * 1000.0).round() / 1000.0, "d_stop_km": r1(d[i]),
                               "lines": pc[i].lines.iter().map(|x| &x.0).collect::<Vec<_>>()})
                    };
                    json!({"code": t.code, "a": a, "hidden_stop": b, "c": cc, "minutes": m,
                           "chosen": kd(best), "production": base.map(kd),
                           "all": (0..pc.len()).map(kd).collect::<Vec<_>>()})
                });
                out.push(T {
                    detail,
                    model_ok: pass[best],
                    model_switch: switch,
                    base_ok: base.map(|bi| pass[bi]),
                    short_ok: pass[shortest],
                    class: c,
                });
            }
            out.into_iter()
        })
        .collect();
    let errs: Vec<String> = tests
        .iter()
        .filter_map(|t| t.detail.as_ref().map(|d| d.to_string()))
        .collect();
    fs::write(
        out.join("validation_wrong_switches.jsonl"),
        errs.join("\n") + "\n",
    )
    .unwrap();
    let n = tests.len() as f64;
    let frac = |f: &dyn Fn(&T) -> bool| {
        (tests.iter().filter(|t| f(t)).count() as f64 / n * 1000.0).round() / 10.0
    };
    let with_base: Vec<&T> = tests.iter().filter(|t| t.base_ok.is_some()).collect();
    let nb = with_base.len() as f64;
    let base_acc = with_base.iter().filter(|t| t.base_ok == Some(true)).count() as f64 / nb;
    // production + decisive switches (what the router would ship)
    let shipped = with_base
        .iter()
        .filter(|t| match t.model_switch {
            Some(ok) => ok,
            None => t.base_ok == Some(true),
        })
        .count() as f64
        / nb;
    let switches: Vec<&&T> = with_base
        .iter()
        .filter(|t| t.model_switch.is_some())
        .collect();
    let switch_ok = switches
        .iter()
        .filter(|t| t.model_switch == Some(true))
        .count();
    let per_class: Vec<Value> = (0..NCLASS)
        .map(|c| {
            let ts: Vec<&T> = tests.iter().filter(|t| t.class == c).collect();
            let k = ts.len().max(1) as f64;
            json!({
                "class": CLASS_NAMES[c], "n": ts.len(),
                "model_pct": (ts.iter().filter(|t| t.model_ok).count() as f64 / k * 1000.0).round() / 10.0,
                "production_pct": (ts.iter().filter(|t| t.base_ok == Some(true)).count() as f64 / k * 1000.0).round() / 10.0,
            })
        })
        .collect();
    json!({
        "tests": tests.len(),
        "model_argmax_pct": frac(&|t| t.model_ok),
        "shortest_pct": frac(&|t| t.short_ok),
        "with_production_geometry": with_base.len(),
        "production_pct": (base_acc * 1000.0).round() / 10.0,
        "production_plus_switches_pct": (shipped * 1000.0).round() / 10.0,
        "switches": switches.len(),
        "switches_correct": switch_ok,
        "per_class": per_class,
    })
}

#[cfg(test)]
mod tests {
    use super::pick_bridge;

    #[test]
    fn bridge_choice_ignores_candidate_order() {
        // gaps 0.010 / 0.040 / 0.045 are within 50 m of the smallest; 0.2 is not
        let c = vec![
            (0.040, 31.0, 7, 9),
            (0.010, 30.0, 5, 8),
            (0.045, 29.0, 4, 6),
            (0.200, 10.0, 1, 2),
            (0.045, 29.0, 3, 6),
        ];
        let want = Some((3, 6)); // shortest total in the 50 m band, then lowest node ids
        let mut rev = c.clone();
        rev.reverse();
        assert_eq!(pick_bridge(c), want);
        assert_eq!(pick_bridge(rev), want);
        assert_eq!(pick_bridge(Vec::new()), None);
    }
}
