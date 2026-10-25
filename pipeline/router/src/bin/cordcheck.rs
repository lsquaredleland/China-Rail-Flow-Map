// cordcheck — explain a "cord inside a cord": list one origin's outbound
// atlas sections passing near a point, how far apart they run, which
// OSM track (nodes, line names) each lies on, and which station-pair
// geometries (production pair_paths, router leg paths) feed it.
// Usage: cordcheck --atlas <v1.json> --origin <zh> --at <lon,lat>
//                  [--radius <km>] [--project <dir>] [--legs <leg_paths.json>]
use corridor_router::graph::{self, hav, FineIndex, Graph};
use corridor_router::{china, config};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

fn argval(flag: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
}

fn decode(s: &str) -> Vec<[f64; 2]> {
    let b = s.as_bytes();
    let (mut i, mut lat, mut lng) = (0usize, 0i64, 0i64);
    let mut out = Vec::new();
    let next = |i: &mut usize| -> i64 {
        let (mut r, mut sh) = (0i64, 0);
        loop {
            let c = b[*i] as i64 - 63;
            *i += 1;
            r |= (c & 0x1f) << sh;
            sh += 5;
            if c < 0x20 {
                break;
            }
        }
        if r & 1 != 0 {
            !(r >> 1)
        } else {
            r >> 1
        }
    };
    while i < b.len() {
        lat += next(&mut i);
        lng += next(&mut i);
        out.push([lat as f64 / 1e5, lng as f64 / 1e5]);
    }
    out
}

/// Points every ~50 m along a polyline ([lat, lon]).
fn densify(pts: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    for w in pts.windows(2) {
        let n = (hav(w[0], w[1]) / 0.05).ceil().max(1.0) as usize;
        for k in 0..n {
            let t = k as f64 / n as f64;
            out.push([
                w[0][0] + (w[1][0] - w[0][0]) * t,
                w[0][1] + (w[1][1] - w[0][1]) * t,
            ]);
        }
    }
    out.extend(pts.last());
    out
}

fn nearest(p: [f64; 2], pts: &[[f64; 2]]) -> f64 {
    pts.iter().map(|q| hav(p, *q)).fold(f64::INFINITY, f64::min)
}

/// Share of `a`'s samples within `km` of polyline samples `b`.
fn covered(a: &[[f64; 2]], b: &[[f64; 2]], km: f64) -> f64 {
    let mut grid: HashMap<(i32, i32), Vec<[f64; 2]>> = HashMap::new();
    for p in b {
        grid.entry(((p[0] * 1000.0) as i32, (p[1] * 1000.0) as i32))
            .or_default()
            .push(*p);
    }
    let n = a
        .iter()
        .filter(|p| {
            let (cx, cy) = ((p[0] * 1000.0) as i32, (p[1] * 1000.0) as i32);
            (-1..=1).any(|dx| {
                (-1..=1).any(|dy| {
                    grid.get(&(cx + dx, cy + dy))
                        .is_some_and(|v| v.iter().any(|q| hav(**p, *q) <= km))
                })
            })
        })
        .count();
    n as f64 / a.len().max(1) as f64
}

