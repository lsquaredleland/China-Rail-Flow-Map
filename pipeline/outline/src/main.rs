// Extract China, Taiwan, Hainan, and South China Sea boundary geometry from the OSM PBF.
// Chains member ways into closed rings + open lines, Douglas-Peucker simplifies at ~1 km (0.009 deg),
// and writes Google-polyline-encoded geometry at 1e4 precision to china-outline.json.
use osmpbf::{Element, ElementReader, RelMemberType};
use std::collections::{HashMap, HashSet};

#[allow(clippy::needless_range_loop)]
fn dp(pts: &[[f64; 2]], eps: f64, keep: &mut [bool]) {
    let n = pts.len();
    if n < 3 {
        for k in keep.iter_mut() {
            *k = true;
        }
        return;
    }
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (ax, ay) = (pts[a][0], pts[a][1]);
        let (bx, by) = (pts[b][0], pts[b][1]);
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        let mut worst = 0f64;
        let mut worst_i = a;
        for i in (a + 1)..b {
            let (px, py) = (pts[i][0], pts[i][1]);
            let d = if len2 == 0.0 {
                ((px - ax).powi(2) + (py - ay).powi(2)).sqrt()
            } else {
                let t = (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0);
                let (qx, qy) = (ax + t * dx, ay + t * dy);
                ((px - qx).powi(2) + (py - qy).powi(2)).sqrt()
            };
            if d > worst {
                worst = d;
                worst_i = i;
            }
        }
        if worst > eps {
            keep[worst_i] = true;
            stack.push((a, worst_i));
            stack.push((worst_i, b));
        }
    }
}

fn simplify(pts: &[[f64; 2]], eps: f64) -> Vec<[f64; 2]> {
    let mut keep = vec![false; pts.len()];
    dp(pts, eps, &mut keep);
    pts.iter()
        .zip(keep.iter())
        .filter(|(_, k)| **k)
        .map(|(p, _)| *p)
        .collect()
}

fn polyline_encode(pts: &[[f64; 2]]) -> String {
    // Encodes [lat, lon] per Google algorithm at 1e4 precision (~11 m)
    let mut out = String::new();
    let mut last = [0i64; 2];
    for p in pts {
        let cur = [(p[1] * 1e4).round() as i64, (p[0] * 1e4).round() as i64];
        for i in 0..2 {
            let mut v = cur[i] - last[i];
            v = if v < 0 { !(v << 1) } else { v << 1 };
            while v >= 0x20 {
                out.push((((0x20 | (v & 0x1f)) + 63) as u8) as char);
                v >>= 5;
            }
            out.push(((v + 63) as u8) as char);
        }
        last = cur;
    }
    out
}

fn hav_km(a: [f64; 2], b: [f64; 2]) -> f64 {
    let p = std::f64::consts::PI / 180.0;
    let h = ((b[1] - a[1]) * p / 2.0).sin().powi(2)
        + (a[1] * p).cos() * (b[1] * p).cos() * ((b[0] - a[0]) * p / 2.0).sin().powi(2);
    12742.0 * h.sqrt().asin()
}

type Chains = Vec<Vec<[f64; 2]>>;

