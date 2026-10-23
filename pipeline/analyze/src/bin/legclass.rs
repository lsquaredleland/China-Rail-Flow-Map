// legclass — corridor classification for nonstop legs whose scheduled
// time is inconsistent with the geometry the atlas would draw them on.
//
// The atlas routes every leg by the pair's single stored geometry
// (shortest / fastest-chain track path). On parallel corridors that is
// wrong for a minority of trains. This bin finds those legs, scores the
// alternative corridors evidenced by real services between the same
// endpoints, and emits per-train leg overrides (train, from, to,
// via-chain) that atlas.rs / audit.rs consume via ATLAS_OVERRIDES.
//
// Corridor candidates for an ordered pair A->B:
//   * every distinct intermediate-stop chain of a stopping service A->B;
//   * the shortest station-graph tiling A->B that does not use the
//     direct pair edge (Dijkstra over pair track_km);
//   * the shortest tiling avoiding the first tiling's intermediate
//     stations (a second, vertex-disjoint corridor where one exists).
// A candidate must PROGRESS toward B: every intermediate station's
// straight-line distance to B is <= the previous station's (+3 km);
// must not OVERSHOOT: no station's distance from A (or to B) exceeds
// dist(A,B) by more than 12 km, and the chord detour via any station
// is <= 1.45x dist(A,B) + 15 km. These kill phantom tilings that
// backtrack or run past the destination and come back, whose segment
// floors can spuriously fit a merely slow train on the drawn line.
// Candidates whose lengths fall within 4.5% of each other are one
// corridor FAMILY (different tilings of the same physical line); a
// family's predicted nonstop time is its minimum SEGMENT FLOOR over
// its chains, where a chain's segment floor is the sum, over
// consecutive station pairs, of the fastest demonstrated direct-leg
// minutes for that segment. The drawn corridor is the candidate whose
// tiled length matches the pair's stored track_km (within 2.5%); its
// family's floor is the drawn prediction. If no candidate matches,
// the drawn geometry is an unverified A* artifact and its prediction
// falls back to the leave-one-out fastest direct leg.
//
// Flags (per directed nonstop leg A->B, scheduled minutes M):
//   F1  M exceeds the fastest stopping A->B service (any corridor) —
//       a nonstop train slower than a train that stops on the way is
//       not on that stopping train's corridor;
//   F4  the drawn geometry matches no candidate corridor, M is within
//       5 min of the fastest stopping service or faster, and a service
//       family's floor fits M while its length differs from the drawn
//       length by > 5%;
//   F5  M is >= 25 min FASTER than the drawn family's floor (the train
//       outruns the corridor it is drawn on).
// F2 (M >= 1.30x fastest nonstop) and F3 (M >= drawn floor + 25) are
// recorded as observations only: on a single line carrying mixed
// classes they fire for every slow conventional train, which is not
// evidence of a different corridor.
//
// ASSIGN to a non-drawn family only when flagged F1/F4/F5, the
// family's floor error is within tolerance (max(12 min, 12% of M)),
// decisively better than the drawn prediction's error (>= 8 min),
// the implied commercial speed on the family's length is plausible
// (55..=320 km/h), and the family's length differs from the drawn
// length by > 3% (within that band the tilings are the same corridor
// and the difference is tiling noise). A family with no demonstrating
// service chain (pure graph tiling) is assignable only under F1,
// where the flag itself is independent timetable evidence. Trains
// matching no corridor (e.g. deliberately slow overnight services)
// keep their drawn geometry and are reported as ambiguous.
//
// Usage: legclass [--d1 <path>] [--d2 <path>] [--pairs <path>]
//                 [--pairs2 <path>] [--stations <path>]
//                 [--out <path>] [--report <path>] [--dump-pair "A B"]
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::PathBuf;

const FLAG_RATIO: f64 = 1.30;
const FLAG_FLOOR_EXCESS: f64 = 25.0;
const ASSIGN_TOL_MIN: f64 = 12.0;
const ASSIGN_TOL_FRAC: f64 = 0.12;
const MARGIN_MIN: f64 = 8.0;
const DRAWN_MATCH_FRAC: f64 = 0.025;
const PROGRESS_TOL_KM: f64 = 3.0;
const OVERSHOOT_TOL_KM: f64 = 12.0;
const FAMILY_GAP_FRAC: f64 = 0.045;
const SAME_CORRIDOR_FRAC: f64 = 0.03;

