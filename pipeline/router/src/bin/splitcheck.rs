// splitcheck — is a corridor's flow drawn as ONE line, or split across
// parallel lines? For each origin, take the old build's widest outbound
// section; in each build, list the sections that run alongside it
// (>= 60% of their sampled points within 150 m of it, and vice versa
// for >= 30% of it) with their flows. A corridor drawn once has one
// alongside section carrying the flow; a split one has several whose
// flows add up.
// Usage: splitcheck --old <v1.json> --new <v1.json> [--city <zh>]
use corridor_router::graph::hav;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;

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

/// Points every ~100 m along a polyline.
fn densify(pts: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    for w in pts.windows(2) {
        let n = (hav(w[0], w[1]) / 0.1).ceil().max(1.0) as usize;
        for k in 0..n {
            let t = k as f64 / n as f64;
            out.push([
                w[0][0] + (w[1][0] - w[0][0]) * t,
                w[0][1] + (w[1][1] - w[0][1]) * t,
            ]);
        }
    }
    if let Some(l) = pts.last() {
        out.push(*l);
    }
    out
}

fn share_near(a: &[[f64; 2]], b: &[[f64; 2]]) -> f64 {
    if a.is_empty() {
        return 0.0;
    }
    let mut grid: HashMap<(i32, i32), Vec<[f64; 2]>> = HashMap::new();
    for p in b {
        grid.entry(((p[0] * 500.0) as i32, (p[1] * 500.0) as i32))
            .or_default()
            .push(*p);
    }
    let near = a
        .iter()
        .filter(|p| {
            let (cx, cy) = ((p[0] * 500.0) as i32, (p[1] * 500.0) as i32);
            (-1..=1).any(|dx| {
                (-1..=1).any(|dy| {
                    grid.get(&(cx + dx, cy + dy))
                        .is_some_and(|v| v.iter().any(|q| hav(**p, *q) <= 0.15))
                })
            })
        })
        .count();
    near as f64 / a.len() as f64
}

struct Build {
    sections: Vec<Vec<[f64; 2]>>,
    origins: HashMap<String, Vec<(usize, i64)>>,
}

fn load(path: &str) -> Build {
    let v: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let sections = v["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| densify(&decode(s["g"].as_str().unwrap_or(""))))
        .collect();
    let origins = v["origins"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| {
            let flows = o["flows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| (f[0].as_u64().unwrap() as usize, f[1].as_i64().unwrap()))
                .collect();
            (o["zh"].as_str().unwrap().to_string(), flows)
        })
        .collect();
    Build { sections, origins }
}

fn main() {
    let old = load(&argval("--old").unwrap());
    let new = load(&argval("--new").unwrap());
    let only = argval("--city");
    let mut cities: Vec<&String> = old.origins.keys().collect();
    cities.sort();
    let (mut split, mut total) = (0, 0);
    for zh in cities {
        if only.as_ref().is_some_and(|c| c != zh) {
            continue;
        }
        let Some(&(wsec, wn)) = old.origins[zh].iter().max_by_key(|f| f.1) else {
            continue;
        };
        let target = &old.sections[wsec];
        let alongside = |b: &Build| -> Vec<i64> {
            let mut v: Vec<i64> = b.origins[zh]
                .iter()
                .filter(|(s, _)| {
                    let sp = &b.sections[*s];
                    share_near(sp, target) >= 0.6 && share_near(target, sp) >= 0.3
                })
                .map(|f| f.1)
                .collect();
            v.sort_unstable_by(|a, b| b.cmp(a));
            v
        };
        let (o, n) = (alongside(&old), alongside(&new));
        total += 1;
        let is_split = n.len() > o.len();
        if is_split {
            split += 1;
        }
        if only.is_some() || is_split {
            println!("{zh}: widest {wn}  old alongside {o:?}  new alongside {n:?}");
        }
    }
    println!("origins whose widest corridor gained parallel sections: {split} / {total}");
}