fn snap_chains(chains: Chains, tol_km: f64) -> (Chains, Chains) {
    let mut pool: Vec<Vec<[f64; 2]>> = chains;
    let mut rings: Vec<Vec<[f64; 2]>> = Vec::new();
    loop {
        let mut best: Option<(f64, usize, usize, usize, usize)> = None;
        for i in 0..pool.len() {
            for j in i..pool.len() {
                for ei in 0..2usize {
                    for ej in 0..2usize {
                        if i == j && ei >= ej {
                            continue;
                        }
                        let a = if ei == 0 { pool[i][0] } else { *pool[i].last().unwrap() };
                        let b = if ej == 0 { pool[j][0] } else { *pool[j].last().unwrap() };
                        let d = hav_km(a, b);
                        if best.is_none_or(|(bd, _, _, _, _)| d < bd) {
                            best = Some((d, i, ei, j, ej));
                        }
                    }
                }
            }
        }
        let (d, i, ei, j, ej) = match best {
            Some(b) => b,
            None => break,
        };
        if d > tol_km {
            break;
        }
        if i == j {
            let mut c = pool.remove(i);
            let start = c[0];
            c.push(start);
            rings.push(c);
            continue;
        }
        let (ci_raw, cj_raw) = if i < j {
            let cj = pool.remove(j);
            let ci = pool.remove(i);
            (ci, cj)
        } else {
            let ci = pool.remove(i);
            let cj = pool.remove(j);
            (ci, cj)
        };
        let mut ca = ci_raw;
        if ei == 0 {
            ca.reverse();
        }
        let mut cb = cj_raw;
        if ej == 1 {
            cb.reverse();
        }
        ca.extend(cb.iter());
        pool.push(ca);
    }
    let mut lines: Vec<Vec<[f64; 2]>> = Vec::new();
    for c in pool {
        if c.len() > 3 && hav_km(c[0], *c.last().unwrap()) < 0.01 {
            rings.push(c);
        } else {
            lines.push(c);
        }
    }
    (rings, lines)
}