fn argval(flag: &str) -> Option<String> {
    let a: Vec<String> = env::args().collect();
    a.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
}

fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn hav_km(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (la1, lo1) = (a[0].to_radians(), a[1].to_radians());
    let (la2, lo2) = (b[0].to_radians(), b[1].to_radians());
    let h = ((la2 - la1) / 2.0).sin().powi(2)
        + la1.cos() * la2.cos() * ((lo2 - lo1) / 2.0).sin().powi(2);
    2.0 * 6371.0 * h.sqrt().asin()
}

#[derive(Deserialize)]
struct Deliverable {
    trains: Vec<Train>,
}
#[derive(Deserialize, Clone)]
struct Train {
    #[serde(default)]
    train_no: String,
    code: String,
    #[serde(rename = "class")]
    train_class: String,
    stops: Vec<Stop>,
}
#[derive(Deserialize, Clone)]
struct Stop {
    name: String,
    arrive: String,
    depart: String,
}
fn mins(s: &str) -> Option<i64> {
    let t = s.trim();
    if t == "----" || t.is_empty() {
        return None;
    }
    let mut it = t.split(':');
    let h: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    Some(h * 60 + m)
}

/// Travel minutes from departing stop `from` to arriving at stop `to`
/// (same whole-day wrap logic as atlas.rs).
#[allow(clippy::needless_range_loop)]
fn travel_time(stops: &[Stop], from: usize, to: usize) -> Option<i64> {
    let start = mins(&stops[from].depart)?;
    let mut clock = start;
    let mut prev_tod = start;
    for j in (from + 1)..=to {
        let arr = match mins(&stops[j].arrive) {
            Some(a) => a,
            None => continue,
        };
        let mut abs = clock - prev_tod + arr;
        while abs < clock {
            abs += 1440;
        }
        clock = abs;
        prev_tod = arr;
        if j == to {
            return Some(clock - start);
        }
        if let Some(dep) = mins(&stops[j].depart) {
            let mut dabs = clock - prev_tod + dep;
            while dabs < clock {
                dabs += 1440;
            }
            clock = dabs;
            prev_tod = dep;
        }
    }
    None
}

#[derive(Deserialize)]
struct PairsFile {
    pairs: Vec<PairDist>,
}
#[derive(Deserialize)]
struct PairDist {
    from: String,
    to: String,
    track_km: Option<f64>,
    status: String,
}

#[derive(Clone, Serialize)]
struct Override {
    set: usize,
    train_no: String,
    code: String,
    class: String,
    from: String,
    to: String,
    via: Vec<String>,
    minutes: i64,
    assigned_len_km: f64,
    drawn_len_km: f64,
    predicted_min: f64,
    drawn_predicted_min: f64,
    flags: String,
}

#[derive(Serialize)]
struct CandRow {
    chain: Vec<String>,
    source: String,
    len_km: f64,
    floor_min: f64,
    drawn: bool,
}

#[derive(Serialize)]
struct FlaggedPair {
    from: String,
    to: String,
    drawn_len_km: Option<f64>,
    drawn_status: Option<String>,
    n_direct: usize,
    fastest_direct_min: i64,
    fastest_stopping_min: Option<i64>,
    candidates: Vec<CandRow>,
    flagged_trains: Vec<String>,
    assigned: Vec<String>,
    ambiguous: Vec<String>,
}

#[derive(Serialize)]
struct ObservedPair {
    from: String,
    to: String,
    n_flagged: usize,
    max_ratio: f64,
}

#[derive(Serialize)]
struct Report {
    overrides: Vec<Override>,
    flagged_pairs: Vec<FlaggedPair>,
    ambiguous_legs: Vec<String>,
    observed_pairs: Vec<ObservedPair>,
}

struct Svc {
    minutes: i64,
    chain: Vec<String>,
    code: String,
}

