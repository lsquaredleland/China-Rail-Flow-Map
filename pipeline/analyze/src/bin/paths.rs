// paths — emit track geometry for every routed stop pair in
// pair_distances.json, as OSM node-id sequences (the missing piece for
// building OSM route relations and for drawing trains on track).
//
//   ok/ferry  -> A* path between snapped station nodes (a ferry pair's
//                path includes the train-ferry link geometry)
//   bridged   -> Dijkstra frontier paths from both ends (2 segments; the
//                gap between segment end/start is the unmapped stretch)
//   via_chain -> stitched sub-pair segments from chain_via
//   flagged / unroutable / snap_fail -> no segments (chord only, by design)
//
// Usage: paths [--osm <path>] [--pairs <path>] [--stations <path>] [--out <path>]
#[path = "../graph.rs"]
// Shared routing module (src/graph.rs): each bin uses a different subset,
// so per-bin dead-code warnings for the unused parts are expected.
#[allow(dead_code)]
mod graph;
use graph::{astar_path, build_graph, dijkstra_parents, hav, reconstruct, Graph};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;

type Segs = Vec<Vec<u32>>;

fn argval(flag: &str) -> Option<String> {
    let a: Vec<String> = env::args().collect();
    a.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
}

struct Pair {
    from: String,
    to: String,
    chord: f64,
    track: Option<f64>,
    status: String,
    chain_via: Vec<String>,
    pa: [f64; 2],
    pb: [f64; 2],
}

