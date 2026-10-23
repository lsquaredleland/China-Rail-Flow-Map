// analyze-rs — Rust port of analyze.py (china-rail timetable analysis).
//
// Single self-contained pipeline, no intermediates:
//   china-rail.osm (513 MB XML, streamed) -> station candidates with tags
//   -> tag filter (drop subway points only) -> 3 km single-linkage
//   clusters -> per-train DP over the stop sequence choosing the candidate
//   combination with minimum total leg distance -> distances, validation
//   stats, deliverable JSON + resolution audit.
//
// Usage: analyze-rs [--emit-distances] [--fill-track]
//   [--trains-in <path>] [--stops-in <path>] [--date <yyyy-mm-dd>]
//   [--deliverable <filename>] [--only-class <PREFIX>]
//   --emit-distances mirrors EMIT_DISTANCE_FIELDS in analyze.py: include
//   od_km / route_km_straight_sum in the output JSON (default: off).
//   --fill-track: load data/derived/pair_distances.json (the --route + chainfill
//   output) and add per-train route_km_track to the deliverable: the sum of
//   audited track_km (status ok / bridged / via_chain) over the train's
//   consecutive stop pairs, matched geographically via the resolved points
//   (name pairs with >1 geographic entry are disambiguated by chord). The
//   field is null unless every leg is audited; route_km_track_legs_audited /
//   route_km_track_legs_total record the coverage either way.
//   --trains-in / --stops-in: alternate timetable files (default:
//   data/raw/trains.jsonl and data/raw/stops.jsonl). --date: deliverable date
//   label (default 2026-10-21). --deliverable: deliverable filename (default
//   china-rail-timetables-2026-10-21.json). --only-class: keep only trains
//   whose code starts with the given class prefix (e.g. C). All defaults
//   reproduce the trunk run exactly.
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::PathBuf;

// Shared routing module (src/graph.rs): each bin uses a different subset,
// so per-bin dead-code warnings for the unused parts are expected.
#[allow(dead_code)]
mod graph;
use graph::{astar_ferry, attr, build_graph, hav};

const CLUSTER_KM: f64 = 3.0;

#[derive(Deserialize)]
struct TrainRec {
    code: String,
}
#[derive(Deserialize)]
struct StopRec {
    train_no: String,
    code: String,
    date_used: Option<String>,
    stops: Vec<RawStop>,
}
#[derive(Deserialize)]
struct RawStop {
    station_name: String,
    station_no: String,
    arrive_time: String,
    start_time: String,
}

fn cls(code: &str) -> String {
    match code.chars().next() {
        Some(c) if c.is_ascii_alphabetic() => c.to_string(),
        _ => "plain".to_string(),
    }
}

#[derive(Default, Clone)]
struct Cand {
    pt: [f64; 2],
    station: String,
    subway: String,
    train: String,
}

fn strip_ws(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn name_variants(name: &str) -> Vec<String> {
    let n = strip_ws(name);
    let mut v = vec![n.clone(), format!("{}站", n)];
    if let Some(rest) = n.strip_prefix("香港") {
        v.push(rest.to_string());
        v.push(format!("{}站", rest));
    }
    v
}

fn tag_filter(cands: &[Cand]) -> Vec<Cand> {
    // Drop subway points ONLY. A hard "prefer train=yes" filter was tried and
    // is harmful: for 梁山 / 李家 / 永庆 the correct station is untagged and a
    // distant namesake carries train=yes, so the filter kept the wrong point
    // and left the DP nothing to choose. Remaining ambiguity is exactly what
    // the route DP is for.
    cands
        .iter()
        .filter(|c| !(c.station == "subway" || c.subway == "yes"))
        .cloned()
        .collect()
}

/// One station way from the OSM extract: (name keys, member node ids,
/// station tag, subway tag, train tag).
type StationWay = (Vec<String>, Vec<u64>, String, String, String);
/// Per-train retained resolution for --route mode: (code, class, stop names,
/// chosen points, leg minutes per consecutive pair).
type Retained = (
    String,
    String,
    Vec<String>,
    Vec<Option<[f64; 2]>>,
    Vec<Option<i64>>,
);

#[allow(clippy::needless_range_loop)]
fn clusters_of(pts: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let n = pts.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    for i in 0..n {
        for j in i + 1..n {
            if hav(pts[i], pts[j]) <= CLUSTER_KM {
                let pi = find(&mut parent, i);
                let pj = find(&mut parent, j);
                if pi != pj {
                    parent[pi] = pj;
                }
            }
        }
    }
    let mut groups: BTreeMap<usize, Vec<[f64; 2]>> = BTreeMap::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(pts[i]);
    }
    groups
        .values()
        .map(|g| {
            [
                g.iter().map(|p| p[0]).sum::<f64>() / g.len() as f64,
                g.iter().map(|p| p[1]).sum::<f64>() / g.len() as f64,
            ]
        })
        .collect()
}

/// DP over the stop sequence: choose one candidate point per stop
/// minimizing the total consecutive-stop distance, with a heavy penalty
/// (NONSNAP_PENALTY km-equivalent) for any candidate that does not snap
/// to the rail graph. `cand_snap` is parallel to `cand_map` (true = the
/// cluster centroid snaps within the router's 6 km rule). The penalty
/// only bites when a name has both snapping and non-snapping candidates:
/// a stale same-name point (the defunct Quanzhou East on the abandoned
/// Zhangquan line) can sit closer to the crow-flies path than the real
/// station, and pure distance minimization picks it; snap-awareness
/// makes the real, connected station win whenever one exists.
fn resolve_train(
    stop_names: &[String],
    cand_map: &HashMap<String, Vec<[f64; 2]>>,
    cand_snap: &HashMap<String, Vec<bool>>,
) -> Vec<Option<[f64; 2]>> {
    const NONSNAP_PENALTY: f64 = 1000.0;
    let pen = |name: &String, j: usize| -> f64 {
        match cand_snap.get(name) {
            Some(v) if !v.get(j).copied().unwrap_or(true) => NONSNAP_PENALTY,
            _ => 0.0,
        }
    };
    let mut out: Vec<Option<[f64; 2]>> = vec![None; stop_names.len()];
    let seq: Vec<(usize, &String, &Vec<[f64; 2]>)> = stop_names
        .iter()
        .enumerate()
        .filter_map(|(i, n)| cand_map.get(n).map(|c| (i, n, c)))
        .collect();
    if seq.is_empty() {
        return out;
    }
    let mut dp: Vec<f64> = seq[0]
        .2
        .iter()
        .enumerate()
        .map(|(j, _)| pen(seq[0].1, j))
        .collect();
    let mut backs: Vec<Vec<usize>> = Vec::new();
    for k in 1..seq.len() {
        let prev = seq[k - 1].2;
        let cur = seq[k].2;
        let mut ndp = vec![0.0; cur.len()];
        let mut nback = vec![0usize; cur.len()];
        for (j, cp) in cur.iter().enumerate() {
            let mut best_i = 0;
            let mut best_v = f64::INFINITY;
            for (i, pp) in prev.iter().enumerate() {
                let v = dp[i] + hav(*pp, *cp);
                if v < best_v {
                    best_v = v;
                    best_i = i;
                }
            }
            ndp[j] = best_v + pen(seq[k].1, j);
            nback[j] = best_i;
        }
        dp = ndp;
        backs.push(nback);
    }
    let mut j = dp
        .iter()
        .enumerate()
        .min_by(|a, b| a.1.partial_cmp(b.1).unwrap())
        .map(|(i, _)| i)
        .unwrap();
    let mut picks = vec![0usize; seq.len()];
    picks[seq.len() - 1] = j;
    for k in (1..seq.len()).rev() {
        j = backs[k - 1][j];
        picks[k - 1] = j;
    }
    for (k, (idx, _name, cands)) in seq.iter().enumerate() {
        out[*idx] = Some(cands[picks[k]]);
    }
    out
}