/// Shortest station chain A->B over the pair graph (edge weight =
/// track_km), optionally excluding the direct A-B edge and a set of
/// forbidden intermediate stations. Returns (chain, total_km).
fn dijkstra_chain(
    adj: &HashMap<String, Vec<(String, f64)>>,
    a: &str,
    b: &str,
    forbid_direct: bool,
    forbid_nodes: &HashSet<String>,
) -> Option<(Vec<String>, f64)> {
    let mut dist: HashMap<String, f64> = HashMap::from([(a.to_string(), 0.0)]);
    let mut prev: HashMap<String, String> = HashMap::new();
    let mut visited: HashSet<String> = HashSet::new();
    loop {
        let mut best: Option<(String, f64)> = None;
        for (k, v) in dist.iter() {
            if !visited.contains(k) && best.as_ref().is_none_or(|(_, bv)| v < bv) {
                best = Some((k.clone(), *v));
            }
        }
        let (u, du) = best?;
        if u == b {
            break;
        }
        visited.insert(u.clone());
        if let Some(edges) = adj.get(&u) {
            for (v, w) in edges {
                if forbid_direct && u == a && v == b {
                    continue;
                }
                if v != b && v != a && forbid_nodes.contains(v) {
                    continue;
                }
                let nd = du + w;
                if nd < *dist.get(v).unwrap_or(&f64::INFINITY) {
                    dist.insert(v.clone(), nd);
                    prev.insert(v.clone(), u.clone());
                }
            }
        }
    }
    let total = *dist.get(b)?;
    let mut chain: Vec<String> = Vec::new();
    let mut cur = b.to_string();
    while cur != a {
        let p = prev.get(&cur)?.clone();
        if cur != b {
            chain.push(cur.clone());
        }
        cur = p;
    }
    chain.reverse();
    Some((chain, total))
}

