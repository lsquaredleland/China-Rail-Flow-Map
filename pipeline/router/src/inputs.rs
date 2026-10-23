//! Readers for the pipeline's existing artifacts: the two timetable
//! deliverables, pair_distances (chords + production status), the base
//! pair geometry (pair_paths) and station points.
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::graph::hav;

pub fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn read_json(p: &Path) -> Value {
    let txt = fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&txt).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

#[derive(Deserialize)]
pub struct Deliverable {
    pub trains: Vec<Train>,
}

#[derive(Deserialize, Clone)]
pub struct Train {
    #[serde(default)]
    pub train_no: String,
    pub code: String,
    #[serde(rename = "class")]
    pub class: String,
    pub stops: Vec<Stop>,
}

#[derive(Deserialize, Clone)]
pub struct Stop {
    pub name: String,
    pub arrive: String,
    pub depart: String,
}

pub fn load_trains(paths: &[&Path]) -> Vec<Train> {
    let mut out = Vec::new();
    for p in paths {
        let d: Deliverable = serde_json::from_value(read_json(p)).unwrap();
        out.extend(d.trains);
    }
    for t in out.iter_mut() {
        for s in t.stops.iter_mut() {
            s.name = clean(&s.name);
        }
    }
    out
}

pub fn mins(s: &str) -> Option<i64> {
    let t = s.trim();
    if t == "----" || t.is_empty() {
        return None;
    }
    let mut it = t.split(':');
    let h: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    Some(h * 60 + m)
}

/// Minutes from departing stop `from` to arriving at stop `to`, with the
/// whole-day wrap logic used by atlas.rs / legclass.rs.
pub fn travel_time(stops: &[Stop], from: usize, to: usize) -> Option<i64> {
    let start = mins(&stops[from].depart)?;
    let mut clock = start;
    let mut prev = start;
    for (j, s) in stops.iter().enumerate().take(to + 1).skip(from + 1) {
        let Some(arr) = mins(&s.arrive) else {
            continue;
        };
        let mut abs = clock - prev + arr;
        while abs < clock {
            abs += 1440;
        }
        clock = abs;
        prev = arr;
        if j == to {
            return Some(clock - start);
        }
        if let Some(dep) = mins(&s.depart) {
            let mut d = clock - prev + dep;
            while d < clock {
                d += 1440;
            }
            clock = d;
            prev = dep;
        }
    }
    None
}

/// Dwell minutes at stop `i` (0 when either time is missing).
pub fn dwell(stops: &[Stop], i: usize) -> i64 {
    match (mins(&stops[i].arrive), mins(&stops[i].depart)) {
        (Some(a), Some(d)) => (d - a).rem_euclid(1440),
        _ => 0,
    }
}

/// One production pair record (directed, as pair_distances stores it).
pub struct PairRec {
    pub chord: f64,
    pub track: Option<f64>,
    pub status: String,
    pub gap: Option<f64>,
}

/// Unordered name pair -> production records (one per direction; two
/// different chords mean the names denote two different station pairs).
pub fn load_pairs(paths: &[&Path]) -> HashMap<(String, String), Vec<PairRec>> {
    let mut out: HashMap<(String, String), Vec<PairRec>> = HashMap::new();
    for p in paths {
        let v = read_json(p);
        for r in v["pairs"].as_array().unwrap() {
            let (a, b) = (
                clean(r["from"].as_str().unwrap()),
                clean(r["to"].as_str().unwrap()),
            );
            let key = if a < b { (a, b) } else { (b, a) };
            out.entry(key).or_default().push(PairRec {
                chord: r["chord_km"].as_f64().unwrap_or(0.0),
                track: r["track_km"].as_f64(),
                status: r["status"].as_str().unwrap_or("").to_string(),
                gap: r["gap_km"].as_f64(),
            });
        }
    }
    out
}

/// Base geometry: unordered pair -> (status, OSM node-id segments in
/// key.0 -> key.1 direction).
pub type BasePaths = HashMap<(String, String), (String, Vec<Vec<u64>>)>;