fn main() {
    let atlas: Value =
        serde_json::from_str(&fs::read_to_string(argval("--atlas").unwrap()).unwrap()).unwrap();
    let origin = argval("--origin").unwrap();
    let at: Vec<f64> = argval("--at")
        .unwrap()
        .split(',')
        .map(|x| x.parse().unwrap())
        .collect();
    let at = [at[1], at[0]];
    let radius: f64 = argval("--radius")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.5);
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

    let st = atlas["station_table"].as_array().unwrap();
    let sname = |i: &Value| -> String {
        i.as_u64()
            .and_then(|i| st.get(i as usize))
            .and_then(|s| s["zh"].as_str().or_else(|| s.as_str()))
            .unwrap_or("?")
            .to_string()
    };
    let secs = atlas["sections"].as_array().unwrap();
    let o = atlas["origins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["zh"] == origin.as_str())
        .expect("origin");
    let mut near: Vec<(usize, i64, Vec<[f64; 2]>)> = Vec::new();
    for f in o["flows"].as_array().unwrap() {
        let (si, n) = (f[0].as_u64().unwrap() as usize, f[1].as_i64().unwrap());
        let pts = densify(&decode(secs[si]["g"].as_str().unwrap()));
        if nearest(at, &pts) <= radius {
            near.push((si, n, pts));
        }
    }
    near.sort_by_key(|x| -x.1);
    println!("== {origin} outbound sections within {radius} km of {at:?}");
    for (si, n, pts) in &near {
        let km: f64 = pts.windows(2).map(|w| hav(w[0], w[1])).sum();
        println!(
            "  section {si:>5}: {n:>4} trains/day  {} -> {}  {km:.1} km  (passes {:.0} m from point)",
            sname(&secs[*si]["a"]),
            sname(&secs[*si]["b"]),
            nearest(at, pts) * 1000.0
        );
    }
    println!("== pairwise: share of A within 30 m / 150 m of B");
    for (ai, an, ap) in &near {
        for (bi, bn, bp) in &near {
            if ai != bi {
                println!(
                    "  {ai}({an}) on {bi}({bn}): {:.0}% / {:.0}%",
                    covered(ap, bp, 0.03) * 100.0,
                    covered(ap, bp, 0.15) * 100.0
                );
            }
        }
    }

    // ---- which OSM track: nearest graph nodes + line names ----
    let osm_path = argval("--osm").map(PathBuf::from).unwrap_or_else(|| {
        if data.join("osm/china-rail.osm").exists() {
            data.join("osm/china-rail.osm")
        } else {
            project.join("china-rail.osm")
        }
    });
    let g: Graph = graph::build(&osm_path, &config::get().network);
    let fine = FineIndex::new(&g);
    let mut node_sets: Vec<HashSet<u32>> = Vec::new();
    for (si, n, pts) in &near {
        let mut nodes: HashSet<u32> = HashSet::new();
        let mut lines: BTreeMap<String, usize> = BTreeMap::new();
        for p in pts.iter().step_by(4) {
            if let Some(v) = fine.near(&g, *p, 0.03).min_by(|a, b| {
                hav(*p, g.coords[*a as usize]).total_cmp(&hav(*p, g.coords[*b as usize]))
            }) {
                nodes.insert(v);
                for e in &g.adj[v as usize] {
                    if e.line != graph::NO_LINE {
                        *lines.entry(g.lines[e.line as usize].clone()).or_default() += 1;
                    }
                }
            }
        }
        let mut lv: Vec<(String, usize)> = lines.into_iter().collect();
        lv.sort_by_key(|x| std::cmp::Reverse(x.1));
        lv.truncate(4);
        println!(
            "  section {si} ({n}): {} distinct track nodes within 30 m; lines {:?}",
            nodes.len(),
            lv
        );
        node_sets.push(nodes);
    }
    for i in 0..node_sets.len() {
        for j in i + 1..node_sets.len() {
            let shared = node_sets[i].intersection(&node_sets[j]).count();
            println!(
                "  sections {} & {}: {} shared track nodes of {} / {}",
                near[i].0,
                near[j].0,
                shared,
                node_sets[i].len(),
                node_sets[j].len()
            );
        }
    }

    // ---- which station-pair geometries feed each section ----
    let base = china::load_base_paths(&[
        &data.join("derived/pair_paths.json"),
        &data.join("derived/cs_out/pair_paths.json"),
    ]);
    // (name, densified points, exact graph nodes)
    let mut geoms: Vec<(String, Vec<[f64; 2]>, HashSet<u32>)> = Vec::new();
    let to_nodes = |segs: &[Vec<u64>]| -> HashSet<u32> {
        segs.iter()
            .flatten()
            .filter_map(|id| g.index_of(*id))
            .collect()
    };
    let to_pts = |segs: &[Vec<u64>]| -> Vec<[f64; 2]> {
        segs.iter()
            .flatten()
            .filter_map(|id| g.index_of(*id).map(|i| g.coords[i as usize]))
            .collect()
    };
    let bbox_hit = |pts: &[[f64; 2]]| pts.iter().any(|p| hav(*p, at) < 30.0);
    for ((a, b), (status, segs)) in &base {
        let pts = to_pts(segs);
        if bbox_hit(&pts) {
            geoms.push((
                format!("production {a}-{b} [{status}]"),
                densify(&pts),
                to_nodes(segs),
            ));
        }
    }
    if let Some(lp) = argval("--legs") {
        let v: Value = serde_json::from_str(&fs::read_to_string(lp).unwrap()).unwrap();
        let mut seen: HashSet<String> = HashSet::new();
        for r in v.as_array().unwrap() {
            let id = r["id"].as_str().unwrap().to_string();
            if !seen.insert(id.clone()) {
                continue;
            }
            let segs: Vec<Vec<u64>> = r["segments"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| {
                    s.as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|x| x.as_u64())
                        .collect()
                })
                .collect();
            let pts = to_pts(&segs);
            if bbox_hit(&pts) {
                geoms.push((
                    format!(
                        "router {}-{} {} [{}]",
                        r["from"], r["to"], id, r["decision"]
                    ),
                    densify(&pts),
                    to_nodes(&segs),
                ));
            }
        }
    }
    // which physical track each geometry uses at the point: signed
    // offset (m) of its nearest node from the widest section's line
    let (_, _, wp) = &near[0];
    let j = (0..wp.len())
        .min_by(|a, b| hav(wp[*a], at).total_cmp(&hav(wp[*b], at)))
        .unwrap();
    let (p0, p1) = (wp[j.saturating_sub(3)], wp[(j + 3).min(wp.len() - 1)]);
    let side = |q: [f64; 2]| -> f64 {
        // cross product in a local metric frame, metres
        let k = (p0[0].to_radians()).cos();
        let (dx, dy) = ((p1[1] - p0[1]) * k, p1[0] - p0[0]);
        let (qx, qy) = ((q[1] - p0[1]) * k, q[0] - p0[0]);
        let len = (dx * dx + dy * dy).sqrt();
        (dx * qy - dy * qx) / len * 111_000.0
    };
    // snap the probe onto real high-speed track (the atlas line is simplified)
    let snap_at = (0..g.coords.len() as u32)
        .filter(|&v| hav(g.coords[v as usize], at) < 3.0)
        .filter(|&v| {
            g.adj[v as usize]
                .iter()
                .any(|e| e.flags & graph::F_HSR != 0)
        })
        .min_by(|a, b| hav(g.coords[*a as usize], at).total_cmp(&hav(g.coords[*b as usize], at)))
        .map(|v| g.coords[v as usize])
        .unwrap_or(at);
    println!(
        "probe snapped {:.0} m to track at {snap_at:?}",
        hav(snap_at, at) * 1000.0
    );
    let at = snap_at;
    let mut by_track: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for (name, _, gn) in &geoms {
        let Some(&v) = gn.iter().min_by(|a, b| {
            hav(g.coords[**a as usize], at).total_cmp(&hav(g.coords[**b as usize], at))
        }) else {
            continue;
        };
        if hav(g.coords[v as usize], at) > 0.3 {
            continue;
        }
        let off = side(g.coords[v as usize]);
        by_track
            .entry((off / 3.0).round() as i64 * 3)
            .or_default()
            .push(name.clone());
    }
    println!("== geometries at the point, grouped by track offset from the main line (m)");
    for (off, names) in &by_track {
        println!("  offset {off:>4} m: {} geometries", names.len());
        for n in names {
            println!("      {n}");
        }
    }
}