fn main() {
    let data_dir = if let Ok(d) = env::var("CRFM_DATA_DIR") {
        PathBuf::from(d)
    } else if PathBuf::from("data").exists() {
        PathBuf::from("data")
    } else {
        PathBuf::from("../data")
    };
    let files = if let Ok(d) = env::var("CRFM_OUTPUT_DIR") {
        PathBuf::from(d)
    } else if PathBuf::from("output").exists() {
        PathBuf::from("output")
    } else {
        PathBuf::from("../output")
    };
    let d1_path = argval("--d1")
        .map(PathBuf::from)
        .unwrap_or_else(|| files.join("china-rail-timetables-2026-10-21.json"));
    let d2_path = argval("--d2")
        .map(PathBuf::from)
        .unwrap_or_else(|| files.join("china-rail-intercity-2026-10-28.json"));
    let pairs_path = argval("--pairs")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("derived/pair_distances.json"));
    let pairs2_path = argval("--pairs2")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("derived/cs_out/pair_distances.json"));
    let stations_path = argval("--stations")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("osm_stations.json"));
    let out_path = argval("--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("leg_overrides.json"));
    let report_path = argval("--report").map(PathBuf::from);

    let load = |p: &PathBuf| -> Vec<Train> {
        let d: Deliverable = serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap();
        d.trains
    };
    let mut trains: Vec<(usize, Train)> = Vec::new();
    for (set, p) in [(0usize, &d1_path), (1usize, &d2_path)] {
        for t in load(p) {
            trains.push((set, t));
        }
    }
    println!("trains: {}", trains.len());

    // station points for the progress/overshoot guards: GTFS stops
    // (authoritative timetable coordinates) first; OSM name matches only
    // as fallback — their median-nearest candidate can be a same-named
    // locality far away (e.g. 高碑店 also names a place in Beijing),
    // which silently corrupts the guard geometry.
    let osm: HashMap<String, Vec<[f64; 2]>> =
        serde_json::from_str(&fs::read_to_string(&stations_path).unwrap()).unwrap();
    let gtfs_path = argval("--gtfs")
        .map(PathBuf::from)
        .unwrap_or_else(|| files.join("gtfs-2026-10-21/stops.txt"));
    let mut gtfs_pt: HashMap<String, [f64; 2]> = HashMap::new();
    if let Ok(txt) = fs::read_to_string(&gtfs_path) {
        for line in txt.lines().skip(1) {
            let f: Vec<&str> = line.split(',').collect();
            if f.len() >= 4 {
                if let (Ok(lat), Ok(lon)) = (f[2].parse::<f64>(), f[3].parse::<f64>()) {
                    gtfs_pt.insert(clean(f[1]), [lat, lon]);
                }
            }
        }
    }
    println!("gtfs station points: {}", gtfs_pt.len());
    let station_pt = |name: &str| -> Option<[f64; 2]> {
        if let Some(p) = gtfs_pt.get(name) {
            return Some(*p);
        }
        let cands = osm.get(name)?;
        let mut lats: Vec<f64> = cands.iter().map(|c| c[0]).collect();
        let mut lons: Vec<f64> = cands.iter().map(|c| c[1]).collect();
        lats.sort_by(|x, y| x.partial_cmp(y).unwrap());
        lons.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let m = [lats[lats.len() / 2], lons[lons.len() / 2]];
        cands
            .iter()
            .min_by(|x, y| {
                let dx = (x[0] - m[0]).powi(2) + (x[1] - m[1]).powi(2);
                let dy = (y[0] - m[0]).powi(2) + (y[1] - m[1]).powi(2);
                dx.partial_cmp(&dy).unwrap()
            })
            .copied()
    };
    let progresses = |chain: &[String], a: &str, b: &str| -> bool {
        let (pa, pb) = match (station_pt(a), station_pt(b)) {
            (Some(x), Some(y)) => (x, y),
            _ => return false,
        };
        let ab = hav_km(pa, pb);
        let mut prev_d = ab;
        for s in chain {
            let ps = match station_pt(s) {
                Some(p) => p,
                None => return false,
            };
            let d = hav_km(ps, pb);
            if d > prev_d + PROGRESS_TOL_KM {
                return false;
            }
            // overshoot: no station sits far past either endpoint, and
            // the chord detour via the station stays bounded.
            if hav_km(pa, ps) > ab + OVERSHOOT_TOL_KM || d > ab + OVERSHOOT_TOL_KM {
                return false;
            }
            if hav_km(pa, ps) + d > 1.45 * ab + 15.0 {
                return false;
            }
            prev_d = d;
        }
        true
    };

    // pair track lengths (unordered key; first file wins, as in atlas)
    let mut pair_km: HashMap<(String, String), (f64, String)> = HashMap::new();
    for p in [&pairs_path, &pairs2_path] {
        let pf: PairsFile = serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap();
        for pr in pf.pairs {
            if let Some(km) = pr.track_km {
                let (a, b) = (clean(&pr.from), clean(&pr.to));
                let key = if a < b { (a, b) } else { (b, a) };
                pair_km.entry(key).or_insert((km, pr.status.clone()));
            }
        }
    }
    println!("pairs with track_km: {}", pair_km.len());
    let pair_len = |a: &str, b: &str| -> Option<f64> {
        let key = if a < b {
            (a.to_string(), b.to_string())
        } else {
            (b.to_string(), a.to_string())
        };
        pair_km.get(&key).map(|(km, _)| *km)
    };
    let mut adj: HashMap<String, Vec<(String, f64)>> = HashMap::new();
    for ((a, b), (km, _)) in pair_km.iter() {
        adj.entry(a.clone()).or_default().push((b.clone(), *km));
        adj.entry(b.clone()).or_default().push((a.clone(), *km));
    }
    let chain_len = |chain: &[String], a: &str, b: &str| -> Option<f64> {
        let mut pts: Vec<&str> = vec![a];
        pts.extend(chain.iter().map(|s| s.as_str()));
        pts.push(b);
        let mut total = 0.0;
        for w in pts.windows(2) {
            total += pair_len(w[0], w[1])?;
        }
        Some(total)
    };

    // ---- gather direct legs and endpoint services ----
    struct Leg {
        ti: usize,
        minutes: i64,
    }
    let mut direct: HashMap<(String, String), Vec<Leg>> = HashMap::new();
    let mut services: HashMap<(String, String), Vec<Svc>> = HashMap::new();
    for (ti, (_, t)) in trains.iter().enumerate() {
        let names: Vec<String> = t.stops.iter().map(|s| clean(&s.name)).collect();
        for i in 0..names.len() {
            for j in (i + 1)..names.len() {
                if names[i] == names[j] {
                    continue;
                }
                let m = match travel_time(&t.stops, i, j) {
                    Some(m) if m > 0 && m < 3000 => m,
                    _ => continue,
                };
                if j == i + 1 {
                    direct
                        .entry((names[i].clone(), names[j].clone()))
                        .or_default()
                        .push(Leg { ti, minutes: m });
                } else {
                    services
                        .entry((names[i].clone(), names[j].clone()))
                        .or_default()
                        .push(Svc {
                            minutes: m,
                            chain: names[i + 1..j].to_vec(),
                            code: t.code.clone(),
                        });
                }
            }
        }
    }
    println!(
        "ordered pairs: {} direct, {} with stopping services",
        direct.len(),
        services.len()
    );
    // fastest demonstrated direct-leg minutes per ordered segment
    let seg_floor: HashMap<(String, String), i64> = direct
        .iter()
        .map(|(k, v)| (k.clone(), v.iter().map(|l| l.minutes).min().unwrap()))
        .collect();
    let floor_of = |chain: &[String], a: &str, b: &str| -> Option<f64> {
        let mut pts: Vec<&str> = vec![a];
        pts.extend(chain.iter().map(|s| s.as_str()));
        pts.push(b);
        let mut total = 0i64;
        for w in pts.windows(2) {
            total += seg_floor.get(&(w[0].to_string(), w[1].to_string()))?;
        }
        Some(total as f64)
    };

    // ---- optional per-pair dump for eyeballing ----
    if let Some(spec) = argval("--dump-pair") {
        let mut it = spec.split_whitespace();
        let (a, b) = (it.next().unwrap(), it.next().unwrap());
        println!("== {} -> {} ==", a, b);
        println!("drawn track_km: {:?}", pair_len(a, b));
        if let Some(legs) = direct.get(&(a.to_string(), b.to_string())) {
            let mut v: Vec<(i64, &str, &str)> = legs
                .iter()
                .map(|l| {
                    (
                        l.minutes,
                        trains[l.ti].1.code.as_str(),
                        trains[l.ti].1.train_class.as_str(),
                    )
                })
                .collect();
            v.sort();
            println!("direct legs ({}): {:?}", v.len(), v);
        }
        if let Some(svcs) = services.get(&(a.to_string(), b.to_string())) {
            let mut by_chain: HashMap<Vec<String>, (i64, String, usize)> = HashMap::new();
            for s in svcs {
                let e = by_chain
                    .entry(s.chain.clone())
                    .or_insert((s.minutes, s.code.clone(), 0));
                if s.minutes < e.0 {
                    *e = (s.minutes, s.code.clone(), e.2);
                }
                by_chain.get_mut(&s.chain).unwrap().2 += 1;
            }
            let mut rows: Vec<_> = by_chain.into_iter().collect();
            rows.sort_by_key(|(_, (m, _, _))| *m);
            for (chain, (m, code, n)) in rows {
                println!(
                    "  stopping fastest {}min x{} (e.g. {}) len={:?} floor={:?} progress={} chain={}",
                    m,
                    n,
                    code,
                    chain_len(&chain, a, b),
                    floor_of(&chain, a, b),
                    progresses(&chain, a, b),
                    chain.join(">")
                );
            }
        }
        if let Some((chain, km)) = dijkstra_chain(&adj, a, b, true, &HashSet::new()) {
            println!(
                "  tiling (no direct edge): {:.1} km floor={:?} progress={} via {}",
                km,
                floor_of(&chain, a, b),
                progresses(&chain, a, b),
                chain.join(">")
            );
            let forb: HashSet<String> = chain.iter().cloned().collect();
            if let Some((chain2, km2)) = dijkstra_chain(&adj, a, b, true, &forb) {
                println!(
                    "  tiling2 (avoid tiling1 stations): {:.1} km floor={:?} progress={} via {}",
                    km2,
                    floor_of(&chain2, a, b),
                    progresses(&chain2, a, b),
                    chain2.join(">")
                );
            }
        }
        return;
    }

    // ---- classification ----
    #[derive(Clone)]
    struct Cand {
        chain: Vec<String>,
        source: String,
        len_km: f64,
        floor: f64,
    }
    // a corridor family: chains of near-equal length; prediction is the
    // min floor; the representative chain is the min-floor service chain
    // when the family has one, else the min-floor chain.
    struct Fam {
        len_km: f64,
        floor: f64,
        rep: Vec<String>,
        has_service: bool,
        is_drawn: bool,
    }
    let mut overrides: Vec<Override> = Vec::new();
    let mut flagged_pairs: Vec<FlaggedPair> = Vec::new();
    let mut ambiguous_legs: Vec<String> = Vec::new();
    let mut observed_pairs: Vec<ObservedPair> = Vec::new();
    let mut pair_keys: Vec<&(String, String)> = direct.keys().collect();
    pair_keys.sort();
    for key in pair_keys {
        let (a, b) = (&key.0, &key.1);
        let legs = &direct[key];
        let fastest_direct = legs.iter().map(|l| l.minutes).min().unwrap();
        let svcs = services.get(key);
        let fastest_stopping = svcs.and_then(|s| s.iter().map(|x| x.minutes).min());
        let ukey = if a < b {
            (a.clone(), b.clone())
        } else {
            (b.clone(), a.clone())
        };
        let drawn = pair_km.get(&ukey);
        let drawn_len = drawn.map(|(km, _)| *km);

        // candidates (progress/overshoot-guarded)
        let mut cands: Vec<Cand> = Vec::new();
        let mut seen_chains: HashSet<Vec<String>> = HashSet::new();
        if let Some(svcs) = svcs {
            let mut chains: HashSet<Vec<String>> = HashSet::new();
            for s in svcs {
                chains.insert(s.chain.clone());
            }
            for chain in chains {
                if !progresses(&chain, a, b) {
                    continue;
                }
                if let (Some(l), Some(f)) = (chain_len(&chain, a, b), floor_of(&chain, a, b)) {
                    if seen_chains.insert(chain.clone()) {
                        cands.push(Cand {
                            chain,
                            source: "service".to_string(),
                            len_km: l,
                            floor: f,
                        });
                    }
                }
            }
        }
        if let Some((chain, km)) = dijkstra_chain(&adj, a, b, true, &HashSet::new()) {
            let cap = drawn_len.map(|d| d * 1.8 + 50.0).unwrap_or(f64::INFINITY);
            if km <= cap && progresses(&chain, a, b) {
                if let Some(f) = floor_of(&chain, a, b) {
                    if seen_chains.insert(chain.clone()) {
                        cands.push(Cand {
                            chain: chain.clone(),
                            source: "tiling".to_string(),
                            len_km: km,
                            floor: f,
                        });
                    }
                }
            }
            let forb: HashSet<String> = chain.iter().cloned().collect();
            if let Some((chain2, km2)) = dijkstra_chain(&adj, a, b, true, &forb) {
                if km2 <= cap && progresses(&chain2, a, b) {
                    if let Some(f2) = floor_of(&chain2, a, b) {
                        if seen_chains.insert(chain2.clone()) {
                            cands.push(Cand {
                                chain: chain2,
                                source: "tiling2".to_string(),
                                len_km: km2,
                                floor: f2,
                            });
                        }
                    }
                }
            }
        }
        // drawn corridor: candidate whose length matches the stored pair km
        let mut drawn_idx: Option<usize> = None;
        if let Some(dl) = drawn_len {
            let mut best: Option<(f64, usize)> = None;
            for (i, c) in cands.iter().enumerate() {
                let d = (c.len_km - dl).abs() / dl;
                if d <= DRAWN_MATCH_FRAC && best.as_ref().is_none_or(|(bd, _)| d < *bd) {
                    best = Some((d, i));
                }
            }
            drawn_idx = best.map(|(_, i)| i);
        }
        // families: cluster candidates by length
        let mut order: Vec<usize> = (0..cands.len()).collect();
        order.sort_by(|&x, &y| cands[x].len_km.partial_cmp(&cands[y].len_km).unwrap());
        let mut fams: Vec<Fam> = Vec::new();
        let mut fam_of: HashMap<usize, usize> = HashMap::new();
        for &ci in order.iter() {
            let c = &cands[ci];
            let join = fams.last().and_then(|f: &Fam| {
                if c.len_km <= f.len_km * (1.0 + FAMILY_GAP_FRAC) {
                    Some(fams.len() - 1)
                } else {
                    None
                }
            });
            let fi = match join {
                Some(fi) => fi,
                None => {
                    fams.push(Fam {
                        len_km: c.len_km,
                        floor: c.floor,
                        rep: c.chain.clone(),
                        has_service: c.source == "service",
                        is_drawn: false,
                    });
                    fams.len() - 1
                }
            };
            let fam = &mut fams[fi];
            if c.floor < fam.floor
                || (c.floor == fam.floor && c.source == "service" && !fam.has_service)
            {
                fam.floor = c.floor;
                fam.rep = c.chain.clone();
            }
            if c.source == "service" {
                // prefer a service chain as representative when floors tie
                // closely; a service rep guarantees real geometry anchors
                if !fam.has_service {
                    fam.has_service = true;
                }
            }
            if Some(ci) == drawn_idx {
                fam.is_drawn = true;
            }
            fam_of.insert(ci, fi);
        }
        let drawn_fam: Option<usize> = drawn_idx.map(|ci| fam_of[&ci]);
        let drawn_floor = drawn_fam.map(|fi| fams[fi].floor);

        let mut fp = FlaggedPair {
            from: a.clone(),
            to: b.clone(),
            drawn_len_km: drawn_len,
            drawn_status: drawn.map(|(_, s)| s.clone()),
            n_direct: legs.len(),
            fastest_direct_min: fastest_direct,
            fastest_stopping_min: fastest_stopping,
            candidates: cands
                .iter()
                .enumerate()
                .map(|(i, c)| CandRow {
                    chain: c.chain.clone(),
                    source: c.source.clone(),
                    len_km: (c.len_km * 10.0).round() / 10.0,
                    floor_min: c.floor,
                    drawn: Some(i) == drawn_idx,
                })
                .collect(),
            flagged_trains: Vec::new(),
            assigned: Vec::new(),
            ambiguous: Vec::new(),
        };
        let mut any_flag = false;
        let mut n_observed = 0usize;
        let mut max_ratio = 0.0f64;
        for leg in legs {
            let m = leg.minutes;
            let loo_direct = legs
                .iter()
                .filter(|l| l.ti != leg.ti)
                .map(|l| l.minutes)
                .min()
                .unwrap_or(fastest_direct);
            let drawn_pred = drawn_floor.unwrap_or(loo_direct as f64);
            let drawn_err = (m as f64 - drawn_pred).abs();
            let tol = ASSIGN_TOL_MIN.max(ASSIGN_TOL_FRAC * m as f64);
            // static per-family eligibility for this leg
            let fam_ok = |fam: &Fam| -> bool {
                let len_diff_ok = drawn_len
                    .map(|dl| (fam.len_km - dl).abs() / dl > SAME_CORRIDOR_FRAC)
                    .unwrap_or(true);
                let chord_ok = match (station_pt(a), station_pt(b)) {
                    (Some(pa), Some(pb)) => fam.len_km <= 2.0 * hav_km(pa, pb) + 10.0,
                    _ => true,
                };
                let speed = fam.len_km / (m as f64) * 60.0;
                len_diff_ok && chord_ok && (55.0..=320.0).contains(&speed)
            };
            // best non-drawn family overall, and best with a service chain
            let mut best: Option<(f64, usize)> = None;
            let mut best_service: Option<(f64, usize)> = None;
            for (fi, fam) in fams.iter().enumerate() {
                if Some(fi) == drawn_fam {
                    continue;
                }
                let err = (m as f64 - fam.floor).abs();
                if fam.has_service && best_service.as_ref().is_none_or(|(be, _)| err < *be) {
                    best_service = Some((err, fi));
                }
                if !fam_ok(fam) {
                    continue;
                }
                if best.as_ref().is_none_or(|(be, _)| err < *be) {
                    best = Some((err, fi));
                }
            }
            let f1 = fastest_stopping.map(|s| m > s).unwrap_or(false);
            let f2 = (m as f64) >= FLAG_RATIO * (fastest_direct as f64) && m > fastest_direct;
            let f3 = drawn_floor
                .map(|f| (m as f64) - f >= FLAG_FLOOR_EXCESS)
                .unwrap_or(false);
            let f5 = drawn_floor
                .map(|f| f - (m as f64) >= FLAG_FLOOR_EXCESS)
                .unwrap_or(false);
            let f4 = drawn_fam.is_none()
                && fastest_stopping.map(|s| m <= s + 5).unwrap_or(false)
                && best_service
                    .map(|(err, fi)| {
                        err <= tol
                            && drawn_len
                                .map(|dl| (fams[fi].len_km - dl).abs() / dl > 0.05)
                                .unwrap_or(false)
                    })
                    .unwrap_or(false);
            if f2 || f3 {
                n_observed += 1;
                max_ratio = max_ratio.max(m as f64 / fastest_direct as f64);
            }
            if !f1 && !f4 && !f5 {
                continue;
            }
            any_flag = true;
            let (set, t) = &trains[leg.ti];
            let mut flags = String::new();
            if f1 {
                flags.push_str("F1 ");
            }
            if f4 {
                flags.push_str("F4 ");
            }
            if f5 {
                flags.push_str("F5 ");
            }
            fp.flagged_trains
                .push(format!("{} {}min [{}]", t.code, m, flags.trim()));
            // tiling-only families need the independent F1 evidence
            let assigned = match best {
                Some((err, fi)) => {
                    err <= tol && drawn_err - err >= MARGIN_MIN && (fams[fi].has_service || f1)
                }
                None => false,
            };
            if assigned {
                let (_, fi) = best.unwrap();
                let fam = &fams[fi];
                overrides.push(Override {
                    set: *set,
                    train_no: t.train_no.clone(),
                    code: t.code.clone(),
                    class: t.train_class.clone(),
                    from: a.clone(),
                    to: b.clone(),
                    via: fam.rep.clone(),
                    minutes: m,
                    assigned_len_km: (fam.len_km * 10.0).round() / 10.0,
                    drawn_len_km: drawn_len.unwrap_or(0.0),
                    predicted_min: fam.floor,
                    drawn_predicted_min: drawn_pred,
                    flags: flags.trim().to_string(),
                });
                fp.assigned.push(format!("{} {}min", t.code, m));
            } else {
                let desc = format!(
                    "{}->{} {} {}min [{}] (drawn pred {:.0} err {:.0}; best alt {})",
                    a,
                    b,
                    t.code,
                    m,
                    flags.trim(),
                    drawn_pred,
                    drawn_err,
                    best.map(|(e, fi)| { format!("err {:.0} via {}", e, fams[fi].rep.join(">")) })
                        .unwrap_or_else(|| "none".to_string())
                );
                fp.ambiguous.push(desc.clone());
                ambiguous_legs.push(desc);
            }
        }
        if any_flag {
            flagged_pairs.push(fp);
        }
        if n_observed > 0 {
            observed_pairs.push(ObservedPair {
                from: a.clone(),
                to: b.clone(),
                n_flagged: n_observed,
                max_ratio: (max_ratio * 100.0).round() / 100.0,
            });
        }
    }

    overrides.sort_by(|x, y| {
        (x.from.clone(), x.to.clone(), x.code.clone()).cmp(&(
            y.from.clone(),
            y.to.clone(),
            y.code.clone(),
        ))
    });
    println!(
        "flagged pairs (F1/F4/F5): {}, overrides: {}, ambiguous legs: {}, observed-only pairs: {}",
        flagged_pairs.len(),
        overrides.len(),
        ambiguous_legs.len(),
        observed_pairs.len()
    );
    for o in overrides.iter() {
        println!(
            "OVERRIDE {} {} {}->{} {}min [{}] via {} (len {:.1} vs drawn {:.1})",
            o.code,
            o.class,
            o.from,
            o.to,
            o.minutes,
            o.flags,
            o.via.join(">"),
            o.assigned_len_km,
            o.drawn_len_km
        );
    }
    fs::write(&out_path, serde_json::to_string_pretty(&overrides).unwrap()).unwrap();
    println!("wrote {}", out_path.display());
    if let Some(rp) = &report_path {
        let rep = Report {
            overrides: overrides.clone(),
            flagged_pairs,
            ambiguous_legs,
            observed_pairs,
        };
        fs::write(rp, serde_json::to_string_pretty(&rep).unwrap()).unwrap();
        println!("wrote {}", rp.display());
    }
}
