// secdiff — section-level diff between two atlas v1 builds.
// Matches sections by (endpoint station names, encoded polyline) using
// each file's own station table, then reports per-origin outbound /
// inbound totals and every section whose flow changed, with the
// section midpoint for geographic classification.
// `--edges` compares per-atomic-edge totals; `--classes` compares the per-edge
// class columns (G D C S Z T K plain) and so catches a wrong class split
// under equal totals.
// Usage: secdiff --old <v1.json> --new <v1.json> [--city <zh>] [--all] [--edges|--classes]
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs;

fn argval(flag: &str) -> Option<String> {
    let a: Vec<String> = env::args().collect();
    a.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
}

fn decode_polyline(s: &str) -> Vec<[f64; 2]> {
    let mut pts: Vec<[f64; 2]> = Vec::new();
    let (mut lat, mut lng) = (0i64, 0i64);
    let bytes = s.as_bytes();
    let mut i = 0usize;
    let read = |i: &mut usize| -> i64 {
        let mut result = 0i64;
        let mut shift = 0;
        loop {
            let b = (bytes[*i] as i64) - 63;
            *i += 1;
            result |= (b & 0x1f) << shift;
            shift += 5;
            if b < 0x20 {
                break;
            }
        }
        if result & 1 != 0 {
            !(result >> 1)
        } else {
            result >> 1
        }
    };
    while i < bytes.len() {
        lat += read(&mut i);
        lng += read(&mut i);
        pts.push([lat as f64 / 1e5, lng as f64 / 1e5]);
    }
    pts
}