pub fn load_base_paths(paths: &[&Path]) -> BasePaths {
    let mut out: BasePaths = HashMap::new();
    for p in paths {
        let v = read_json(p);
        for r in v["pairs"].as_array().unwrap() {
            let (a, b) = (
                clean(r["from"].as_str().unwrap()),
                clean(r["to"].as_str().unwrap()),
            );
            let mut segs: Vec<Vec<u64>> = r["segments"]
                .as_array()
                .map(|ss| {
                    ss.iter()
                        .map(|s| {
                            s.as_array()
                                .unwrap()
                                .iter()
                                .filter_map(|x| x.as_u64())
                                .collect()
                        })
                        .collect()
                })
                .unwrap_or_default();
            let key = if a < b {
                (a, b)
            } else {
                segs.reverse();
                for s in segs.iter_mut() {
                    s.reverse();
                }
                (b, a)
            };
            let status = r["status"].as_str().unwrap_or("").to_string();
            out.entry(key).or_insert((status, segs));
        }
    }
    out
}

/// Candidate station points per name: osm_stations.json clustered at
/// 3 km (as paths.rs does), overridden by the analyzer's chosen
/// clusters in each station_resolution.json.
pub fn load_station_points(
    stations: &Path,
    resolutions: &[&Path],
) -> HashMap<String, Vec<[f64; 2]>> {
    fn clusters(pts: &[[f64; 2]]) -> Vec<[f64; 2]> {
        let n = pts.len();
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(p: &mut [usize], mut x: usize) -> usize {
            while p[x] != x {
                p[x] = p[p[x]];
                x = p[x];
            }
            x
        }
        for i in 0..n {
            for j in i + 1..n {
                if hav(pts[i], pts[j]) <= 3.0 {
                    let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                    if a != b {
                        parent[a] = b;
                    }
                }
            }
        }
        let mut groups: std::collections::BTreeMap<usize, Vec<[f64; 2]>> = Default::default();
        for (i, p) in pts.iter().enumerate() {
            let r = find(&mut parent, i);
            groups.entry(r).or_default().push(*p);
        }
        groups
            .values()
            .map(|g| {
                let k = g.len() as f64;
                [
                    g.iter().map(|p| p[0]).sum::<f64>() / k,
                    g.iter().map(|p| p[1]).sum::<f64>() / k,
                ]
            })
            .collect()
    }
    let pt = |v: &Value| -> Option<[f64; 2]> {
        let a = v.as_array()?;
        Some([a[0].as_f64()?, a[1].as_f64()?])
    };
    let mut out: HashMap<String, Vec<[f64; 2]>> = HashMap::new();
    for (name, v) in read_json(stations).as_object().unwrap() {
        let pts: Vec<[f64; 2]> = v.as_array().into_iter().flatten().filter_map(pt).collect();
        if !pts.is_empty() {
            out.insert(clean(name), clusters(&pts));
        }
    }
    for r in resolutions {
        let Ok(txt) = fs::read_to_string(r) else {
            continue;
        };
        let v: Value = serde_json::from_str(&txt).unwrap();
        for (name, rec) in v.as_object().unwrap() {
            let pts: Vec<[f64; 2]> = rec["clusters_chosen"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| pt(&c["point"]))
                .collect();
            if !pts.is_empty() {
                out.insert(clean(name), pts);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(name: &str, arrive: &str, depart: &str) -> Stop {
        Stop {
            name: name.into(),
            arrive: arrive.into(),
            depart: depart.into(),
        }
    }

    #[test]
    fn travel_time_wraps_midnight() {
        let s = vec![
            st("a", "----", "23:30"),
            st("b", "00:40", "00:45"),
            st("c", "02:00", "02:00"),
        ];
        assert_eq!(travel_time(&s, 0, 1), Some(70));
        assert_eq!(travel_time(&s, 0, 2), Some(150));
        assert_eq!(travel_time(&s, 1, 2), Some(75));
        assert_eq!(dwell(&s, 1), 5);
    }
}