fn chain(
    way_ids: &HashSet<i64>,
    way_refs: &HashMap<i64, Vec<i64>>,
    coords: &HashMap<i64, [f64; 2]>,
) -> Vec<Vec<[f64; 2]>> {
    let mut by_end: HashMap<i64, Vec<i64>> = HashMap::new();
    for id in way_ids {
        if let Some(refs) = way_refs.get(id) {
            if refs.len() >= 2 {
                by_end.entry(refs[0]).or_default().push(*id);
                by_end.entry(*refs.last().unwrap()).or_default().push(*id);
            }
        }
    }
    let mut used: HashSet<i64> = HashSet::new();
    let mut chains: Vec<Vec<i64>> = Vec::new();
    for id in way_ids {
        if used.contains(id) {
            continue;
        }
        let refs = match way_refs.get(id) {
            Some(r) if r.len() >= 2 => r,
            _ => continue,
        };
        used.insert(*id);
        let mut nodes: Vec<i64> = refs.clone();
        loop {
            let end = *nodes.last().unwrap();
            let nxt = by_end
                .get(&end)
                .and_then(|v| v.iter().find(|w| !used.contains(w)));
            match nxt {
                Some(wid) => {
                    let wr = way_refs.get(wid).unwrap();
                    used.insert(*wid);
                    if wr[0] == end {
                        nodes.extend(wr.iter().skip(1));
                    } else {
                        nodes.extend(wr.iter().rev().skip(1));
                    }
                }
                None => break,
            }
        }
        loop {
            let start = nodes[0];
            let nxt = by_end
                .get(&start)
                .and_then(|v| v.iter().find(|w| !used.contains(w)));
            match nxt {
                Some(wid) => {
                    let wr = way_refs.get(wid).unwrap();
                    used.insert(*wid);
                    let mut head: Vec<i64> = if *wr.last().unwrap() == start {
                        wr[..wr.len() - 1].to_vec()
                    } else {
                        wr[1..].iter().rev().copied().collect()
                    };
                    head.extend(nodes.iter());
                    nodes = head;
                }
                None => break,
            }
        }
        chains.push(nodes);
    }
    chains
        .iter()
        .map(|ns| {
            ns.iter()
                .filter_map(|n| coords.get(n).copied())
                .collect::<Vec<[f64; 2]>>()
        })
        .filter(|c| c.len() >= 2)
        .collect()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let input = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "data/osm/china-latest.osm.pbf".to_string());
    let out_dir = std::env::var("CRFM_OUTPUT_DIR").unwrap_or_else(|_| "output".to_string());
    let out_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| format!("{out_dir}/china-outline.json"));

    // Pass 1: extract boundary ways for PRC (270056), Taiwan (449220), Hainan (2128285)
    let (outer_ways_prc, inner_ways_prc, ways_tw, ways_hn) = {
        let reader = ElementReader::from_path(&input)?;
        reader.par_map_reduce(
            |el| {
                let mut out_prc = HashSet::new();
                let mut inn_prc = HashSet::new();
                let mut out_tw = HashSet::new();
                let mut out_hn = HashSet::new();
                if let Element::Relation(r) = el {
                    let id = r.id();
                    if id == 270056 {
                        for m in r.members() {
                            if m.member_type != RelMemberType::Way {
                                continue;
                            }
                            match m.role().unwrap_or("") {
                                "inner" => { inn_prc.insert(m.member_id); }
                                _ => { out_prc.insert(m.member_id); }
                            }
                        }
                    } else if id == 449220 {
                        for m in r.members() {
                            if m.member_type == RelMemberType::Way && m.role().unwrap_or("") != "inner" {
                                out_tw.insert(m.member_id);
                            }
                        }
                    } else if id == 2128285 {
                        for m in r.members() {
                            if m.member_type == RelMemberType::Way && m.role().unwrap_or("") != "inner" {
                                out_hn.insert(m.member_id);
                            }
                        }
                    }
                }
                (out_prc, inn_prc, out_tw, out_hn)
            },
            || (HashSet::new(), HashSet::new(), HashSet::new(), HashSet::new()),
            |mut a, b| {
                a.0.extend(b.0);
                a.1.extend(b.1);
                a.2.extend(b.2);
                a.3.extend(b.3);
                a
            },
        )?
    };

    println!(
        "ways: PRC outer {} inner {}, Taiwan {}, Hainan {}",
        outer_ways_prc.len(), inner_ways_prc.len(), ways_tw.len(), ways_hn.len()
    );

    let mut wanted: HashSet<i64> = HashSet::new();
    wanted.extend(&outer_ways_prc);
    wanted.extend(&inner_ways_prc);
    wanted.extend(&ways_tw);
    wanted.extend(&ways_hn);

    // Pass 2: node refs for member ways
    let (way_refs, need_nodes) = {
        let reader = ElementReader::from_path(&input)?;
        reader.par_map_reduce(
            |el| {
                let mut refs_map = HashMap::new();
                let mut nodes = HashSet::new();
                if let Element::Way(w) = el {
                    if wanted.contains(&w.id()) {
                        let refs: Vec<i64> = w.refs().collect();
                        for n in refs.iter() {
                            nodes.insert(*n);
                        }
                        refs_map.insert(w.id(), refs);
                    }
                }
                (refs_map, nodes)
            },
            || (HashMap::new(), HashSet::new()),
            |mut a, b| {
                a.0.extend(b.0);
                a.1.extend(b.1);
                a
            },
        )?
    };

    // Pass 3: node coordinates
    let coords: HashMap<i64, [f64; 2]> = {
        let reader = ElementReader::from_path(&input)?;
        reader.par_map_reduce(
            |el| {
                let mut map = HashMap::new();
                match el {
                    Element::Node(n) => {
                        if need_nodes.contains(&n.id()) {
                            map.insert(n.id(), [n.lon(), n.lat()]);
                        }
                    }
                    Element::DenseNode(n) => {
                        if need_nodes.contains(&n.id()) {
                            map.insert(n.id(), [n.lon(), n.lat()]);
                        }
                    }
                    _ => {}
                }
                map
            },
            HashMap::new,
            |mut a, b| {
                a.extend(b);
                a
            },
        )?
    };

    // Chain and snap each territorial unit separately to prevent accidental bridging across straits
    let tol_km = 5.0f64;
    let (mut rings_prc, mut lines_prc) = snap_chains(chain(&outer_ways_prc, &way_refs, &coords), tol_km);
    let (in_rings, in_lines) = snap_chains(chain(&inner_ways_prc, &way_refs, &coords), tol_km);
    let (rings_tw, lines_tw) = snap_chains(chain(&ways_tw, &way_refs, &coords), tol_km);
    let (rings_hn, lines_hn) = snap_chains(chain(&ways_hn, &way_refs, &coords), tol_km);

    let mut all_rings: Vec<Vec<[f64; 2]>> = Vec::new();
    all_rings.append(&mut rings_prc);
    all_rings.extend(in_rings);
    all_rings.extend(rings_tw);
    all_rings.extend(rings_hn);

    let mut all_lines: Vec<Vec<[f64; 2]>> = Vec::new();
    all_lines.append(&mut lines_prc);
    all_lines.extend(in_lines);
    all_lines.extend(lines_tw);
    all_lines.extend(lines_hn);

    // Canonical Nine-Dash Line dashes in the South China Sea
    let nine_dashes: Vec<Vec<[f64; 2]>> = vec![
        vec![[122.8, 23.8], [123.1, 24.8]],      // 1. East of Taiwan
        vec![[122.8, 20.8], [122.2, 19.8]],      // 2. Bashi Channel
        vec![[120.0, 19.2], [119.5, 18.2]],      // 3. North SCS
        vec![[119.2, 16.2], [118.8, 15.1]],      // 4. Scarborough Shoal / West Luzon
        vec![[118.2, 13.0], [117.6, 12.0]],      // 5. Central East SCS
        vec![[116.8, 9.8], [116.1, 8.8]],        // 6. Palawan / East Spratly
        vec![[113.2, 4.2], [112.5, 3.8]],        // 7. James Shoal (Zengmu Ansha)
        vec![[109.5, 4.2], [108.8, 5.2]],        // 8. Southwest SCS / Natuna
        vec![[109.2, 7.8], [109.2, 9.2]],        // 9. West SCS (South Vietnam)
        vec![[110.2, 12.5], [110.0, 14.2]],      // 10. West SCS (Central Vietnam)
        vec![[108.1, 21.4], [108.15, 20.8], [107.55, 20.0]], // Gulf of Tonkin
    ];
    all_lines.extend(nine_dashes);

    // Simplify with 1 km precision (eps = 0.009 deg)
    let eps = 0.009f64;
    let mut keep_rings = Vec::new();
    let mut keep_lines = Vec::new();

    for (src, dst) in [(all_rings, &mut keep_rings), (all_lines, &mut keep_lines)] {
        for c in src {
            let sm = simplify(&c, eps);
            if sm.len() < 2 {
                continue;
            }
            let (mut mnx, mut mxx, mut mny, mut mxy) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
            for q in sm.iter() {
                mnx = mnx.min(q[0]);
                mxx = mxx.max(q[0]);
                mny = mny.min(q[1]);
                mxy = mxy.max(q[1]);
            }
            let diag = ((mxx - mnx).powi(2) + (mxy - mny).powi(2)).sqrt();
            if diag < 0.02 && sm.len() < 5 {
                continue;
            }
            dst.push(sm);
        }
    }

    keep_rings.sort_by_key(|r| std::cmp::Reverse(r.len()));
    let ring_pts: usize = keep_rings.iter().map(|r| r.len()).sum();
    let line_pts: usize = keep_lines.iter().map(|l| l.len()).sum();

    let out = serde_json::json!({
        "about": "China national boundary outline + Taiwan + Hainan + territorial islands + Nine-dash line, Douglas-Peucker simplified at 1 km (0.009 deg), Google-polyline-encoded at 1e4 precision [lat, lon] order.",
        "rings": keep_rings.iter().map(|r| polyline_encode(r)).collect::<Vec<_>>(),
        "lines": keep_lines.iter().map(|l| polyline_encode(l)).collect::<Vec<_>>(),
        "stats": { "rings": keep_rings.len(), "ring_points": ring_pts, "lines": keep_lines.len(), "line_points": line_pts }
    });

    let txt = serde_json::to_string(&out)?;
    std::fs::write(&out_path, &txt)?;
    println!(
        "rings: {} ({} pts), lines: {} ({} pts) -> wrote {} ({:.1} KB)",
        keep_rings.len(), ring_pts, keep_lines.len(), line_pts, out_path, txt.len() as f64 / 1024.0
    );
    Ok(())
}
