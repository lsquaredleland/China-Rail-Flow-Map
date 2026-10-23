// osm_export — convert the 12306 timetables into an OSM service
// layer (PTv2 route / route_master relations referencing real OSM station
// and track-way ids) plus a GTFS feed carrying the actual timetable
// (OSM has no timetable fields: the `departures` proposal was rejected;
// only duration / interval / opening_hours exist, so schedules live here).
//
// Inputs : china-rail-timetables-2026-10-21.json (deliverable)
//          pair_paths.json (track geometry per stop pair, from `paths`)
//          china-rail.osm (station elements + railway=rail ways)
//          osm_stations.json + station_resolution.json (station points)
//          stations.json (12306 telecodes)
// Outputs: china-rail-services-2026-10-21.osm, gtfs-2026-10-21/*.txt
#[path = "../graph.rs"]
// Shared routing module (src/graph.rs): each bin uses a different subset,
// so per-bin dead-code warnings for the unused parts are expected.
#[allow(dead_code)]
mod graph;
use graph::{attr, hav};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fmt::Write as _;
use std::path::PathBuf;

fn argval(flag: &str) -> Option<String> {
    let a: Vec<String> = env::args().collect();
    a.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
}
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn to_min(t: &str) -> Option<i64> {
    if t.is_empty() || t == "----" {
        return None;
    }
    let mut it = t.split(':');
    Some(it.next()?.parse::<i64>().ok()? * 60 + it.next()?.parse::<i64>().ok()?)
}