fn station_name(table: &[Value], idx: i64) -> String {
    if idx < 0 {
        return "·".to_string();
    }
    table
        .get(idx as usize)
        .and_then(|s| s.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("?")
        .to_string()
}

/// canonical section key + midpoint [lon, lat]
fn section_key(table: &[Value], sec: &Value) -> (String, [f64; 2]) {
    let a = sec.get("a").and_then(|v| v.as_i64()).unwrap_or(-1);
    let b = sec.get("b").and_then(|v| v.as_i64()).unwrap_or(-1);
    let g = sec.get("g").and_then(|v| v.as_str()).unwrap_or("");
    let pts = decode_polyline(g);
    // atlas encodes [lon, lat] pairs as (lat, lon) per the Google format;
    // decoded pairs come back [lat, lon]
    let mid = if pts.is_empty() {
        [0.0, 0.0]
    } else {
        let p = pts[pts.len() / 2];
        [p[1], p[0]]
    };
    (
        format!(
            "{}|{}|{}",
            station_name(table, a),
            station_name(table, b),
            g
        ),
        mid,
    )
}

fn origin_map(d: &Value) -> HashMap<String, &Value> {
    let mut m = HashMap::new();
    if let Some(origins) = d.get("origins").and_then(|v| v.as_array()) {
        for o in origins {
            if let Some(zh) = o.get("zh").and_then(|v| v.as_str()) {
                m.insert(zh.to_string(), o);
            }
        }
    }
    m
}

fn flows_map(
    table: &[Value],
    sections: &[Value],
    o: &Value,
    field: &str,
) -> HashMap<String, (i64, [f64; 2], String)> {
    let mut m = HashMap::new();
    if let Some(fl) = o.get(field).and_then(|v| v.as_array()) {
        for f in fl {
            let idx = f[0].as_i64().unwrap_or(-1);
            let n = f[1].as_i64().unwrap_or(0);
            if idx < 0 || idx as usize >= sections.len() {
                continue;
            }
            let (key, mid) = section_key(table, &sections[idx as usize]);
            let desc = format!(
                "{}->{}",
                station_name(
                    table,
                    sections[idx as usize]
                        .get("a")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(-1)
                ),
                station_name(
                    table,
                    sections[idx as usize]
                        .get("b")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(-1)
                )
            );
            m.insert(key, (n, mid, desc));
        }
    }
    m
}

/// Accumulate an origin's flow onto atomic edges (unordered endpoint
/// pairs of the decoded section polylines, in 1e-5-degree integer
/// coords). Invariant to section chain direction and splitting, so it
/// isolates true flow changes from representation churn.
type EdgeKey = ((i64, i64), (i64, i64));
/// total, then the 8 class columns
type EdgeVal = [i64; 9];

fn edge_flows(sections: &[Value], o: &Value, field: &str) -> HashMap<EdgeKey, EdgeVal> {
    let mut m: HashMap<EdgeKey, EdgeVal> = HashMap::new();
    if let Some(fl) = o.get(field).and_then(|v| v.as_array()) {
        for f in fl {
            let idx = f[0].as_i64().unwrap_or(-1);
            let mut v: EdgeVal = [0; 9];
            for (j, c) in v.iter_mut().enumerate() {
                *c = f.get(1 + j).and_then(|x| x.as_i64()).unwrap_or(0);
            }
            if idx < 0 || idx as usize >= sections.len() {
                continue;
            }
            let g = sections[idx as usize]
                .get("g")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let pts = decode_polyline(g);
            for w in pts.windows(2) {
                let p = (
                    (w[0][0] * 1e5).round() as i64,
                    (w[0][1] * 1e5).round() as i64,
                );
                let q = (
                    (w[1][0] * 1e5).round() as i64,
                    (w[1][1] * 1e5).round() as i64,
                );
                if p == q {
                    continue;
                }
                let key = if p < q { (p, q) } else { (q, p) };
                let acc = m.entry(key).or_insert([0; 9]);
                for (a, b) in acc.iter_mut().zip(v.iter()) {
                    *a += b;
                }
            }
        }
    }
    m
}

fn main() {
    let old_path = argval("--old").unwrap();
    let new_path = argval("--new").unwrap();
    let city_filter = argval("--city");
    let show_all = env::args().any(|a| a == "--all");
    let classes_mode = env::args().any(|a| a == "--classes");
    let edges_mode = classes_mode || env::args().any(|a| a == "--edges");
    let old: Value = serde_json::from_str(&fs::read_to_string(&old_path).unwrap()).unwrap();
    let new: Value = serde_json::from_str(&fs::read_to_string(&new_path).unwrap()).unwrap();
    let old_st = old
        .get("station_table")
        .and_then(|v| v.as_array())
        .unwrap()
        .clone();
    let new_st = new
        .get("station_table")
        .and_then(|v| v.as_array())
        .unwrap()
        .clone();
    let old_secs = old
        .get("sections")
        .and_then(|v| v.as_array())
        .unwrap()
        .clone();
    let new_secs = new
        .get("sections")
        .and_then(|v| v.as_array())
        .unwrap()
        .clone();
    let old_isecs = old
        .get("in_sections")
        .and_then(|v| v.as_array())
        .unwrap()
        .clone();
    let new_isecs = new
        .get("in_sections")
        .and_then(|v| v.as_array())
        .unwrap()
        .clone();
    let old_o = origin_map(&old);
    let new_o = origin_map(&new);
    let mut cities: Vec<&String> = old_o.keys().collect();
    cities.sort();
    println!("== per-origin summary deltas (only changed origins shown unless --all) ==");
    for zh in cities.iter() {
        if let Some(cf) = &city_filter {
            if *zh != cf {
                continue;
            }
        }
        let (oo, no) = (old_o[*zh], new_o[*zh]);
        let get = |o: &Value, k: &str| o.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
        let widest = |o: &Value, f: &str| -> i64 {
            o.get(f)
                .and_then(|v| v.as_array())
                .map(|fl| {
                    fl.iter()
                        .map(|x| x[1].as_i64().unwrap_or(0))
                        .max()
                        .unwrap_or(0)
                })
                .unwrap_or(0)
        };
        let dlen = |o: &Value, k: &str| {
            o.get(k)
                .and_then(|v| v.as_array())
                .map(|a| a.len() as i64)
                .unwrap_or(0)
        };
        let row = [
            ("outbound", get(oo, "outbound"), get(no, "outbound")),
            ("fully", get(oo, "fully_tracked"), get(no, "fully_tracked")),
            ("dests", dlen(oo, "dests"), dlen(no, "dests")),
            ("widest_out", widest(oo, "flows"), widest(no, "flows")),
            ("inbound", get(oo, "inbound"), get(no, "inbound")),
            ("srcs", dlen(oo, "srcs"), dlen(no, "srcs")),
            ("widest_in", widest(oo, "in_flows"), widest(no, "in_flows")),
        ];
        let changed = row.iter().any(|(_, a, b)| a != b);
        if changed || show_all || city_filter.is_some() {
            let parts: Vec<String> = row
                .iter()
                .map(|(k, a, b)| {
                    if a != b {
                        format!("{} {}->{}", k, a, b)
                    } else {
                        format!("{} {}", k, a)
                    }
                })
                .collect();
            println!("{}: {}", zh, parts.join(" · "));
        }
    }
    if edges_mode {
        let mut changed_total = 0usize;
        // true flow changes at atomic-edge level, per origin/direction
        for zh in cities.iter() {
            if let Some(cf) = &city_filter {
                if *zh != cf {
                    continue;
                }
            }
            let (oo, no) = (old_o[*zh], new_o[*zh]);
            for (field, osecs, nsecs, label) in [
                ("flows", &old_secs, &new_secs, "OUT"),
                ("in_flows", &old_isecs, &new_isecs, "IN"),
            ] {
                let om = edge_flows(osecs, oo, field);
                let nm = edge_flows(nsecs, no, field);
                let mut keys: Vec<&EdgeKey> = om.keys().chain(nm.keys()).collect();
                keys.sort();
                keys.dedup();
                let mut lines: Vec<String> = Vec::new();
                for k in keys {
                    let ov = om.get(k).copied().unwrap_or([0; 9]);
                    let nv = nm.get(k).copied().unwrap_or([0; 9]);
                    // --classes: class columns only (equal or not totals)
                    let changed = if classes_mode {
                        ov[1..] != nv[1..]
                    } else {
                        ov[0] != nv[0]
                    };
                    if changed {
                        // midpoint in [lon, lat] degrees
                        let mlon = (k.0 .1 + k.1 .1) as f64 / 2.0 / 1e5;
                        let mlat = (k.0 .0 + k.1 .0) as f64 / 2.0 / 1e5;
                        if classes_mode {
                            lines.push(format!(
                                "  {} {:?} -> {:?}  mid=[{:.3},{:.3}]",
                                label,
                                &ov[1..],
                                &nv[1..],
                                mlon,
                                mlat
                            ));
                        } else {
                            lines.push(format!(
                                "  {} {:>4} -> {:>4}  mid=[{:.3},{:.3}]",
                                label, ov[0], nv[0], mlon, mlat
                            ));
                        }
                    }
                }
                changed_total += lines.len();
                if !lines.is_empty() {
                    println!(
                        "== {} {} changed {}: {} ==",
                        zh,
                        label,
                        if classes_mode { "class edges" } else { "edges" },
                        lines.len()
                    );
                    for l in lines {
                        println!("{}", l);
                    }
                }
            }
        }
        println!(
            "TOTAL changed {}: {}",
            if classes_mode { "class edges" } else { "edges" },
            changed_total
        );
        return;
    }
    // section diffs per origin/direction
    for zh in cities.iter() {
        if let Some(cf) = &city_filter {
            if *zh != cf {
                continue;
            }
        }
        let (oo, no) = (old_o[*zh], new_o[*zh]);
        for (field, osecs, nsecs, otab, ntab, label) in [
            ("flows", &old_secs, &new_secs, &old_st, &new_st, "OUT"),
            ("in_flows", &old_isecs, &new_isecs, &old_st, &new_st, "IN"),
        ] {
            let om = flows_map(otab, osecs, oo, field);
            let nm = flows_map(ntab, nsecs, no, field);
            let mut keys: Vec<&String> = om.keys().chain(nm.keys()).collect();
            keys.sort();
            keys.dedup();
            let mut lines: Vec<String> = Vec::new();
            for k in keys {
                let ov = om.get(k).map(|(n, _, _)| *n).unwrap_or(0);
                let nv = nm.get(k).map(|(n, _, _)| *n).unwrap_or(0);
                if ov != nv {
                    let (mid, desc) = nm
                        .get(k)
                        .or_else(|| om.get(k))
                        .map(|(_, m, d)| (*m, d.clone()))
                        .unwrap();
                    lines.push(format!(
                        "  {} {:>4} -> {:>4}  {}  mid=[{:.2},{:.2}]",
                        label, ov, nv, desc, mid[0], mid[1]
                    ));
                }
            }
            if !lines.is_empty() {
                println!("== {} {} changed sections: {} ==", zh, label, lines.len());
                for l in lines {
                    println!("{}", l);
                }
            }
        }
    }
}
