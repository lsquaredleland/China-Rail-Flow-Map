//! The China datasets: the one place that knows today's file names and
//! formats. Implements the schedule source (the two timetable
//! deliverables), the station matching inputs (osm_stations.json,
//! station_resolution.json, --station-fixes), the production baseline
//! (pair_distances.json, pair_paths.json) and the default directory /
//! OSM extract layout.
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::baseline::{BasePaths, Baseline, PairRec};
use crate::schedule::{parse_hhmm, ScheduleSource, Stop, Train};
use crate::stations::{cluster, normalize_name as clean, Stations};

fn read_json(p: &Path) -> Value {
    let txt = fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&txt).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

// ---- layout ----

/// `--data`, else $CRFM_DATA_DIR, else ./data, else ../data.
pub fn data_dir(arg: Option<String>) -> PathBuf {
    arg.map(PathBuf::from).unwrap_or_else(|| {
        if let Ok(d) = std::env::var("CRFM_DATA_DIR") {
            PathBuf::from(d)
        } else if PathBuf::from("data").exists() {
            PathBuf::from("data")
        } else {
            PathBuf::from("../data")
        }
    })
}

/// `--files`, else $CRFM_OUTPUT_DIR, else ./output, else ../output.
pub fn files_dir(arg: Option<String>) -> PathBuf {
    arg.map(PathBuf::from).unwrap_or_else(|| {
        if let Ok(d) = std::env::var("CRFM_OUTPUT_DIR") {
            PathBuf::from(d)
        } else if PathBuf::from("output").exists() {
            PathBuf::from("output")
        } else {
            PathBuf::from("../output")
        }
    })
}

/// `--osm`, else <data>/osm/china-rail.osm, else <project>/china-rail.osm.
pub fn osm_path(arg: Option<String>, data: &Path, project: &Path) -> PathBuf {
    arg.map(PathBuf::from).unwrap_or_else(|| {
        if data.join("osm/china-rail.osm").exists() {
            data.join("osm/china-rail.osm")
        } else {
            project.join("china-rail.osm")
        }
    })
}

// ---- schedule source ----

/// The timetable deliverables (`{"trains": [{train_no, code, class,
/// stops: [{name, arrive, depart}]}]}`, times "HH:MM" or "----").
pub struct TimetableJson {
    pub paths: Vec<PathBuf>,
}

impl TimetableJson {
    /// The national and intercity deliverables in `files`.
    pub fn in_dir(files: &Path) -> Self {
        TimetableJson {
            paths: vec![
                files.join("china-rail-timetables-2026-10-21.json"),
                files.join("china-rail-intercity-2026-10-28.json"),
            ],
        }
    }
}

#[derive(Deserialize)]
struct RawDeliverable {
    trains: Vec<RawTrain>,
}

#[derive(Deserialize)]
struct RawTrain {
    #[serde(default)]
    train_no: String,
    code: String,
    class: String,
    stops: Vec<RawStop>,
}

#[derive(Deserialize)]
struct RawStop {
    name: String,
    arrive: String,
    depart: String,
}

impl ScheduleSource for TimetableJson {
    fn load(&self) -> Vec<Train> {
        let mut out = Vec::new();
        for p in &self.paths {
            let d: RawDeliverable = serde_json::from_value(read_json(p)).unwrap();
            out.extend(d.trains.into_iter().map(|t| {
                Train {
                    train_no: t.train_no,
                    code: t.code,
                    class: t.class,
                    stops: t
                        .stops
                        .into_iter()
                        .map(|s| Stop {
                            name: clean(&s.name),
                            arrive: parse_hhmm(&s.arrive),
                            depart: parse_hhmm(&s.depart),
                        })
                        .collect(),
                }
            }));
        }
        out
    }
}

// ---- production baseline ----

/// pair_distances + pair_paths for the national and C/S analyzer runs.
pub fn load_baseline(data: &Path) -> Baseline {
    Baseline {
        pairs: load_pairs(&[
            &data.join("derived/pair_distances.json"),
            &data.join("derived/cs_out/pair_distances.json"),
        ]),
        paths: load_base_paths(&[
            &data.join("derived/pair_paths.json"),
            &data.join("derived/cs_out/pair_paths.json"),
        ]),
    }
}

/// Unordered name pair -> production records.
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

/// Production geometry; the first record per pair wins.
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

// ---- station matching ----

/// Station points: osm_stations.json clustered at 3 km, overridden by
/// the analyzer's chosen clusters in each station_resolution.json, then
/// by `fixes` (same format), which therefore wins for the names it lists.
pub fn load_stations(data: &Path, fixes: Option<PathBuf>) -> Stations {
    let mut resolutions = vec![
        data.join("station_resolution.json"),
        data.join("derived/cs_out/station_resolution.json"),
    ];
    resolutions.extend(fixes);
    load_station_points(
        &data.join("osm_stations.json"),
        &resolutions.iter().map(|p| p.as_path()).collect::<Vec<_>>(),
    )
}

/// Station clustering radius for osm_stations.json (km).
const STATION_CLUSTER_KM: f64 = 3.0;

pub fn load_station_points(stations: &Path, resolutions: &[&Path]) -> Stations {
    let pt = |v: &Value| -> Option<[f64; 2]> {
        let a = v.as_array()?;
        Some([a[0].as_f64()?, a[1].as_f64()?])
    };
    let mut out = Stations::new();
    for (name, v) in read_json(stations).as_object().unwrap() {
        let pts: Vec<[f64; 2]> = v.as_array().into_iter().flatten().filter_map(pt).collect();
        if !pts.is_empty() {
            out.insert(clean(name), cluster(&pts, STATION_CLUSTER_KM));
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