#[derive(Clone)]
struct Elem {
    kind: &'static str, // "node" | "way"
    id: u64,
    pt: [f64; 2],
    subway: bool,
}

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
            if hav(pts[i], pts[j]) <= 3.0 {
                let (pi, pj) = (find(&mut parent, i), find(&mut parent, j));
                if pi != pj {
                    parent[pi] = pj;
                }
            }
        }
    }
    let mut groups: BTreeMap<usize, Vec<[f64; 2]>> = BTreeMap::new();
    for i in 0..n {
        groups.entry(find(&mut parent, i)).or_default().push(pts[i]);
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

/// DP over a train's stop sequence: pick one candidate point per stop
/// minimizing total consecutive distance (same method as the analyzer).
fn resolve_train(
    stop_names: &[String],
    cand_map: &HashMap<String, Vec<[f64; 2]>>,
) -> Vec<Option<[f64; 2]>> {
    let mut out: Vec<Option<[f64; 2]>> = vec![None; stop_names.len()];
    let seq: Vec<(usize, &Vec<[f64; 2]>)> = stop_names
        .iter()
        .enumerate()
        .filter_map(|(i, n)| cand_map.get(n).map(|c| (i, c)))
        .collect();
    if seq.is_empty() {
        return out;
    }
    let mut dp: Vec<f64> = vec![0.0; seq[0].1.len()];
    let mut backs: Vec<Vec<usize>> = Vec::new();
    for k in 1..seq.len() {
        let prev = seq[k - 1].1;
        let cur = seq[k].1;
        let mut ndp = vec![0.0; cur.len()];
        let mut nback = vec![0usize; cur.len()];
        for (j, cp) in cur.iter().enumerate() {
            let (mut bi, mut bv) = (0usize, f64::INFINITY);
            for (i, pp) in prev.iter().enumerate() {
                let v = dp[i] + hav(*pp, *cp);
                if v < bv {
                    bv = v;
                    bi = i;
                }
            }
            ndp[j] = bv;
            nback[j] = bi;
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
    for (k, (idx, cands)) in seq.iter().enumerate() {
        out[*idx] = Some(cands[picks[k]]);
    }
    out
}

fn service_of(class: &str, overnight_long: bool) -> &'static str {
    match class {
        "G" => "high_speed",
        "D" => "long_distance",
        "C" => "regional",
        _ => {
            if overnight_long {
                "night"
            } else {
                "long_distance"
            }
        }
    }
}

fn main() {
    let data_dir = if let Ok(d) = env::var("CRFM_DATA_DIR") {
        PathBuf::from(d)
    } else if PathBuf::from("data").exists() {
        PathBuf::from("data")
    } else {
        PathBuf::from("../data")
    };
    let output_dir = if let Ok(d) = env::var("CRFM_OUTPUT_DIR") {
        PathBuf::from(d)
    } else if PathBuf::from("output").exists() {
        PathBuf::from("output")
    } else {
        PathBuf::from("../output")
    };
    let deliverable = PathBuf::from(argval("--in").unwrap_or_else(|| {
        output_dir
            .join("china-rail-timetables-2026-10-21.json")
            .display()
            .to_string()
    }));
    let pair_paths_path = PathBuf::from(argval("--paths").unwrap_or_else(|| {
        data_dir
            .join("derived/pair_paths.json")
            .display()
            .to_string()
    }));
    let osm_path = PathBuf::from(
        argval("--osm")
            .unwrap_or_else(|| data_dir.join("osm/china-rail.osm").display().to_string()),
    );
    let osm_out = PathBuf::from(argval("--osm-out").unwrap_or_else(|| {
        output_dir
            .join("china-rail-services-2026-10-21.osm")
            .display()
            .to_string()
    }));
    let gtfs_dir = PathBuf::from(
        argval("--gtfs-out")
            .unwrap_or_else(|| output_dir.join("gtfs-2026-10-21").display().to_string()),
    );

    // ---------- load timetable ----------
    let dj: Value = serde_json::from_str(&std::fs::read_to_string(&deliverable).unwrap()).unwrap();
    let date = dj["date"].as_str().unwrap_or("2026-10-21").to_string();
    let trains = dj["trains"].as_array().unwrap();
    println!("trains in deliverable: {}", trains.len());

    // ---------- station points ----------
    let st: Value =
        serde_json::from_str(&std::fs::read_to_string(data_dir.join("osm_stations.json")).unwrap())
            .unwrap();
    let mut cand_map: HashMap<String, Vec<[f64; 2]>> = HashMap::new();
    for (name, v) in st.as_object().unwrap() {
        let pts: Vec<[f64; 2]> = v
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        let p = p.as_array()?;
                        Some([p[0].as_f64()?, p[1].as_f64()?])
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !pts.is_empty() {
            cand_map.insert(name.clone(), clusters_of(&pts));
        }
    }
    let res: Value = serde_json::from_str(
        &std::fs::read_to_string(data_dir.join("station_resolution.json")).unwrap(),
    )
    .unwrap();
    for (name, v) in res.as_object().unwrap() {
        let pts: Vec<[f64; 2]> = v["clusters_chosen"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| {
                        let p = c["point"].as_array()?;
                        Some([p[0].as_f64()?, p[1].as_f64()?])
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !pts.is_empty() {
            cand_map.insert(name.clone(), pts);
        }
    }
    // telecodes
    let stj: Value =
        serde_json::from_str(&std::fs::read_to_string(data_dir.join("stations.json")).unwrap())
            .unwrap();
    let telecode: HashMap<String, String> = stj["byName"]
        .as_object()
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                .collect()
        })
        .unwrap_or_default();

    // ---------- pair paths ----------
    let pj: Value =
        serde_json::from_str(&std::fs::read_to_string(&pair_paths_path).unwrap()).unwrap();
    struct PP {
        status: String,
        segments: Vec<Vec<u64>>,
    }
    let mut pair_map: HashMap<(String, String), Vec<PP>> = HashMap::new();
    for p in pj["pairs"].as_array().unwrap() {
        let segs: Vec<Vec<u64>> = p["segments"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|s| {
                        s.as_array()
                            .map(|x| x.iter().filter_map(|n| n.as_u64()).collect())
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default();
        pair_map
            .entry((
                p["from"].as_str().unwrap().to_string(),
                p["to"].as_str().unwrap().to_string(),
            ))
            .or_default()
            .push(PP {
                status: p["status"].as_str().unwrap_or("").to_string(),
                segments: segs,
            });
    }
    println!(
        "pair path entries: {}",
        pair_map.values().map(|v| v.len()).sum::<usize>()
    );

    // ---------- stream china-rail.osm: coords, rail ways, station elements ----------
    let mut coords: HashMap<u64, [f64; 2]> = HashMap::new();
    let mut edge_ways: HashMap<(u64, u64), Vec<u64>> = HashMap::new();
    let mut station_elems: HashMap<String, Vec<Elem>> = HashMap::new();
    let mut station_way_pending: Vec<(u64, Vec<u64>, Vec<String>, bool)> = Vec::new();
    {
        let mut reader = Reader::from_file(&osm_path).expect("open china-rail.osm");
        let mut buf: Vec<u8> = Vec::with_capacity(1 << 16);
        #[derive(PartialEq)]
        enum Mode {
            None,
            Node,
            Way,
        }
        let mut mode = Mode::None;
        let mut cur_id: u64 = 0;
        let mut cur_pt = [0.0f64; 2];
        let mut names: Vec<String> = Vec::new();
        let mut railway = String::new();
        let mut subway = false;
        let mut refs: Vec<u64> = Vec::new();
        let push_station =
            |station_elems: &mut HashMap<String, Vec<Elem>>, names: &[String], e: Elem| {
                let mut keys: HashSet<String> = HashSet::new();
                for n in names {
                    keys.insert(n.clone());
                    keys.insert(format!("{}站", n));
                    if let Some(bare) = n.strip_suffix("站") {
                        keys.insert(bare.to_string());
                    }
                    if let Some(rest) = n.strip_prefix("香港") {
                        keys.insert(rest.to_string());
                        keys.insert(format!("{}站", rest));
                    }
                }
                for k in keys {
                    station_elems.entry(k).or_default().push(e.clone());
                }
            };
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Empty(e)) if e.name().as_ref() == b"node" => {
                    // tagless nodes arrive as empty events — still need coords
                    let id: u64 = attr(&e, "id").parse().unwrap_or(0);
                    coords.insert(
                        id,
                        [
                            attr(&e, "lat").parse().unwrap_or(0.0),
                            attr(&e, "lon").parse().unwrap_or(0.0),
                        ],
                    );
                }
                Ok(Event::Start(e)) if e.name().as_ref() == b"node" => {
                    mode = Mode::Node;
                    cur_id = attr(&e, "id").parse().unwrap_or(0);
                    cur_pt = [
                        attr(&e, "lat").parse().unwrap_or(0.0),
                        attr(&e, "lon").parse().unwrap_or(0.0),
                    ];
                    coords.insert(cur_id, cur_pt);
                    names.clear();
                    railway.clear();
                    subway = false;
                }
                Ok(Event::Start(e)) if e.name().as_ref() == b"way" => {
                    mode = Mode::Way;
                    cur_id = attr(&e, "id").parse().unwrap_or(0);
                    names.clear();
                    railway.clear();
                    subway = false;
                    refs.clear();
                }
                Ok(Event::Empty(e)) if e.name().as_ref() == b"nd" && mode == Mode::Way => {
                    if let Ok(r) = attr(&e, "ref").parse::<u64>() {
                        refs.push(r);
                    }
                }
                Ok(Event::Empty(e)) if e.name().as_ref() == b"tag" && mode != Mode::None => {
                    let k = attr(&e, "k");
                    let v = attr(&e, "v");
                    match k.as_str() {
                        "railway" => railway = v,
                        "station" if v == "subway" => subway = true,
                        "subway" if v == "yes" => subway = true,
                        "name" | "name:zh" | "name:zh-Hans" if !v.is_empty() => {
                            names.push(v);
                        }
                        _ => {}
                    }
                }
                Ok(Event::End(e)) if e.name().as_ref() == b"node" && mode == Mode::Node => {
                    mode = Mode::None;
                    if (railway == "station" || railway == "halt") && !names.is_empty() {
                        push_station(
                            &mut station_elems,
                            &names,
                            Elem {
                                kind: "node",
                                id: cur_id,
                                pt: cur_pt,
                                subway,
                            },
                        );
                    }
                }
                Ok(Event::End(e)) if e.name().as_ref() == b"way" && mode == Mode::Way => {
                    mode = Mode::None;
                    if railway == "rail" {
                        for w in refs.windows(2) {
                            let key = if w[0] < w[1] {
                                (w[0], w[1])
                            } else {
                                (w[1], w[0])
                            };
                            edge_ways.entry(key).or_default().push(cur_id);
                        }
                    } else if (railway == "station" || railway == "halt")
                        && !names.is_empty()
                        && !refs.is_empty()
                    {
                        station_way_pending.push((cur_id, refs.clone(), names.clone(), subway));
                    }
                }
                Ok(Event::Eof) => break,
                Err(e) => panic!("XML error: {:?}", e),
                _ => {}
            }
            buf.clear();
        }
        for (id, refs, names, subway) in &station_way_pending {
            let pts: Vec<[f64; 2]> = refs.iter().filter_map(|r| coords.get(r).copied()).collect();
            if pts.is_empty() {
                continue;
            }
            let pt = [
                pts.iter().map(|p| p[0]).sum::<f64>() / pts.len() as f64,
                pts.iter().map(|p| p[1]).sum::<f64>() / pts.len() as f64,
            ];
            push_station(
                &mut station_elems,
                names,
                Elem {
                    kind: "way",
                    id: *id,
                    pt,
                    subway: *subway,
                },
            );
        }
    }
    println!(
        "coords: {}, rail edges: {}, station names with elements: {}",
        coords.len(),
        edge_ways.len(),
        station_elems.len()
    );
    // cand_map override: points derived from the actual station elements
    // just streamed (osm_stations.json is a partial snapshot — it lacks
    // way-only stations like 榆社西 and 香港西九龙 entirely). The analyzer's
    // resolution choices for ambiguous names still win, applied last.
    {
        let mut added = 0usize;
        for (key, elems) in &station_elems {
            let pts: Vec<[f64; 2]> = elems.iter().filter(|e| !e.subway).map(|e| e.pt).collect();
            if !pts.is_empty() {
                cand_map.insert(key.clone(), clusters_of(&pts));
                added += 1;
            }
        }
        for (name, v) in res.as_object().unwrap() {
            let pts: Vec<[f64; 2]> = v["clusters_chosen"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|c| {
                            let p = c["point"].as_array()?;
                            Some([p[0].as_f64()?, p[1].as_f64()?])
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !pts.is_empty() {
                cand_map.insert(name.clone(), pts);
            }
        }
        println!(
            "cand_map: {} names after element override ({} element keys)",
            cand_map.len(),
            added
        );
    }

    // ---------- way-run extraction ----------
    let ways_for_segment = |nodes: &[u64]| -> (Vec<u64>, usize) {
        let mut runs: Vec<u64> = Vec::new();
        let mut uncovered = 0usize;
        let mut cur: Option<u64> = None;
        for i in 0..nodes.len().saturating_sub(1) {
            let (a, b) = (nodes[i], nodes[i + 1]);
            let key = if a < b { (a, b) } else { (b, a) };
            let cands: &[u64] = edge_ways.get(&key).map(|v| v.as_slice()).unwrap_or(&[]);
            if cands.is_empty() {
                uncovered += 1;
                cur = None;
                continue;
            }
            if let Some(c) = cur {
                if cands.contains(&c) {
                    continue;
                }
            }
            // pick the candidate covering the longest lookahead run
            let mut best: Option<(usize, u64)> = None;
            for &w in cands {
                let mut len = 0usize;
                for j in i..nodes.len().saturating_sub(1).min(i + 200) {
                    let (x, y) = (nodes[j], nodes[j + 1]);
                    let k2 = if x < y { (x, y) } else { (y, x) };
                    if edge_ways.get(&k2).map(|v| v.contains(&w)).unwrap_or(false) {
                        len += 1;
                    } else {
                        break;
                    }
                }
                if best.map(|(bl, _)| len > bl).unwrap_or(true) {
                    best = Some((len, w));
                }
            }
            let w = best.unwrap().1;
            if runs.last() != Some(&w) {
                runs.push(w);
            }
            cur = Some(w);
        }
        (runs, uncovered)
    };

    // ---------- per-train relations ----------
    struct RouteRec {
        rel_id: i64,
        code: String,
        class: String,
        from: String,
        to: String,
        master_key: String,
    }
    let mut xml = String::with_capacity(1 << 24);
    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    let _ = writeln!(
        xml,
        "<!-- China rail service layer (PTv2) generated from the 12306 timetables of {}.",
        date
    );
    xml.push_str("     Overlay file: relations reference EXISTING OSM station node/way ids and railway=rail way ids\n");
    xml.push_str("     from the China extract — merge with infrastructure data (e.g. in JOSM) before any use or upload.\n");
    xml.push_str("     OSM route relations carry no timetable (the departures proposal was rejected); the schedule\n");
    xml.push_str("     itself is in the companion GTFS feed (gtfs-2026-10-21/). duration = that day's first-departure\n");
    xml.push_str("     to last-arrival time. Legs whose track is unmapped in OSM are omitted from way members and the\n");
    xml.push_str("     relation is tagged note=geometry gap. -->\n");
    xml.push_str("<osm version=\"0.6\" generator=\"osm_export (analyze-rs)\">\n");

    let mut next_id: i64 = -1_000_000;
    let mut routes: Vec<RouteRec> = Vec::new();
    let mut legs_total = 0usize;
    let mut legs_with_path = 0usize;
    let mut legs_bridged = 0usize;
    let mut stop_members_missing = 0usize;
    let mut missing_names: HashMap<String, usize> = HashMap::new();
    let mut uncovered_edges = 0usize;
    let mut routes_full_ways = 0usize;
    // GTFS accumulators
    let mut gtfs_stop_pts: HashMap<String, Vec<[f64; 2]>> = HashMap::new();
    let mut gtfs_trips = String::new();
    let mut gtfs_stop_times = String::new();

    for t in trains {
        let code = t["code"].as_str().unwrap_or("").to_string();
        let train_no = t["train_no"].as_str().unwrap_or("").to_string();
        let class = t["class"].as_str().unwrap_or("").to_string();
        let stops = t["stops"].as_array().unwrap();
        // 12306 typesets a few names with internal spaces ("青  岛北"); the
        // analyzer stripped whitespace for all matching — do the same.
        let names: Vec<String> = stops
            .iter()
            .map(|s| {
                s["name"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect()
            })
            .collect();
        if names.len() < 2 {
            continue;
        }
        let pts = resolve_train(&names, &cand_map);
        for (nm, p) in names.iter().zip(pts.iter()) {
            if let Some(p) = p {
                gtfs_stop_pts.entry(nm.clone()).or_default().push(*p);
            }
        }
        // absolute times with day rollover
        let mut abs: Vec<(Option<i64>, Option<i64>)> = Vec::with_capacity(stops.len());
        let mut last = -1i64;
        let mut day = 0i64;
        for s in stops {
            let conv = |raw: &str, last: &mut i64, day: &mut i64| -> Option<i64> {
                let m = to_min(raw)?;
                let mut v = m + *day * 1440;
                while v < *last {
                    *day += 1;
                    v += 1440;
                }
                *last = v;
                Some(v)
            };
            let arr = conv(s["arrive"].as_str().unwrap_or(""), &mut last, &mut day);
            let dep = conv(s["depart"].as_str().unwrap_or(""), &mut last, &mut day);
            abs.push((arr, dep));
        }
        let start_abs = abs.first().and_then(|x| x.1.or(x.0));
        let end_abs = abs.last().and_then(|x| x.0.or(x.1));
        let duration_min = match (start_abs, end_abs) {
            (Some(a), Some(b)) if b >= a => Some(b - a),
            _ => None,
        };
        let overnight_long = duration_min
            .map(|d| d >= 300 && end_abs.unwrap_or(0) >= 1440)
            .unwrap_or(false);

        // station members
        let mut members = String::new();
        for (idx, nm) in names.iter().enumerate() {
            let chosen = (|| -> Option<Elem> {
                let elems = station_elems.get(nm)?;
                let pt = pts[idx]?;
                let mut pool: Vec<&Elem> = elems.iter().filter(|e| !e.subway).collect();
                if pool.is_empty() {
                    pool = elems.iter().collect();
                }
                pool.into_iter()
                    .min_by(|a, b| hav(a.pt, pt).partial_cmp(&hav(b.pt, pt)).unwrap())
                    .filter(|e| hav(e.pt, pt) <= 2.5)
                    .cloned()
            })();
            match chosen {
                Some(e) => {
                    let _ = writeln!(
                        members,
                        "  <member type=\"{}\" ref=\"{}\" role=\"stop\"/>",
                        e.kind, e.id
                    );
                }
                None => {
                    stop_members_missing += 1;
                    *missing_names.entry(nm.clone()).or_insert(0) += 1;
                }
            }
        }
        // way members
        let mut way_ids: Vec<u64> = Vec::new();
        let mut has_gap = false;
        let mut all_legs_path = true;
        for i in 1..names.len() {
            legs_total += 1;
            let cands = pair_map.get(&(names[i - 1].clone(), names[i].clone()));
            let chosen_pp = cands.and_then(|cs| {
                let (pa, pb) = (pts[i - 1], pts[i]);
                cs.iter().min_by(|x, y| {
                    let score = |pp: &PP| -> f64 {
                        if pp.segments.is_empty() {
                            return 1e9;
                        }
                        let first = pp.segments[0][0];
                        let last = pp.segments[pp.segments.len() - 1]
                            [pp.segments[pp.segments.len() - 1].len() - 1];
                        match (coords.get(&first), coords.get(&last), pa, pb) {
                            (Some(&a), Some(&b), Some(pa), Some(pb)) => hav(a, pa) + hav(b, pb),
                            _ => 1e8,
                        }
                    };
                    score(x).partial_cmp(&score(y)).unwrap()
                })
            });
            match chosen_pp {
                Some(pp) if !pp.segments.is_empty() => {
                    legs_with_path += 1;
                    if pp.status == "bridged" || pp.segments.len() > 1 {
                        legs_bridged += 1;
                        has_gap = true;
                    }
                    for seg in &pp.segments {
                        let (runs, unc) = ways_for_segment(seg);
                        uncovered_edges += unc;
                        for w in runs {
                            if way_ids.last() != Some(&w) {
                                way_ids.push(w);
                            }
                        }
                    }
                }
                _ => {
                    all_legs_path = false;
                    has_gap = true;
                }
            }
        }
        if all_legs_path {
            routes_full_ways += 1;
        }
        for w in &way_ids {
            let _ = writeln!(members, "  <member type=\"way\" ref=\"{}\" role=\"\"/>", w);
        }
        // master key: class + number pair (1,2),(3,4),...
        let digits: String = code
            .chars()
            .skip_while(|c| c.is_ascii_alphabetic())
            .collect();
        let master_key = if let Ok(num) = digits.parse::<i64>() {
            if num >= 1 {
                // pair (1,2),(3,4),... keyed by the pair's odd base number
                format!("{}{}", class, 2 * ((num - 1) / 2) + 1)
            } else {
                code.clone()
            }
        } else {
            code.clone()
        };
        let rel_id = next_id;
        next_id -= 1;
        let from = names.first().cloned().unwrap_or_default();
        let to = names.last().cloned().unwrap_or_default();
        let _ = writeln!(xml, "<relation id=\"{}\" version=\"1\">", rel_id);
        xml.push_str(&members);
        let _ = writeln!(xml, "  <tag k=\"type\" v=\"route\"/>");
        let _ = writeln!(xml, "  <tag k=\"route\" v=\"train\"/>");
        let _ = writeln!(xml, "  <tag k=\"public_transport:version\" v=\"2\"/>");
        let _ = writeln!(xml, "  <tag k=\"ref\" v=\"{}\"/>", esc(&code));
        let _ = writeln!(
            xml,
            "  <tag k=\"name\" v=\"{}\"/>",
            esc(&format!("{}: {} → {}", code, from, to))
        );
        let _ = writeln!(xml, "  <tag k=\"from\" v=\"{}\"/>", esc(&from));
        let _ = writeln!(xml, "  <tag k=\"to\" v=\"{}\"/>", esc(&to));
        let _ = writeln!(xml, "  <tag k=\"operator\" v=\"中国铁路\"/>");
        let _ = writeln!(xml, "  <tag k=\"network\" v=\"中国国家铁路\"/>");
        let _ = writeln!(
            xml,
            "  <tag k=\"service\" v=\"{}\"/>",
            service_of(&class, overnight_long)
        );
        if let Some(d) = duration_min {
            let _ = writeln!(
                xml,
                "  <tag k=\"duration\" v=\"{:02}:{:02}\"/>",
                d / 60,
                d % 60
            );
        }
        if from == to {
            let _ = writeln!(xml, "  <tag k=\"roundtrip\" v=\"yes\"/>");
        }
        if has_gap {
            let _ = writeln!(xml, "  <tag k=\"note\" v=\"geometry gap: one or more legs cross track unmapped in OSM; way members incomplete there\"/>");
        }
        let _ = writeln!(xml, "  <tag k=\"source\" v=\"CNR 12306 timetable\"/>");
        let _ = writeln!(xml, "  <tag k=\"source:date\" v=\"{}\"/>", esc(&date));
        xml.push_str("</relation>\n");
        routes.push(RouteRec {
            rel_id,
            code: code.clone(),
            class: class.clone(),
            from: from.clone(),
            to: to.clone(),
            master_key: master_key.clone(),
        });

        // GTFS rows for this train
        let route_id = master_key.replace('/', "_");
        let _ = writeln!(
            gtfs_trips,
            "{},{},D{},{},{},",
            train_no,
            route_id,
            date.replace('-', ""),
            code,
            to
        );
        for (idx, s) in stops.iter().enumerate() {
            let nm = &names[idx];
            let stop_id = telecode.get(nm).cloned().unwrap_or_else(|| nm.clone());
            let (arr, dep) = abs[idx];
            let fmt = |v: Option<i64>| -> String {
                match v {
                    Some(v) => format!("{:02}:{:02}:00", v / 60, v % 60),
                    None => String::new(),
                }
            };
            let arr_s = fmt(arr.or(dep));
            let dep_s = fmt(dep.or(arr));
            let _ = writeln!(
                gtfs_stop_times,
                "{},{},{},{},{}",
                train_no,
                arr_s,
                dep_s,
                stop_id,
                idx + 1
            );
            let _ = s;
        }
    }

    // ---------- route masters ----------
    let mut masters: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, r) in routes.iter().enumerate() {
        masters.entry(r.master_key.clone()).or_default().push(i);
    }
    let mut gtfs_routes = String::new();
    for (key, idxs) in &masters {
        let mut codes: Vec<String> = idxs.iter().map(|&i| routes[i].code.clone()).collect();
        codes.sort();
        codes.dedup();
        let refname = codes.join("/");
        // most common unordered OD pair
        let mut od: HashMap<(String, String), usize> = HashMap::new();
        for &i in idxs {
            let r = &routes[i];
            let k = if r.from <= r.to {
                (r.from.clone(), r.to.clone())
            } else {
                (r.to.clone(), r.from.clone())
            };
            *od.entry(k).or_insert(0) += 1;
        }
        let (a, b) = od
            .into_iter()
            .max_by_key(|(_, c)| *c)
            .map(|(k, _)| k)
            .unwrap_or_default();
        let rel_id = next_id;
        next_id -= 1;
        let _ = writeln!(xml, "<relation id=\"{}\" version=\"1\">", rel_id);
        for &i in idxs {
            let _ = writeln!(
                xml,
                "  <member type=\"relation\" ref=\"{}\" role=\"\"/>",
                routes[i].rel_id
            );
        }
        let class = &routes[idxs[0]].class;
        let _ = writeln!(xml, "  <tag k=\"type\" v=\"route_master\"/>");
        let _ = writeln!(xml, "  <tag k=\"route_master\" v=\"train\"/>");
        let _ = writeln!(xml, "  <tag k=\"ref\" v=\"{}\"/>", esc(&refname));
        let _ = writeln!(
            xml,
            "  <tag k=\"name\" v=\"{}\"/>",
            esc(&format!("{}: {} ↔ {}", refname, a, b))
        );
        let _ = writeln!(xml, "  <tag k=\"operator\" v=\"中国铁路\"/>");
        let _ = writeln!(xml, "  <tag k=\"network\" v=\"中国国家铁路\"/>");
        let _ = writeln!(
            xml,
            "  <tag k=\"service\" v=\"{}\"/>",
            service_of(class, false)
        );
        xml.push_str("</relation>\n");
        let _ = writeln!(
            gtfs_routes,
            "{},中国铁路,{},,,2,,,",
            key.replace('/', "_"),
            refname
        );
    }
    xml.push_str("</osm>\n");
    std::fs::write(&osm_out, &xml).unwrap();

    // ---------- GTFS files ----------
    std::fs::create_dir_all(&gtfs_dir).unwrap();
    std::fs::write(gtfs_dir.join("agency.txt"), "agency_id,agency_name,agency_url,agency_timezone,agency_lang\nCNR,中国铁路,https://www.12306.cn,Asia/Shanghai,zh\n").unwrap();
    let mut stops_txt = String::from("stop_id,stop_name,stop_lat,stop_lon\n");
    let csv = |s: &str| -> String {
        if s.contains(',') || s.contains('"') {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    };
    let mut stop_names: Vec<&String> = gtfs_stop_pts.keys().collect();
    stop_names.sort();
    for nm in stop_names {
        let ptsv = &gtfs_stop_pts[nm];
        // most common resolved point (rounded to 3dp) wins
        let mut cnt: HashMap<(i64, i64), (usize, [f64; 2])> = HashMap::new();
        for p in ptsv {
            let k = (
                (p[0] * 1000.0).round() as i64,
                (p[1] * 1000.0).round() as i64,
            );
            let e = cnt.entry(k).or_insert((0, *p));
            e.0 += 1;
        }
        let pt = cnt
            .values()
            .max_by_key(|(c, _)| *c)
            .map(|(_, p)| *p)
            .unwrap();
        let stop_id = telecode.get(nm).cloned().unwrap_or_else(|| nm.clone());
        let _ = writeln!(
            stops_txt,
            "{},{},{:.6},{:.6}",
            csv(&stop_id),
            csv(nm),
            pt[0],
            pt[1]
        );
    }
    std::fs::write(gtfs_dir.join("stops.txt"), stops_txt).unwrap();
    std::fs::write(gtfs_dir.join("routes.txt"), format!("route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n{}", gtfs_routes)).unwrap();
    std::fs::write(
        gtfs_dir.join("trips.txt"),
        format!(
            "trip_id,route_id,service_id,trip_short_name,trip_headsign,direction_id\n{}",
            gtfs_trips
        ),
    )
    .unwrap();
    std::fs::write(
        gtfs_dir.join("stop_times.txt"),
        format!(
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n{}",
            gtfs_stop_times
        ),
    )
    .unwrap();
    let dnum = date.replace('-', "");
    std::fs::write(
        gtfs_dir.join("calendar_dates.txt"),
        format!("service_id,date,exception_type\nD{},{},1\n", dnum, dnum),
    )
    .unwrap();

    println!(
        "routes written: {} ({} with complete way members)",
        routes.len(),
        routes_full_ways
    );
    println!("route masters: {}", masters.len());
    println!(
        "legs: {} total, {} with track path, {} bridged (gap)",
        legs_total, legs_with_path, legs_bridged
    );
    println!(
        "stop members missing (no OSM station element within 2.5 km): {}",
        stop_members_missing
    );
    let mut mn: Vec<(&String, &usize)> = missing_names.iter().collect();
    mn.sort_by(|a, b| b.1.cmp(a.1));
    println!("missing by name (top 20): {:?}", &mn[..mn.len().min(20)]);
    println!(
        "uncovered path edges (no way contains them): {}",
        uncovered_edges
    );
    println!(
        "wrote {} ({:.1} MB) and GTFS in {}",
        osm_out.display(),
        xml.len() as f64 / 1e6,
        gtfs_dir.display()
    );
}
