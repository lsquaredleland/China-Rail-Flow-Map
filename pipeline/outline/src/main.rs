// Extract China's national boundary from the Geofabrik China PBF we already
// hold: relation 270056 (boundary=administrative, admin_level=2, name=中国).
// Chains member ways into closed rings + open lines, Douglas-Peucker
// simplifies, and writes Google-polyline-encoded [lat, lon] geometry to
// china-outline.json for the flow atlas.
use osmpbf::{Element, ElementReader, RelMemberType};
use std::collections::{HashMap, HashSet};

fn tag<'a>(tags: impl Iterator<Item = (&'a str, &'a str)>, key: &str) -> Option<String> {
    tags.filter(|(k, _)| *k == key)
        .map(|(_, v)| v.to_string())
        .next()
}

#[allow(clippy::needless_range_loop)]
fn dp(pts: &[[f64; 2]], eps: f64, keep: &mut [bool]) {
    // iterative Douglas-Peucker on [lon, lat] points in degrees
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
    // pts are [lon, lat]; encodes (lat, lon) per the Google algorithm at 1e5
    let mut out = String::new();
    let mut last = [0i64; 2];
    for p in pts {
        let cur = [(p[1] * 1e5).round() as i64, (p[0] * 1e5).round() as i64];
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

/// Join chain ends that nearly meet (gaps left by ways the Geofabrik clip
/// dropped). Repeatedly fuses the closest pair of endpoints within tol_km;
/// a chain whose own ends meet becomes a closed ring.
/// A set of coordinate chains ([lon, lat] points).
type Chains = Vec<Vec<[f64; 2]>>;

fn snap_chains(chains: Chains, tol_km: f64) -> (Chains, Chains) {
    let mut pool: Vec<Vec<[f64; 2]>> = chains;
    let mut rings: Vec<Vec<[f64; 2]>> = Vec::new();
    loop {
        // Closest endpoint pair (i, ei) x (j, ej); end flag 0 = start, 1 = end.
        // i == j is allowed: it is a chain whose own ends nearly meet.
        let mut best: Option<(f64, usize, usize, usize, usize)> = None;
        for i in 0..pool.len() {
            for j in i..pool.len() {
                for ei in 0..2usize {
                    for ej in 0..2usize {
                        if i == j && ei >= ej {
                            continue;
                        }
                        let a = if ei == 0 {
                            pool[i][0]
                        } else {
                            *pool[i].last().unwrap()
                        };
                        let b = if ej == 0 {
                            pool[j][0]
                        } else {
                            *pool[j].last().unwrap()
                        };
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
            // Self-close: append the start point and retire the chain as a ring.
            let mut c = pool.remove(i);
            let start = c[0];
            c.push(start);
            rings.push(c);
            continue;
        }
        // Remove the higher index first so the lower one stays valid.
        let (ci_raw, cj_raw) = if i < j {
            let cj = pool.remove(j);
            let ci = pool.remove(i);
            (ci, cj)
        } else {
            let ci = pool.remove(i);
            let cj = pool.remove(j);
            (ci, cj)
        };
        // Orient: ca must END at chain i's chosen endpoint, cb must START at
        // chain j's chosen endpoint, then concatenate.
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let input = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "data/osm/china-latest.osm.pbf".to_string());
    let out_dir = std::env::var("CRFM_OUTPUT_DIR").unwrap_or_else(|_| "output".to_string());
    let out_path = std::env::args()
        .nth(2)
        .unwrap_or_else(|| format!("{out_dir}/china-outline.json"));

    // ---- Pass 1: relations -> China's boundary member ways by role ----
    let (outer_ways, inner_ways, found) = {
        let reader = ElementReader::from_path(&input)?;
        reader.par_map_reduce(
            |el| {
                let mut out = HashSet::new();
                let mut inn = HashSet::new();
                let mut f = None;
                if let Element::Relation(r) = el {
                    let is_china = r.id() == 270056 || {
                        let b = tag(r.tags(), "boundary");
                        let al = tag(r.tags(), "admin_level");
                        let nm = tag(r.tags(), "name");
                        let ne = tag(r.tags(), "name:en");
                        b.as_deref() == Some("administrative")
                            && al.as_deref() == Some("2")
                            && (nm.as_deref() == Some("中国") || ne.as_deref() == Some("China"))
                    };
                    if is_china {
                        f = Some(r.id());
                        for m in r.members() {
                            if m.member_type != RelMemberType::Way {
                                continue;
                            }
                            match m.role().unwrap_or("") {
                                "inner" => {
                                    inn.insert(m.member_id);
                                }
                                _ => {
                                    out.insert(m.member_id);
                                }
                            }
                        }
                    }
                }
                (out, inn, f)
            },
            || (HashSet::new(), HashSet::new(), None),
            |mut a, b| {
                a.0.extend(b.0);
                a.1.extend(b.1);
                let f = a.2.or(b.2);
                (a.0, a.1, f)
            },
        )?
    };
    println!(
        "relation: {:?} outer ways {} inner ways {}",
        found,
        outer_ways.len(),
        inner_ways.len()
    );

    // ---- Pass 2: member ways -> ordered node refs ----
    let wanted: HashSet<i64> = outer_ways.union(&inner_ways).copied().collect();
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
    println!(
        "ways captured {} of {} wanted; nodes needed {}",
        way_refs.len(),
        wanted.len(),
        need_nodes.len()
    );

    // ---- Pass 3: node coords ----
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
    println!("coords captured {}", coords.len());

    // ---- chain ways into polylines by shared endpoint node ids ----
    fn chain(
        way_ids: &HashSet<i64>,
        way_refs: &HashMap<i64, Vec<i64>>,
        coords: &HashMap<i64, [f64; 2]>,
    ) -> Vec<Vec<[f64; 2]>> {
        let mut by_end: HashMap<i64, Vec<i64>> = HashMap::new(); // endpoint node -> way ids
        for id in way_ids {
            if let Some(refs) = way_refs.get(id) {
                if refs.len() >= 2 {
                    by_end.entry(refs[0]).or_default().push(*id);
                    by_end.entry(*refs.last().unwrap()).or_default().push(*id);
                }
            }
        }
        let mut used: HashSet<i64> = HashSet::new();
        let mut chains: Vec<Vec<i64>> = Vec::new(); // node-id chains
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
            // extend forward
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
            // extend backward
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

    let eps = 0.004f64;
    let outer_chains = chain(&outer_ways, &way_refs, &coords);
    // diagnostics: endpoint gap table for the exact chains
    {
        let mut gaps: Vec<f64> = Vec::new();
        for i in 0..outer_chains.len() {
            for j in i..outer_chains.len() {
                for ei in 0..2 {
                    for ej in 0..2 {
                        if i == j && ei >= ej {
                            continue;
                        }
                        let a = if ei == 0 {
                            outer_chains[i][0]
                        } else {
                            *outer_chains[i].last().unwrap()
                        };
                        let b = if ej == 0 {
                            outer_chains[j][0]
                        } else {
                            *outer_chains[j].last().unwrap()
                        };
                        gaps.push(hav_km(a, b));
                    }
                }
            }
        }
        gaps.sort_by(|x, y| x.partial_cmp(y).unwrap());
        println!(
            "exact outer chains: {}; smallest endpoint gaps (km): {:?}",
            outer_chains.len(),
            gaps.iter()
                .take(10)
                .map(|g| (g * 10.0).round() / 10.0)
                .collect::<Vec<_>>()
        );
    }
    let tol_km: f64 = std::env::args()
        .nth(3)
        .and_then(|v| v.parse().ok())
        .unwrap_or(30.0);
    let (mut rings, mut lines) = snap_chains(outer_chains, tol_km);
    let (in_rings, in_lines) = snap_chains(chain(&inner_ways, &way_refs, &coords), tol_km);
    rings.extend(in_rings);
    lines.extend(in_lines);
    // simplify + speck filter
    let mut keep_rings: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut keep_lines: Vec<Vec<[f64; 2]>> = Vec::new();
    for (src, dst) in [(rings, &mut keep_rings), (lines, &mut keep_lines)] {
        for c in src {
            let sm = simplify(&c, eps);
            if sm.len() < 3 {
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
            if diag < 0.03 && sm.len() < 40 {
                continue;
            }
            dst.push(sm);
        }
    }
    let mut rings = keep_rings;
    let mut lines = keep_lines;
    rings.sort_by_key(|r| std::cmp::Reverse(r.len()));
    lines.sort_by_key(|l| std::cmp::Reverse(l.len()));
    let ring_pts: usize = rings.iter().map(|r| r.len()).sum();
    let line_pts: usize = lines.iter().map(|l| l.len()).sum();
    let mut bbox = [f64::MAX, f64::MIN, f64::MAX, f64::MIN];
    for c in rings.iter().chain(lines.iter()) {
        for p in c.iter() {
            bbox[0] = bbox[0].min(p[0]);
            bbox[1] = bbox[1].max(p[0]);
            bbox[2] = bbox[2].min(p[1]);
            bbox[3] = bbox[3].max(p[1]);
        }
    }
    let out = serde_json::json!({
        "about": "China national boundary outline from OpenStreetMap relation 270056 (boundary=administrative, admin_level=2), extracted from the Geofabrik China PBF already held by the project. Ways chained into closed rings (landmass/islands) and open lines, Douglas-Peucker simplified at 0.004 deg, Google-polyline-encoded at 1e5, [lat, lon] order.",
        "rings": rings.iter().map(|r| polyline_encode(r)).collect::<Vec<_>>(),
        "lines": lines.iter().map(|l| polyline_encode(l)).collect::<Vec<_>>(),
        "stats": { "rings": rings.len(), "ring_points": ring_pts, "lines": lines.len(), "line_points": line_pts,
                   "bbox_lon": [bbox[0], bbox[1]], "bbox_lat": [bbox[2], bbox[3]] }
    });
    let txt = serde_json::to_string(&out).unwrap();
    std::fs::write(&out_path, &txt).unwrap();
    println!(
        "rings {} ({} pts), lines {} ({} pts), bbox lon {:?} lat {:?}",
        rings.len(),
        ring_pts,
        lines.len(),
        line_pts,
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]]
    );
    println!("wrote {} ({:.1} KB)", out_path, txt.len() as f64 / 1024.0);
    Ok(())
}