fn to_min(t: &str) -> Option<i64> {
    if t.is_empty() || t == "----" {
        return None;
    }
    let mut it = t.split(':');
    let h: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    Some(h * 60 + m)
}

fn main() {
    let emit_distances = env::args().any(|a| a == "--emit-distances");
    let fill_track = env::args().any(|a| a == "--fill-track");
    let route_mode = env::args().any(|a| a == "--route");
    let argval = |flag: &str| -> Option<String> {
        let a: Vec<String> = env::args().collect();
        a.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
    };
    let data_dir = argval("--data").map(PathBuf::from).unwrap_or_else(|| {
        if let Ok(d) = env::var("CRFM_DATA_DIR") {
            PathBuf::from(d)
        } else if PathBuf::from("data").exists() {
            PathBuf::from("data")
        } else {
            PathBuf::from("../data")
        }
    });
    let output_dir = argval("--output").map(PathBuf::from).unwrap_or_else(|| {
        if let Ok(d) = env::var("CRFM_OUTPUT_DIR") {
            PathBuf::from(d)
        } else if PathBuf::from("output").exists() {
            PathBuf::from("output")
        } else {
            PathBuf::from("../output")
        }
    });
    let raw = data_dir.join("raw");
    let derived = data_dir.join("derived");
    // --osm <path>: alternate extract (e.g. a fresh Geofabrik pull).
    // --out-dir <dir>: write ALL outputs there instead of production paths.
    let osm_path = argval("--osm")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("osm/china-rail.osm"));
    let out_dir: Option<PathBuf> = argval("--out-dir").map(PathBuf::from);
    if let Some(d) = &out_dir {
        fs::create_dir_all(d).unwrap();
    }
    let out_file = |name: &str, legacy: PathBuf| -> PathBuf {
        match &out_dir {
            Some(d) => d.join(name),
            None => legacy,
        }
    };

    let trains: Vec<TrainRec> = fs::read_to_string(
        argval("--trains-in")
            .map(PathBuf::from)
            .unwrap_or_else(|| raw.join("trains.jsonl")),
    )
    .unwrap()
    .lines()
    .filter(|l| !l.trim().is_empty())
    .map(|l| serde_json::from_str(l).unwrap())
    .collect();
    let stops: Vec<StopRec> = fs::read_to_string(
        argval("--stops-in")
            .map(PathBuf::from)
            .unwrap_or_else(|| raw.join("stops.jsonl")),
    )
    .unwrap()
    .lines()
    .filter(|l| !l.trim().is_empty())
    .map(|l| serde_json::from_str(l).unwrap())
    .collect();
    let only_class: Option<String> = argval("--only-class");
    // --only-class accepts a comma list (e.g. "C,S" for the intercity set).
    let class_set: Option<HashSet<String>> = only_class
        .as_ref()
        .map(|p| p.split(',').map(|s| s.trim().to_string()).collect());
    let trains: Vec<TrainRec> = match &class_set {
        Some(set) => trains
            .into_iter()
            .filter(|t| set.contains(&cls(&t.code)))
            .collect(),
        None => trains,
    };
    let stops: Vec<StopRec> = match &class_set {
        Some(set) => stops
            .into_iter()
            .filter(|s| set.contains(&cls(&s.code)))
            .collect(),
        None => stops,
    };
    let date_label = argval("--date").unwrap_or_else(|| "2026-10-21".to_string());
    let deliverable_name = argval("--deliverable")
        .unwrap_or_else(|| "china-rail-timetables-2026-10-21.json".to_string());
    println!(
        "discovered trains: {}   stop lists: {}",
        trains.len(),
        stops.len()
    );
    let mut class_count: BTreeMap<String, usize> = BTreeMap::new();
    for t in &trains {
        *class_count.entry(cls(&t.code)).or_default() += 1;
    }
    println!("discovered by class: {:?}", class_count);
    println!(
        "total stop rows: {}",
        stops.iter().map(|s| s.stops.len()).sum::<usize>()
    );
    if let Some(g) = stops.iter().find(|s| s.code == "G654") {
        let names: Vec<&str> = g.stops.iter().map(|x| x.station_name.as_str()).collect();
        println!("G654: {} stops: {}", g.stops.len(), names.join(" → "));
    }

    // ---- want-name set ----
    let mut all_names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for s in &stops {
        for x in &s.stops {
            if seen.insert(x.station_name.clone()) {
                all_names.push(x.station_name.clone());
            }
        }
    }
    let mut want: HashSet<String> = HashSet::new();
    for n in &all_names {
        for v in name_variants(n) {
            want.insert(v);
        }
    }

    // ---- stream the OSM XML, collecting station candidates with tags ----
    // Stations come in two shapes: nodes, and ways (station footprint
    // polygons — 榆社西 and 马兰 exist ONLY as ways). Names are matched
    // against name:zh, name, and name:zh-Hans (香港西九龙's name:zh is
    // traditional; the simplified name lives in name:zh-Hans).
    let t0 = std::time::Instant::now();
    let mut byname: HashMap<String, Vec<Cand>> = HashMap::new();
    // (matched name keys, member node ids, station tag, subway tag, train tag)
    let mut station_ways: Vec<StationWay> = Vec::new();
    let mut reader = Reader::from_file(&osm_path).expect("open china-rail.osm");
    let mut buf: Vec<u8> = Vec::with_capacity(1 << 16);
    #[derive(PartialEq)]
    enum Mode {
        None,
        Node,
        Way,
    }
    let mut mode = Mode::None;
    let mut cur = Cand::default();
    let mut cur_name = String::new();
    let mut cur_name_zh = String::new();
    let mut cur_name_hans = String::new();
    let mut cur_railway = String::new();
    let mut way_refs: Vec<u64> = Vec::new();
    let mut total_points = 0usize;
    let matched_keys = |zh: &str, nm: &str, hans: &str, want: &HashSet<String>| -> Vec<String> {
        [zh, nm, hans]
            .into_iter()
            .filter(|k| !k.is_empty() && want.contains(*k))
            .map(|k| k.to_string())
            .collect()
    };
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if e.name().as_ref() == b"node" => {
                mode = Mode::Node;
                cur = Cand {
                    pt: [
                        attr(&e, "lat").parse().unwrap_or(0.0),
                        attr(&e, "lon").parse().unwrap_or(0.0),
                    ],
                    ..Default::default()
                };
                cur_name.clear();
                cur_name_zh.clear();
                cur_name_hans.clear();
                cur_railway.clear();
            }
            Ok(Event::Start(e)) if e.name().as_ref() == b"way" => {
                mode = Mode::Way;
                cur = Cand::default();
                cur_name.clear();
                cur_name_zh.clear();
                cur_name_hans.clear();
                cur_railway.clear();
                way_refs.clear();
            }
            Ok(Event::Empty(e)) if e.name().as_ref() == b"nd" && mode == Mode::Way => {
                if let Ok(r) = attr(&e, "ref").parse::<u64>() {
                    way_refs.push(r);
                }
            }
            Ok(Event::Empty(e)) if e.name().as_ref() == b"tag" && mode != Mode::None => {
                let k = attr(&e, "k");
                let v = attr(&e, "v");
                match k.as_str() {
                    "railway" => cur_railway = v,
                    "station" => cur.station = v,
                    "subway" => cur.subway = v,
                    "train" => cur.train = v,
                    "name" => cur_name = v,
                    "name:zh" => cur_name_zh = v,
                    "name:zh-Hans" => cur_name_hans = v,
                    _ => {}
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"node" && mode == Mode::Node => {
                mode = Mode::None;
                if cur_railway == "station" || cur_railway == "halt" {
                    for key in matched_keys(&cur_name_zh, &cur_name, &cur_name_hans, &want) {
                        byname.entry(key).or_default().push(cur.clone());
                        total_points += 1;
                    }
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"way" && mode == Mode::Way => {
                mode = Mode::None;
                if cur_railway == "station" || cur_railway == "halt" {
                    let keys = matched_keys(&cur_name_zh, &cur_name, &cur_name_hans, &want);
                    if !keys.is_empty() && !way_refs.is_empty() {
                        station_ways.push((
                            keys,
                            way_refs.clone(),
                            cur.station.clone(),
                            cur.subway.clone(),
                            cur.train.clone(),
                        ));
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => panic!("XML error: {:?}", e),
            _ => {}
        }
        buf.clear();
    }
    // Second pass: coordinates for the station ways' member nodes, then
    // each way contributes its centroid as a candidate point.
    if !station_ways.is_empty() {
        let needed: HashSet<u64> = station_ways
            .iter()
            .flat_map(|w| w.1.iter().copied())
            .collect();
        let mut coords: HashMap<u64, [f64; 2]> = HashMap::new();
        let mut reader2 = Reader::from_file(&osm_path).expect("open china-rail.osm (pass 2)");
        let mut buf2: Vec<u8> = Vec::with_capacity(1 << 16);
        loop {
            match reader2.read_event_into(&mut buf2) {
                Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.name().as_ref() == b"node" => {
                    if let Ok(id) = attr(&e, "id").parse::<u64>() {
                        if needed.contains(&id) {
                            coords.insert(
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
                Err(e) => panic!("XML error (pass 2): {:?}", e),
                _ => {}
            }
            buf2.clear();
        }
        let mut ways_added = 0usize;
        for (keys, refs, station, subway, train) in &station_ways {
            let mut uniq: Vec<u64> = Vec::new();
            for r in refs {
                if !uniq.contains(r) {
                    uniq.push(*r);
                }
            }
            let pts: Vec<[f64; 2]> = uniq
                .iter()
                .filter_map(|id| coords.get(id).copied())
                .collect();
            if pts.is_empty() {
                continue;
            }
            let centroid = [
                pts.iter().map(|p| p[0]).sum::<f64>() / pts.len() as f64,
                pts.iter().map(|p| p[1]).sum::<f64>() / pts.len() as f64,
            ];
            let cand = Cand {
                pt: centroid,
                station: station.clone(),
                subway: subway.clone(),
                train: train.clone(),
            };
            for key in keys {
                byname.entry(key.clone()).or_default().push(cand.clone());
                total_points += 1;
            }
            ways_added += 1;
        }
        println!(
            "station ways resolved to centroid candidates: {}",
            ways_added
        );
    }
    println!(
        "OSM scan: {:.2?} — candidate names: {} points: {}",
        t0.elapsed(),
        byname.len(),
        total_points
    );

    // ---- per-name candidate clusters ----
    let candidates_for = |name: &str| -> Option<Vec<[f64; 2]>> {
        for cand in name_variants(name) {
            if let Some(list) = byname.get(&cand) {
                let rail = tag_filter(list);
                if rail.is_empty() {
                    return None;
                }
                let pts: Vec<[f64; 2]> = rail.iter().map(|c| c.pt).collect();
                return Some(clusters_of(&pts));
            }
        }
        None
    };
    let mut sorted_names = all_names.clone();
    sorted_names.sort();
    let mut cand_map: HashMap<String, Vec<[f64; 2]>> = HashMap::new();
    let mut unmatched: Vec<String> = Vec::new();
    for n in &sorted_names {
        match candidates_for(n) {
            Some(c) => {
                cand_map.insert(n.clone(), c);
            }
            None => unmatched.push(n.clone()),
        }
    }
    let multi: Vec<&String> = sorted_names
        .iter()
        .filter(|n| cand_map.get(*n).map(|c| c.len() > 1).unwrap_or(false))
        .collect();
    println!(
        "unique stations: {}  matched: {} ({:.1}%)  unmatched: {} {:?}",
        sorted_names.len(),
        cand_map.len(),
        100.0 * cand_map.len() as f64 / sorted_names.len() as f64,
        unmatched.len(),
        unmatched
    );
    println!(
        "names with >1 candidate cluster after tag filters (need route DP): {}: {:?}",
        multi.len(),
        multi
    );

    // ---- rail graph + snap index, built once for all modes ----
    // Snap-awareness for resolve_train (see its doc comment), and the
    // --route phase below reuses this same graph and snap closure.
    let t_graph0 = std::time::Instant::now();
    let graph = build_graph(&osm_path);
    let mut snap_grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for (i, c) in graph.coords.iter().enumerate() {
        snap_grid
            .entry(((c[0] * 50.0) as i32, (c[1] * 50.0) as i32))
            .or_default()
            .push(i as u32);
    }
    let snap = |pt: [f64; 2]| -> Option<u32> {
        let (cx, cy) = ((pt[0] * 50.0) as i32, (pt[1] * 50.0) as i32);
        let mut best: Option<(f64, u32)> = None;
        for ring in 0..=3i32 {
            for dx in -ring..=ring {
                for dy in -ring..=ring {
                    if ring > 0 && dx.abs() != ring && dy.abs() != ring {
                        continue;
                    }
                    if let Some(nodes) = snap_grid.get(&(cx + dx, cy + dy)) {
                        for &n in nodes {
                            let d = hav(pt, graph.coords[n as usize]);
                            if best.map(|(bd, _)| d < bd).unwrap_or(true) {
                                best = Some((d, n));
                            }
                        }
                    }
                }
            }
            // best within ~ring*2km; accept once a full ring beyond best is done
            if let Some((bd, _)) = best {
                if bd < (ring as f64) * 1.5 {
                    break;
                }
            }
        }
        match best {
            Some((d, n)) if d <= 6.0 => Some(n),
            _ => None,
        }
    };
    let cand_snap: HashMap<String, Vec<bool>> = cand_map
        .iter()
        .map(|(n, cs)| {
            (
                n.clone(),
                cs.iter()
                    .map(|&pt| snap(pt).is_some())
                    .collect::<Vec<bool>>(),
            )
        })
        .collect();
    println!(
        "graph + snap index built: {:.1?} ({} candidate clusters snap-tested)",
        t_graph0.elapsed(),
        cand_snap.values().map(|v| v.len()).sum::<usize>()
    );

    // ---- --fill-track: load audited pair distances ----
    // Keyed by (from, to) names; a name pair can hold >1 geographic entry
    // (9 such pairs: distinct endpoint clusters sharing names), so entries
    // keep their chord_km and the per-train leg picks the chord match.
    struct TrackEntry {
        chord: f64,
        track: Option<f64>,
        audited: bool,
    }
    let mut track_map: HashMap<(String, String), Vec<TrackEntry>> = HashMap::new();
    let mut track_pairs_total = 0usize;
    let mut track_pairs_audited = 0usize;
    if fill_track {
        let path = argval("--pairs")
            .map(PathBuf::from)
            .unwrap_or_else(|| derived.join("pair_distances.json"));
        let doc: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        for p in doc["pairs"].as_array().unwrap() {
            track_pairs_total += 1;
            let audited = matches!(
                p["status"].as_str().unwrap_or(""),
                "ok" | "bridged" | "via_chain" | "ferry"
            );
            if audited {
                track_pairs_audited += 1;
            }
            track_map
                .entry((
                    strip_ws(p["from"].as_str().unwrap()),
                    strip_ws(p["to"].as_str().unwrap()),
                ))
                .or_default()
                .push(TrackEntry {
                    chord: p["chord_km"].as_f64().unwrap_or(0.0),
                    track: p["track_km"].as_f64(),
                    audited,
                });
        }
        println!(
            "--fill-track: {} pairs loaded from {} ({} audited)",
            track_pairs_total,
            path.display(),
            track_pairs_audited
        );
    }
    let mut track_full_trains = 0usize;
    let mut track_partial_trains = 0usize;
    let mut track_ratios: Vec<f64> = Vec::new();

    // ---- per-train resolution + outputs ----
    let mut audit: BTreeMap<String, Vec<([i64; 2], usize)>> = BTreeMap::new();
    let mut out_trains: Vec<serde_json::Value> = Vec::new();
    let mut od_missing = 0usize;
    let mut ratios: Vec<f64> = Vec::new();
    let mut leg_flags = 0usize;
    let mut leg_total = 0usize;
    // extended diagnostics
    let mut speeds: Vec<f64> = Vec::new();
    // retained per-train resolution for --route mode:
    // (code, class, stop names, chosen points, leg minutes per consecutive pair)
    let mut retained: Vec<Retained> = Vec::new();
    let mut stop_with_point = 0usize;
    let mut stop_ambiguous = 0usize;
    let mut stop_unmatched = 0usize;
    let mut trains_with_unmatched = 0usize;
    let mut ratio_outliers: Vec<(f64, String, f64, f64)> = Vec::new();
    let mut od_band = 0usize;
    let mut worst_legs: Vec<(f64, String, String, String)> = Vec::new();
    let mut examples: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    let mut ld_count = 0usize;

    for s in &stops {
        let stop_names: Vec<String> = s.stops.iter().map(|x| x.station_name.clone()).collect();
        let pts = resolve_train(&stop_names, &cand_map, &cand_snap);
        let mut train_has_unmatched = false;
        for (nm, pt) in stop_names.iter().zip(pts.iter()) {
            match pt {
                Some(_) => stop_with_point += 1,
                None => {
                    stop_unmatched += 1;
                    train_has_unmatched = true;
                }
            }
            if cand_map.get(nm).map(|c| c.len() > 1).unwrap_or(false) {
                stop_ambiguous += 1;
            }
        }
        if train_has_unmatched {
            trains_with_unmatched += 1;
        }
        for (nm, pt) in stop_names.iter().zip(pts.iter()) {
            if let (Some(p), Some(cands)) = (pt, cand_map.get(nm)) {
                if cands.len() > 1 {
                    let key = [
                        (p[0] * 1000.0).round() as i64,
                        (p[1] * 1000.0).round() as i64,
                    ];
                    let entry = audit.entry(nm.clone()).or_default();
                    if let Some(e) = entry.iter_mut().find(|(k, _)| *k == key) {
                        e.1 += 1;
                    } else {
                        entry.push((key, 1));
                    }
                }
            }
        }
        let seq_pts: Vec<[f64; 2]> = pts.iter().flatten().copied().collect();
        let od = match (pts.first(), pts.last()) {
            (Some(Some(a)), Some(Some(b))) => Some(hav(*a, *b)),
            _ => None,
        };
        if od.is_none() {
            od_missing += 1;
        }
        let route = if seq_pts.len() >= 2 {
            Some(seq_pts.windows(2).map(|w| hav(w[0], w[1])).sum::<f64>())
        } else {
            None
        };
        // --fill-track: sum audited track_km over consecutive stop pairs.
        // Geographic match: the router keyed pairs by resolved endpoints, so
        // a leg's own haversine chord must match the entry's chord_km
        // (entries are rounded to 0.1 km; 0.6 km tolerance is far below the
        // >5 km chord separation of every duplicate name pair).
        let track_total_legs = s.stops.len().saturating_sub(1);
        let mut track_audited_legs = 0usize;
        let mut track_sum = 0.0f64;
        if fill_track {
            for i in 1..stop_names.len() {
                if let (Some(a), Some(b)) = (pts[i - 1], pts[i]) {
                    let ch = hav(a, b);
                    // strip_ws: a handful of 12306 stop lists typeset station
                    // names with internal spaces ("青  岛北") while the pair
                    // file carries the clean form — same station, and the
                    // chord check below still guards the match geographically.
                    let key = (strip_ws(&stop_names[i - 1]), strip_ws(&stop_names[i]));
                    if let Some(entries) = track_map.get(&key) {
                        let best = entries.iter().min_by(|x, y| {
                            (x.chord - ch)
                                .abs()
                                .partial_cmp(&(y.chord - ch).abs())
                                .unwrap()
                        });
                        if let Some(e) = best {
                            if (e.chord - ch).abs() <= 0.6 && e.audited {
                                if let Some(t) = e.track {
                                    track_sum += t;
                                    track_audited_legs += 1;
                                }
                            }
                        }
                    }
                }
            }
            if track_total_legs > 0 && track_audited_legs == track_total_legs {
                track_full_trains += 1;
                if let Some(r) = route {
                    if r > 0.0 {
                        track_ratios.push(track_sum / r);
                    }
                }
            } else if track_audited_legs > 0 {
                track_partial_trains += 1;
            }
        }
        if let (Some(o), Some(r)) = (od, route) {
            if o > 0.0 {
                ratios.push(r / o);
                if o >= 100.0 && r / o > 2.0 {
                    ratio_outliers.push((r / o, s.code.clone(), o, r));
                }
            }
            if (230.0..270.0).contains(&o) {
                od_band += 1;
            }
        }
        if od.map(|o| o >= 250.0).unwrap_or(false) {
            ld_count += 1;
        }
        // leg speed sanity check (timetable times, midnight rollover)
        let mut leg_mins: Vec<Option<i64>> = vec![None; s.stops.len().saturating_sub(1)];
        let mut elapsed: i64 = 0;
        let mut prev_dep: Option<i64> = None;
        for (idx, x) in s.stops.iter().enumerate() {
            let arr = to_min(&x.arrive_time);
            let dep = to_min(&x.start_time);
            if let Some(a) = arr {
                while prev_dep.map(|p| a + elapsed < p).unwrap_or(false) {
                    elapsed += 1440;
                }
            }
            if idx > 0 {
                if let (Some(p), Some(a), Some(pp), Some(cp)) =
                    (prev_dep, arr, pts[idx - 1], pts[idx])
                {
                    let mins = a + elapsed - p;
                    if mins > 0 {
                        leg_mins[idx - 1] = Some(mins);
                        leg_total += 1;
                        let speed = hav(pp, cp) / (mins as f64 / 60.0);
                        speeds.push(speed);
                        if speed > 400.0 {
                            leg_flags += 1;
                            worst_legs.push((
                                speed,
                                s.code.clone(),
                                s.stops[idx - 1].station_name.clone(),
                                x.station_name.clone(),
                            ));
                        }
                    }
                }
            }
            if let Some(d) = dep {
                let base = arr.unwrap_or(d);
                while d + elapsed < base {
                    elapsed += 1440;
                }
                prev_dep = Some(d + elapsed);
            }
        }
        if route_mode {
            retained.push((
                s.code.clone(),
                cls(&s.code),
                stop_names.clone(),
                pts.clone(),
                leg_mins,
            ));
        }
        if s.code == "1461" || s.code == "G1" {
            if let (Some(o), Some(r)) = (od, route) {
                examples.insert(s.code.clone(), (o, r));
            }
        }
        let stops_json: Vec<serde_json::Value> = s
            .stops
            .iter()
            .map(|x| {
                serde_json::json!({
                    "no": x.station_no,
                    "name": x.station_name,
                    "arrive": x.arrive_time,
                    "depart": x.start_time,
                })
            })
            .collect();
        let mut rec = serde_json::json!({
            "train_no": s.train_no,
            "code": s.code,
            "class": cls(&s.code),
            "origin": s.stops.first().map(|x| x.station_name.clone()).unwrap_or_default(),
            "destination": s.stops.last().map(|x| x.station_name.clone()).unwrap_or_default(),
            "date_used": s.date_used,
            "stops": stops_json,
        });
        if emit_distances {
            rec["od_km"] = match od {
                Some(v) => serde_json::json!((v * 10.0).round() / 10.0),
                None => serde_json::Value::Null,
            };
            rec["route_km_straight_sum"] = match route {
                Some(v) => serde_json::json!((v * 10.0).round() / 10.0),
                None => serde_json::Value::Null,
            };
        }
        if fill_track {
            rec["route_km_track"] =
                if track_total_legs > 0 && track_audited_legs == track_total_legs {
                    serde_json::json!((track_sum * 10.0).round() / 10.0)
                } else {
                    serde_json::Value::Null
                };
            rec["route_km_track_legs_audited"] = serde_json::json!(track_audited_legs);
            rec["route_km_track_legs_total"] = serde_json::json!(track_total_legs);
        }
        out_trains.push(rec);
    }

    ratios.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if !ratios.is_empty() {
        println!(
            "route/od ratio after fix: median {:.2}  p90 {:.2}  max {:.2}",
            ratios[ratios.len() / 2],
            ratios[(ratios.len() as f64 * 0.9) as usize],
            ratios[ratios.len() - 1]
        );
    }
    println!(
        "leg speed check: {} of {} legs imply >400 km/h",
        leg_flags, leg_total
    );
    worst_legs.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    for (sp, code, a, b) in worst_legs.iter().take(10) {
        println!("  worst leg: {} {} → {} at {:.0} km/h", code, a, b, sp);
    }
    for (code, (o, r)) in &examples {
        println!(
            "example {}: od_km {:.1}  route_km_straight_sum {:.1}  ratio {:.2}",
            code,
            o,
            r,
            r / o
        );
    }
    println!(
        "OD distance computed for {}/{} trains; OD>=250km (long-distance): {}",
        stops.len() - od_missing,
        stops.len(),
        ld_count
    );
    // ---- extended diagnostics ----
    let total_stop_instances: usize = stops.iter().map(|s| s.stops.len()).sum();
    let total_pairs: usize = stops.iter().map(|s| s.stops.len().saturating_sub(1)).sum();
    speeds.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| -> f64 {
        if speeds.is_empty() {
            0.0
        } else {
            speeds[((p * (speeds.len() - 1) as f64).round() as usize).min(speeds.len() - 1)]
        }
    };
    println!("--- diagnostics ---");
    println!(
        "stop instances: {} total, {} with point ({:.2}%), {} at DP-ambiguous names, {} unmatched",
        total_stop_instances,
        stop_with_point,
        100.0 * stop_with_point as f64 / total_stop_instances as f64,
        stop_ambiguous,
        stop_unmatched
    );
    println!(
        "trains with >=1 unmatched stop: {} (od missing for {})",
        trains_with_unmatched, od_missing
    );
    println!(
        "legs evaluated: {} of {} consecutive pairs ({} skipped: missing point/time or non-positive time)",
        leg_total,
        total_pairs,
        total_pairs.saturating_sub(leg_total)
    );
    println!(
        "leg implied speed km/h: p50 {:.0}  p90 {:.0}  p99 {:.0}  p99.9 {:.0}  max {:.0}; >300: {}  >350: {}",
        pct(0.50),
        pct(0.90),
        pct(0.99),
        pct(0.999),
        speeds.last().copied().unwrap_or(0.0),
        speeds.iter().filter(|v| **v > 300.0).count(),
        speeds.iter().filter(|v| **v > 350.0).count()
    );
    ratio_outliers.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    println!(
        "trains with od>=100km and route/od>2: {}",
        ratio_outliers.len()
    );
    for (ratio, code, o, r) in ratio_outliers.iter().take(8) {
        println!(
            "  outlier: {} ratio {:.2} od {:.0} route {:.0}",
            code, ratio, o, r
        );
    }
    println!(
        "trains with od in [230,270) km (long-distance threshold sensitivity band): {}",
        od_band
    );

    out_trains.sort_by(|a, b| {
        a["code"]
            .as_str()
            .unwrap_or("")
            .cmp(b["code"].as_str().unwrap_or(""))
    });
    let match_rate =
        (cand_map.len() as f64 / sorted_names.len() as f64 * 10000.0).round() / 10000.0;
    let mut deliverable = serde_json::json!({
        "date": date_label,
        "source": "12306 live (leftTicket + czxx/queryByTrainNo)",
        "trains_discovered": trains.len(),
        "stop_lists": out_trains.len(),
        "station_match_rate": match_rate,
        "trains": out_trains,
    });
    if fill_track {
        track_ratios.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let med = if track_ratios.is_empty() {
            0.0
        } else {
            track_ratios[track_ratios.len() / 2]
        };
        println!(
            "--fill-track: {} trains fully on audited pairs, {} partial; median track/chord {:.3}",
            track_full_trains, track_partial_trains, med
        );
        deliverable["route_km_track"] = serde_json::json!({
            "about": "Per-train track-accurate route distance: sum of audited track_km from data/derived/pair_distances.json (A* over the OSM railway=rail graph, post gap-bridging and chainfill; statuses ok / bridged / via_chain / ferry) over consecutive stop pairs. Null when any leg lacks an audited pair distance; route_km_track_legs_audited / route_km_track_legs_total give per-train leg coverage.",
            "pairs_audited": track_pairs_audited,
            "pairs_total": track_pairs_total,
            "trains_fully_routed": track_full_trains,
        });
    }
    let dest = out_file(&deliverable_name, output_dir.join(&deliverable_name));
    let text = serde_json::to_string(&deliverable).unwrap();
    fs::write(&dest, &text).unwrap();
    println!(
        "deliverable written: {} {:.1} MB",
        dest.display(),
        text.len() as f64 / 1e6
    );
    fs::write(
        out_file(
            "unmatched_stations.json",
            data_dir.join("unmatched_stations.json"),
        ),
        serde_json::to_string_pretty(&unmatched).unwrap(),
    )
    .unwrap();
    let mut audit_json = serde_json::Map::new();
    for (name, entries) in &audit {
        let mut es: Vec<serde_json::Value> = entries
            .iter()
            .map(|(k, cnt)| {
                serde_json::json!({
                    "point": [k[0] as f64 / 1000.0, k[1] as f64 / 1000.0],
                    "trains": cnt,
                })
            })
            .collect();
        es.sort_by(|a, b| b["trains"].as_u64().cmp(&a["trains"].as_u64()));
        audit_json.insert(name.clone(), serde_json::json!({ "clusters_chosen": es }));
    }
    fs::write(
        out_file(
            "station_resolution.json",
            data_dir.join("station_resolution.json"),
        ),
        serde_json::to_string_pretty(&serde_json::Value::Object(audit_json)).unwrap(),
    )
    .unwrap();
    println!(
        "resolution audit written: station_resolution.json — {} ambiguous names resolved per-train",
        audit.len()
    );

    // ================= --route: track-accurate pair distances =================
    if route_mode {
        use std::collections::BTreeSet;
        #[derive(Default)]
        struct PairInfo {
            from: String,
            to: String,
            pa: [f64; 2],
            pb: [f64; 2],
            chord: f64,
            classes: BTreeSet<String>,
            uses: usize,
            min_leg_min: Option<i64>,
        }
        let key_of = |a: [f64; 2], b: [f64; 2]| -> [i64; 4] {
            [
                (a[0] * 10000.0).round() as i64,
                (a[1] * 10000.0).round() as i64,
                (b[0] * 10000.0).round() as i64,
                (b[1] * 10000.0).round() as i64,
            ]
        };
        let mut pairs: HashMap<[i64; 4], PairInfo> = HashMap::new();
        for (_code, class, names, pts, leg_mins) in &retained {
            for i in 1..names.len() {
                if let (Some(a), Some(b)) = (pts[i - 1], pts[i]) {
                    let e = pairs.entry(key_of(a, b)).or_insert_with(|| PairInfo {
                        from: names[i - 1].clone(),
                        to: names[i].clone(),
                        pa: a,
                        pb: b,
                        chord: hav(a, b),
                        ..Default::default()
                    });
                    e.classes.insert(class.clone());
                    e.uses += 1;
                    if let Some(m) = leg_mins[i - 1] {
                        e.min_leg_min = Some(e.min_leg_min.map(|x: i64| x.min(m)).unwrap_or(m));
                    }
                }
            }
        }
        println!(
            "--- routing: {} unique geographic stop pairs ---",
            pairs.len()
        );
        // The graph and the snap closure are built once near the top of
        // main (shared with the snap-aware station resolution); this phase
        // reuses them.
        let mut snap_cache: HashMap<[i64; 2], Option<u32>> = HashMap::new();
        let mut snap_fail = 0usize;
        let mut snap_fail_names: Vec<String> = Vec::new();
        let mut pair_list: Vec<([i64; 4], PairInfo)> = pairs.into_iter().collect();
        pair_list.sort_by(|a, b| a.1.from.cmp(&b.1.from).then(a.1.to.cmp(&b.1.to)));
        // resolve snaps once per pair endpoint
        let mut jobs: Vec<(usize, u32, u32)> = Vec::new();
        for (i, (_k, p)) in pair_list.iter().enumerate() {
            let (pa, pb) = (p.pa, p.pb);
            let ka = [
                (pa[0] * 10000.0).round() as i64,
                (pa[1] * 10000.0).round() as i64,
            ];
            let kb = [
                (pb[0] * 10000.0).round() as i64,
                (pb[1] * 10000.0).round() as i64,
            ];
            let sa = *snap_cache.entry(ka).or_insert_with(|| snap(pa));
            let sb = *snap_cache.entry(kb).or_insert_with(|| snap(pb));
            match (sa, sb) {
                (Some(a), Some(b)) => jobs.push((i, a, b)),
                _ => {
                    snap_fail += 1;
                    if sa.is_none() {
                        snap_fail_names.push(p.from.clone());
                    }
                    if sb.is_none() {
                        snap_fail_names.push(p.to.clone());
                    }
                }
            }
        }
        snap_fail_names.sort();
        snap_fail_names.dedup();
        println!(
            "snapped pairs: {} jobs, {} endpoint snap failures; stations failing snap: {:?}",
            jobs.len(),
            snap_fail,
            snap_fail_names
        );
        // parallel A* on 2 scoped threads
        let t_astar = std::time::Instant::now();
        let graph_ref = &graph;
        let run_jobs = |jobs: &[(usize, u32, u32)]| -> Vec<(usize, Option<(f64, bool)>)> {
            let mut gscore = vec![0.0f64; graph_ref.coords.len()];
            let mut stamp = vec![0u32; graph_ref.coords.len()];
            let mut fflag = vec![false; graph_ref.coords.len()];
            jobs.iter()
                .enumerate()
                .map(|(j, (i, a, b))| {
                    (
                        *i,
                        astar_ferry(
                            graph_ref,
                            *a,
                            *b,
                            &mut gscore,
                            &mut stamp,
                            &mut fflag,
                            (j + 1) as u32,
                        ),
                    )
                })
                .collect()
        };
        let mid = jobs.len() / 2;
        let (r1, r2) = std::thread::scope(|sc| {
            let h1 = sc.spawn(|| run_jobs(&jobs[..mid]));
            let h2 = sc.spawn(|| run_jobs(&jobs[mid..]));
            (h1.join().unwrap(), h2.join().unwrap())
        });
        let mut track_of: HashMap<usize, Option<(f64, bool)>> = HashMap::new();
        for (i, d) in r1.into_iter().chain(r2) {
            track_of.insert(i, d);
        }
        println!(
            "A* done: {:.1?} for {} pairs",
            t_astar.elapsed(),
            jobs.len()
        );
        // ---- classify pairs ----
        struct Routed {
            track: Option<f64>,
            status: String,
            flags: Vec<String>,
            gap: Option<f64>,
        }
        let in_jobs: HashSet<usize> = jobs.iter().map(|(i, _, _)| *i).collect();
        let mut results: Vec<Routed> = Vec::with_capacity(pair_list.len());
        for (i, (_k, p)) in pair_list.iter().enumerate() {
            let r = match track_of.get(&i).copied().flatten() {
                None => {
                    let st = if in_jobs.contains(&i) {
                        "unroutable"
                    } else {
                        "snap_fail"
                    };
                    Routed {
                        track: None,
                        status: st.to_string(),
                        flags: vec![st.to_string()],
                        gap: None,
                    }
                }
                Some((t, used_ferry)) => {
                    let ratio = t / p.chord;
                    let mut fl: Vec<String> = Vec::new();
                    if ratio < 0.97 {
                        fl.push("ratio_low".to_string());
                    }
                    if ratio > 1.40 {
                        fl.push("ratio_high".to_string());
                    }
                    if let Some(m) = p.min_leg_min {
                        if m > 0 && t / (m as f64 / 60.0) > 355.0 {
                            fl.push("speed_high".to_string());
                        }
                    }
                    if fl.is_empty() {
                        if used_ferry {
                            Routed {
                                track: Some(t),
                                status: "ferry".to_string(),
                                flags: vec!["ferry".to_string()],
                                gap: None,
                            }
                        } else {
                            Routed {
                                track: Some(t),
                                status: "ok".to_string(),
                                flags: fl,
                                gap: None,
                            }
                        }
                    } else {
                        if used_ferry {
                            fl.push("ferry".to_string());
                        }
                        Routed {
                            track: Some(t),
                            status: "flagged".to_string(),
                            flags: fl,
                            gap: None,
                        }
                    }
                }
            };
            results.push(r);
        }
        // ---- gap bridging for flagged / unroutable pairs ----
        // The extract's graph has small holes (a few km of unmapped or
        // unconnected track, e.g. ~5 km west of Emei). For pairs that failed
        // the audits, Dijkstra from both ends: if the two frontiers come
        // within 10 km of each other and the bridged distance passes the
        // same audits, accept it as an explicit "bridged" estimate.
        // Runs on 2 scoped threads; frontier matching iterates the smaller
        // frontier against a grid of the larger, with best-total pruning.
        {
            let snap_of: HashMap<usize, (u32, u32)> =
                jobs.iter().map(|(i, a, b)| (*i, (*a, *b))).collect();
            let candidates: Vec<usize> = (0..pair_list.len())
                .filter(|&i| {
                    matches!(results[i].status.as_str(), "flagged" | "unroutable")
                        && snap_of.contains_key(&i)
                })
                .collect();
            println!("gap bridging: {} candidate pairs", candidates.len());
            let graph_b = &graph;
            let pair_b = &pair_list;
            let snap_b = &snap_of;
            let bridge_jobs = |idxs: &[usize]| -> Vec<(usize, Option<(f64, f64)>)> {
                let mut dist1 = vec![0.0f64; graph_b.coords.len()];
                let mut stamp1 = vec![0u32; graph_b.coords.len()];
                let mut dist2 = vec![0.0f64; graph_b.coords.len()];
                let mut stamp2 = vec![0u32; graph_b.coords.len()];
                let mut vis_a: Vec<u32> = Vec::new();
                let mut vis_b: Vec<u32> = Vec::new();
                let mut run = 0u32;
                let mut out = Vec::with_capacity(idxs.len());
                for &i in idxs {
                    let p = &pair_b[i].1;
                    let (a, b) = snap_b[&i];
                    let radius = (p.chord * 1.2 + 15.0).min(130.0);
                    run += 1;
                    graph::dijkstra_limited(
                        graph_b,
                        a,
                        radius,
                        &mut dist1,
                        &mut stamp1,
                        run,
                        &mut vis_a,
                    );
                    run += 1;
                    graph::dijkstra_limited(
                        graph_b,
                        b,
                        radius,
                        &mut dist2,
                        &mut stamp2,
                        run,
                        &mut vis_b,
                    );
                    // iterate the smaller frontier, grid the larger one
                    let (small, big, d_small, d_big): (&Vec<u32>, &Vec<u32>, &Vec<f64>, &Vec<f64>) =
                        if vis_a.len() <= vis_b.len() {
                            (&vis_a, &vis_b, &dist1, &dist2)
                        } else {
                            (&vis_b, &vis_a, &dist2, &dist1)
                        };
                    let mut grid_big: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
                    for &v in big.iter() {
                        let c = graph_b.coords[v as usize];
                        grid_big
                            .entry(((c[0] * 20.0) as i32, (c[1] * 20.0) as i32))
                            .or_default()
                            .push(v);
                    }
                    let mut best: Option<(f64, f64)> = None;
                    'outer: for &u in small.iter() {
                        let du = d_small[u as usize];
                        if let Some((bt, _)) = best {
                            if du >= bt {
                                continue;
                            }
                        }
                        let cu = graph_b.coords[u as usize];
                        let (cx, cy) = ((cu[0] * 20.0) as i32, (cu[1] * 20.0) as i32);
                        for dx in -2..=2i32 {
                            for dy in -2..=2i32 {
                                if let Some(vs) = grid_big.get(&(cx + dx, cy + dy)) {
                                    for &v in vs {
                                        let dv = d_big[v as usize];
                                        if let Some((bt, _)) = best {
                                            if du + dv >= bt {
                                                continue;
                                            }
                                        }
                                        let gap = hav(cu, graph_b.coords[v as usize]);
                                        if gap <= 10.0 {
                                            let total = du + gap + dv;
                                            if best.map(|(bt, _)| total < bt).unwrap_or(true) {
                                                best = Some((total, gap));
                                                if gap <= 0.3 {
                                                    break 'outer;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    let accepted = best.and_then(|(total, gap)| {
                        let ratio_b = total / p.chord;
                        let speed_ok = match p.min_leg_min {
                            Some(m) if m > 0 => total / (m as f64 / 60.0) <= 355.0,
                            _ => true,
                        };
                        if (0.95..=1.45).contains(&ratio_b) && speed_ok {
                            Some((total, gap))
                        } else {
                            None
                        }
                    });
                    out.push((i, accepted));
                }
                out
            };
            let mid = candidates.len() / 2;
            let (r1, r2) = std::thread::scope(|sc| {
                let h1 = sc.spawn(|| bridge_jobs(&candidates[..mid]));
                let h2 = sc.spawn(|| bridge_jobs(&candidates[mid..]));
                (h1.join().unwrap(), h2.join().unwrap())
            });
            let mut bridged_count = 0usize;
            for (i, acc) in r1.into_iter().chain(r2) {
                if let Some((total, gap)) = acc {
                    results[i] = Routed {
                        track: Some(total),
                        status: "bridged".to_string(),
                        flags: vec!["gap_bridged".to_string()],
                        gap: Some(gap),
                    };
                    bridged_count += 1;
                }
            }
            println!("gap bridging repaired {} pairs", bridged_count);
        }
        // ---- counts, buckets, output ----
        #[derive(Default)]
        struct Bucket {
            ok: usize,
            bridged: usize,
            ferry: usize,
            flagged: usize,
            unroutable: usize,
        }
        let mut buckets: BTreeMap<String, Bucket> = BTreeMap::new();
        let mut out_pairs: Vec<serde_json::Value> = Vec::new();
        let mut n_ok = 0usize;
        let mut n_bridged = 0usize;
        let mut n_ferry = 0usize;
        let mut n_flag = 0usize;
        let mut n_unrout = 0usize;
        let mut worst: Vec<(f64, String, Vec<String>)> = Vec::new();
        for (i, (_k, p)) in pair_list.iter().enumerate() {
            let bucket_name = {
                let hsr = p.classes.iter().all(|c| c == "G" || c == "D");
                let conv = p
                    .classes
                    .iter()
                    .all(|c| c != "G" && c != "D" && c != "C" && c != "S");
                if hsr {
                    "hsr_only"
                } else if conv {
                    "conventional_only"
                } else {
                    "mixed"
                }
            };
            let bucket = buckets.entry(bucket_name.to_string()).or_default();
            let r = &results[i];
            match r.status.as_str() {
                "ok" => {
                    n_ok += 1;
                    bucket.ok += 1;
                }
                "bridged" => {
                    n_bridged += 1;
                    bucket.bridged += 1;
                }
                "ferry" => {
                    n_ferry += 1;
                    bucket.ferry += 1;
                }
                "flagged" => {
                    n_flag += 1;
                    bucket.flagged += 1;
                    worst.push((
                        r.track.unwrap_or(0.0) / p.chord,
                        format!("{} → {}", p.from, p.to),
                        r.flags.clone(),
                    ));
                }
                _ => {
                    n_unrout += 1;
                    bucket.unroutable += 1;
                }
            }
            out_pairs.push(serde_json::json!({
                "from": p.from, "to": p.to,
                "chord_km": (p.chord * 10.0).round() / 10.0,
                "track_km": r.track.map(|t| (t * 10.0).round() / 10.0),
                "ratio": r.track.map(|t| (t / p.chord * 1000.0).round() / 1000.0),
                "status": r.status,
                "flags": r.flags,
                "gap_km": r.gap.map(|g| (g * 10.0).round() / 10.0),
                "classes": p.classes.iter().collect::<Vec<_>>(),
                "uses": p.uses,
                "fastest_leg_min": p.min_leg_min,
            }));
        }
        worst.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        println!(
            "pairs: {} ok, {} bridged, {} ferry, {} flagged, {} unroutable/snap-fail",
            n_ok, n_bridged, n_ferry, n_flag, n_unrout
        );
        for (name, b) in &buckets {
            println!(
                "  {:<18} ok {}  bridged {}  ferry {}  flagged {}  unroutable {}",
                name, b.ok, b.bridged, b.ferry, b.flagged, b.unroutable
            );
        }
        for (r, name, fl) in worst.iter().take(12) {
            println!("  worst ratio {:.2}  {}  {:?}", r, name, fl);
        }
        // per-train aggregate: chord route vs track route (ok or bridged pairs,
        // flagged/unroutable fall back to chord). Keyed geographically.
        let pair_lookup: HashMap<[i64; 4], (f64, Option<f64>, bool)> = pair_list
            .iter()
            .enumerate()
            .map(|(i, (k, p))| {
                let t = results[i].track;
                let is_ok = matches!(results[i].status.as_str(), "ok" | "bridged" | "ferry");
                (*k, (p.chord, t, is_ok))
            })
            .collect();
        let mut changes: Vec<f64> = Vec::new();
        let mut fully_routed = 0usize;
        for (_code, _class, names, pts, _lm) in &retained {
            let mut chord_sum = 0.0;
            let mut track_sum = 0.0;
            let mut all_ok = true;
            let mut any = false;
            for i in 1..names.len() {
                if let (Some(a), Some(b)) = (pts[i - 1], pts[i]) {
                    if let Some((ch, tr, ok)) = pair_lookup.get(&key_of(a, b)) {
                        any = true;
                        chord_sum += ch;
                        if *ok {
                            track_sum += tr.unwrap();
                        } else {
                            track_sum += ch;
                            all_ok = false;
                        }
                    } else {
                        all_ok = false;
                    }
                }
            }
            if any && chord_sum > 0.0 {
                changes.push(track_sum / chord_sum);
                if all_ok {
                    fully_routed += 1;
                }
            }
        }
        changes.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if !changes.is_empty() {
            println!(
                "per-train track/chord route sum: median {:.3}  p10 {:.3}  p90 {:.3}  ({} trains, {} fully on ok/bridged pairs)",
                changes[changes.len() / 2],
                changes[changes.len() / 10],
                changes[changes.len() * 9 / 10],
                changes.len(),
                fully_routed
            );
        }
        let out_doc = serde_json::json!({
            "about": "Track-accurate distances for every unique consecutive stop pair in the 2026-10-21 timetables. A* over the OSM railway=rail graph (with <=250 m graph stitching across unshared-node mapping seams and short unmapped stretches, and railway=ferry links included as flagged edges) between snapped station points. status ok = passed ratio [0.97,1.40] and fastest-scheduled-speed <=355 km/h audits; ferry = passed the same audits but the path uses a train-ferry link for part of the way (a water crossing, e.g. the Qiongzhou strait — the distance includes the ferry leg); bridged = A* failed an audit but a small graph gap (<=10 km, gap_km) was bridged between Dijkstra frontiers and the bridged distance passed the same audits — an estimate across unmapped track; flagged = routed but failed an audit; unroutable/snap_fail = no path found.",
            "pairs": out_pairs,
        });
        let dest = out_file("pair_distances.json", derived.join("pair_distances.json"));
        fs::write(&dest, serde_json::to_string_pretty(&out_doc).unwrap()).unwrap();
        println!("pair distances written: {}", dest.display());
    }
}