fn snap_fn<'a>(
    g: &'a Graph,
    grid: &'a HashMap<(i32, i32), Vec<u32>>,
) -> impl Fn([f64; 2]) -> Option<u32> + 'a {
    move |pt: [f64; 2]| -> Option<u32> {
        let (cx, cy) = ((pt[0] * 50.0) as i32, (pt[1] * 50.0) as i32);
        let mut best: Option<(f64, u32)> = None;
        for ring in 0..=3i32 {
            for dx in -ring..=ring {
                for dy in -ring..=ring {
                    if ring > 0 && dx.abs() != ring && dy.abs() != ring {
                        continue;
                    }
                    if let Some(nodes) = grid.get(&(cx + dx, cy + dy)) {
                        for &n in nodes {
                            let d = hav(pt, g.coords[n as usize]);
                            if best.map(|(bd, _)| d < bd).unwrap_or(true) {
                                best = Some((d, n));
                            }
                        }
                    }
                }
            }
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
    let osm_path = PathBuf::from(
        argval("--osm")
            .unwrap_or_else(|| data_dir.join("osm/china-rail.osm").display().to_string()),
    );
    let pairs_path = PathBuf::from(argval("--pairs").unwrap_or_else(|| {
        data_dir
            .join("derived/pair_distances.json")
            .display()
            .to_string()
    }));
    let stations_path = PathBuf::from(
        argval("--stations")
            .unwrap_or_else(|| data_dir.join("osm_stations.json").display().to_string()),
    );
    let resolution_path = PathBuf::from(argval("--resolution").unwrap_or_else(|| {
        data_dir
            .join("station_resolution.json")
            .display()
            .to_string()
    }));
    let out_path = PathBuf::from(argval("--out").unwrap_or_else(|| {
        data_dir
            .join("derived/pair_paths.json")
            .display()
            .to_string()
    }));

    // ---- station points: cluster osm_stations candidates (3 km, same as
    // the analyzer); names in station_resolution.json use the analyzer's
    // per-train chosen clusters instead ----
    let st: Value =
        serde_json::from_str(&std::fs::read_to_string(&stations_path).unwrap()).unwrap();
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
        let mut groups: std::collections::BTreeMap<usize, Vec<[f64; 2]>> =
            std::collections::BTreeMap::new();
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
    let mut clusters: HashMap<String, Vec<[f64; 2]>> = HashMap::new();
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
            clusters.insert(name.clone(), clusters_of(&pts));
        }
    }
    if let Ok(txt) = std::fs::read_to_string(&resolution_path) {
        let res: Value = serde_json::from_str(&txt).unwrap();
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
                clusters.insert(name.clone(), pts);
            }
        }
    }

    // ---- graph + snap (built before pair points are chosen: the choice
    // below is snap-aware) ----
    let g = build_graph(&osm_path);
    let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for (i, c) in g.coords.iter().enumerate() {
        grid.entry(((c[0] * 50.0) as i32, (c[1] * 50.0) as i32))
            .or_default()
            .push(i as u32);
    }
    let snap = snap_fn(&g, &grid);

    // ---- pairs ----
    let pj: Value = serde_json::from_str(&std::fs::read_to_string(&pairs_path).unwrap()).unwrap();
    let mut pairs: Vec<Pair> = Vec::new();
    let mut no_pts = 0usize;
    for p in pj["pairs"].as_array().unwrap() {
        let from = p["from"].as_str().unwrap().to_string();
        let to = p["to"].as_str().unwrap().to_string();
        let chord = p["chord_km"].as_f64().unwrap_or(0.0);
        let (ca, cb) = match (clusters.get(&from), clusters.get(&to)) {
            (Some(a), Some(b)) => (a, b),
            _ => {
                no_pts += 1;
                continue;
            }
        };
        // choose the cluster combo whose crow-flies distance matches
        // chord; if any combo's endpoints both snap to the graph, restrict
        // the choice to those (a stale same-name candidate can match the
        // chord better while being unroutable — e.g. the defunct
        // Quanzhou East on the abandoned Zhangquan line)
        let mut best: Option<(f64, [f64; 2], [f64; 2])> = None;
        let mut best_snapping: Option<(f64, [f64; 2], [f64; 2])> = None;
        for &a in ca {
            for &b in cb {
                let err = (hav(a, b) - chord).abs();
                if best.map(|(e, _, _)| err < e).unwrap_or(true) {
                    best = Some((err, a, b));
                }
                if snap(a).is_some()
                    && snap(b).is_some()
                    && best_snapping.map(|(e, _, _)| err < e).unwrap_or(true)
                {
                    best_snapping = Some((err, a, b));
                }
            }
        }
        let (_, pa, pb) = best_snapping.or(best).unwrap();
        pairs.push(Pair {
            chain_via: p["chain_via"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default(),
            from,
            to,
            chord,
            track: p["track_km"].as_f64(),
            status: p["status"].as_str().unwrap_or("").to_string(),
            pa,
            pb,
        });
    }
    println!(
        "pairs: {} ({} skipped, station points missing)",
        pairs.len(),
        no_pts
    );

    let snaps: Vec<(Option<u32>, Option<u32>)> =
        pairs.iter().map(|p| (snap(p.pa), snap(p.pb))).collect();

    let n = g.coords.len();
    let mut results: Vec<Option<Segs>> = (0..pairs.len()).map(|_| None).collect();

    // ---- phase A: ok pairs via A* (2 threads) ----
    let ok_idx: Vec<usize> = (0..pairs.len())
        .filter(|&i| matches!(pairs[i].status.as_str(), "ok" | "ferry"))
        .collect();
    let run_ok = |idxs: &[usize]| -> Vec<(usize, Segs)> {
        let mut gs = vec![0.0f64; n];
        let mut st_ = vec![0u32; n];
        let mut par = vec![0u32; n];
        let mut run = 0u32;
        let mut out = Vec::new();
        for &i in idxs {
            if let (Some(a), Some(b)) = snaps[i] {
                run += 1;
                if let Some((_d, path)) = astar_path(&g, a, b, &mut gs, &mut st_, &mut par, run) {
                    out.push((i, vec![path]));
                }
            }
        }
        out
    };
    let mid = ok_idx.len() / 2;
    let (r1, r2) = std::thread::scope(|sc| {
        let h1 = sc.spawn(|| run_ok(&ok_idx[..mid]));
        let h2 = sc.spawn(|| run_ok(&ok_idx[mid..]));
        (h1.join().unwrap(), h2.join().unwrap())
    });
    let mut ok_done = 0usize;
    for (i, segs) in r1.into_iter().chain(r2) {
        results[i] = Some(segs);
        ok_done += 1;
    }
    println!("phase A (ok): {}/{} routed", ok_done, ok_idx.len());

    // ---- phase C: bridged pairs via Dijkstra frontiers (2 threads) ----
    let br_idx: Vec<usize> = (0..pairs.len())
        .filter(|&i| pairs[i].status == "bridged")
        .collect();
    let run_br = |idxs: &[usize]| -> Vec<(usize, Segs, f64)> {
        let mut d1 = vec![0.0f64; n];
        let mut s1 = vec![0u32; n];
        let mut p1 = vec![0u32; n];
        let mut d2 = vec![0.0f64; n];
        let mut s2 = vec![0u32; n];
        let mut p2 = vec![0u32; n];
        let mut vis_a: Vec<u32> = Vec::new();
        let mut vis_b: Vec<u32> = Vec::new();
        let mut run = 0u32;
        let mut out = Vec::new();
        for &i in idxs {
            let (a, b) = match snaps[i] {
                (Some(a), Some(b)) => (a, b),
                _ => continue,
            };
            let radius = (pairs[i].chord * 1.2 + 15.0).min(130.0);
            run += 1;
            dijkstra_parents(&g, a, radius, &mut d1, &mut s1, &mut p1, run, &mut vis_a);
            run += 1;
            dijkstra_parents(&g, b, radius, &mut d2, &mut s2, &mut p2, run, &mut vis_b);
            // grid the B frontier, scan A frontier with best-total pruning
            let mut grid_b: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
            for &v in &vis_b {
                let c = g.coords[v as usize];
                grid_b
                    .entry(((c[0] * 20.0) as i32, (c[1] * 20.0) as i32))
                    .or_default()
                    .push(v);
            }
            let mut best: Option<(f64, f64, u32, u32)> = None;
            for &u in &vis_a {
                let du = d1[u as usize];
                if let Some((bt, _, _, _)) = best {
                    if du >= bt {
                        continue;
                    }
                }
                let cu = g.coords[u as usize];
                let (cx, cy) = ((cu[0] * 20.0) as i32, (cu[1] * 20.0) as i32);
                for dx in -2..=2i32 {
                    for dy in -2..=2i32 {
                        if let Some(vs) = grid_b.get(&(cx + dx, cy + dy)) {
                            for &v in vs {
                                let dv = d2[v as usize];
                                if let Some((bt, _, _, _)) = best {
                                    if du + dv >= bt {
                                        continue;
                                    }
                                }
                                let gap = hav(cu, g.coords[v as usize]);
                                if gap <= 10.0 {
                                    let total = du + gap + dv;
                                    if best.map(|(bt, _, _, _)| total < bt).unwrap_or(true) {
                                        best = Some((total, gap, u, v));
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if let Some((_total, gap, u, v)) = best {
                let seg_a = reconstruct(&p1, a, u);
                let mut seg_b = reconstruct(&p2, b, v);
                seg_b.reverse(); // v..b in travel direction
                out.push((i, vec![seg_a, seg_b], gap));
            }
        }
        out
    };
    let mid = br_idx.len() / 2;
    let (r1, r2) = std::thread::scope(|sc| {
        let h1 = sc.spawn(|| run_br(&br_idx[..mid]));
        let h2 = sc.spawn(|| run_br(&br_idx[mid..]));
        (h1.join().unwrap(), h2.join().unwrap())
    });
    let mut br_done = 0usize;
    let mut gaps: HashMap<usize, f64> = HashMap::new();
    for (i, segs, gap) in r1.into_iter().chain(r2) {
        results[i] = Some(segs);
        gaps.insert(i, gap);
        br_done += 1;
    }
    println!("phase C (bridged): {}/{} routed", br_done, br_idx.len());

    // ---- phase B: via_chain stitching ----
    // name-pair -> candidate entry indices (homonyms disambiguated by geometry)
    let mut by_names: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (i, p) in pairs.iter().enumerate() {
        by_names
            .entry((p.from.clone(), p.to.clone()))
            .or_default()
            .push(i);
    }
    #[allow(clippy::too_many_arguments)]
    fn stitch(
        pairs: &[Pair],
        results: &[Option<Segs>],
        gaps: &HashMap<usize, f64>,
        by_names: &HashMap<(String, String), Vec<usize>>,
        chain: &[String],
        from: &str,
        to: &str,
        end_pt: [f64; 2],
        depth: usize,
    ) -> Option<(Segs, f64)> {
        if depth > 3 {
            return None;
        }
        // waypoints: from -> via... -> to; each hop is a direct pair entry
        let mut stops: Vec<&str> = vec![from];
        for v in chain {
            stops.push(v.as_str());
        }
        stops.push(to);
        let mut segs: Segs = Vec::new();
        let mut gap_sum = 0.0f64;
        let mut cur_end = end_pt;
        for w in stops.windows(2) {
            let cands = by_names.get(&(w[0].to_string(), w[1].to_string()))?;
            // choose candidate whose start point is nearest the current end
            let mut best: Option<usize> = None;
            let mut best_d = f64::INFINITY;
            for &ci in cands {
                let d = hav(cur_end, pairs[ci].pa);
                if d < best_d {
                    best_d = d;
                    best = Some(ci);
                }
            }
            let ci = best?;
            if best_d > 25.0 {
                return None; // geometric chain break — don't guess
            }
            match &results[ci] {
                Some(s) => {
                    for seg in s {
                        segs.push(seg.clone());
                    }
                    gap_sum += gaps.get(&ci).copied().unwrap_or(0.0);
                }
                None => {
                    // sub-pair may itself be a via_chain
                    if pairs[ci].status == "via_chain" {
                        let (sub, sub_gap) = stitch(
                            pairs,
                            results,
                            gaps,
                            by_names,
                            &pairs[ci].chain_via.clone(),
                            w[0],
                            w[1],
                            pairs[ci].pa,
                            depth + 1,
                        )?;
                        for seg in sub {
                            segs.push(seg);
                        }
                        gap_sum += sub_gap;
                    } else {
                        return None;
                    }
                }
            }
            cur_end = pairs[ci].pb;
        }
        Some((segs, gap_sum))
    }
    let vc_idx: Vec<usize> = (0..pairs.len())
        .filter(|&i| pairs[i].status == "via_chain")
        .collect();
    let mut vc_done = 0usize;
    for &i in &vc_idx {
        let chain = pairs[i].chain_via.clone();
        if let Some((segs, gap_sum)) = stitch(
            &pairs,
            &results,
            &gaps,
            &by_names,
            &chain,
            &pairs[i].from.clone(),
            &pairs[i].to.clone(),
            pairs[i].pa,
            0,
        ) {
            results[i] = Some(segs);
            if gap_sum > 0.0 {
                gaps.insert(i, gap_sum);
            }
            vc_done += 1;
        }
    }
    println!("phase B (via_chain): {}/{} stitched", vc_done, vc_idx.len());

    // ---- verify lengths + write output ----
    let mut out_pairs: Vec<Value> = Vec::with_capacity(pairs.len());
    let mut with_path = 0usize;
    let mut total_nodes = 0usize;
    let mut len_mismatch = 0usize;
    let mut mismatch_by_status: HashMap<String, usize> = HashMap::new();
    for (i, p) in pairs.iter().enumerate() {
        let mut seg_ids: Vec<Vec<u64>> = Vec::new();
        if let Some(segs) = &results[i] {
            with_path += 1;
            let mut drawn = 0.0f64;
            for seg in segs {
                total_nodes += seg.len();
                for w in seg.windows(2) {
                    drawn += hav(g.coords[w[0] as usize], g.coords[w[1] as usize]);
                }
                seg_ids.push(seg.iter().map(|&x| g.ids[x as usize]).collect());
            }
            if let Some(tk) = p.track {
                let expect_gap = gaps.get(&i).copied().unwrap_or(0.0);
                if (drawn + expect_gap - tk).abs() > (0.03 * tk).max(1.5) {
                    len_mismatch += 1;
                    *mismatch_by_status.entry(p.status.clone()).or_insert(0) += 1;
                }
            }
        }
        let mut o = serde_json::json!({
            "from": p.from, "to": p.to, "status": p.status,
            "track_km": p.track, "segments": seg_ids,
        });
        if let Some(gp) = gaps.get(&i) {
            o["gap_km"] = serde_json::json!((gp * 10.0).round() / 10.0);
        }
        if !p.chain_via.is_empty() {
            o["chain_via"] = serde_json::json!(p.chain_via);
        }
        out_pairs.push(o);
    }
    let doc = serde_json::json!({
        "about": "Track geometry per unique consecutive stop pair (2026-10-21 timetables). segments = OSM node-id sequences along railway=rail ways, in travel direction. bridged pairs have 2 segments; the gap between them is unmapped track (gap_km). ferry pairs' segments include the train-ferry link geometry across the water. Pairs with empty segments (flagged/unroutable/snap_fail) have no honest track path.",
        "generated_from": "pair_distances.json + china-rail.osm graph (A* / Dijkstra frontier reconstruction)",
        "pairs": out_pairs,
    });
    std::fs::write(&out_path, serde_json::to_string(&doc).unwrap()).unwrap();
    println!(
        "wrote {}: {} pairs, {} with paths, {} total path nodes, {} length mismatches (>3%) by status: {:?}",
        out_path.display(),
        pairs.len(),
        with_path,
        total_nodes,
        len_mismatch,
        mismatch_by_status
    );
}
