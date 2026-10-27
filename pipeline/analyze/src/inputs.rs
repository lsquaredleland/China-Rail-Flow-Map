//! The recipe's input files, resolved from the environment and loaded once.
//! `atlas` (builder) and `audit` (recount) read exactly the same inputs; only
//! the parsing lives here, none of the aggregation.
//!
//! Environment: `CRFM_DATA_DIR`, `CRFM_OUTPUT_DIR`, `CRFM_OSM_PATH`,
//! `ATLAS_OVERRIDES`, `ATLAS_PAIR_PATHS`, `ATLAS_LEG_PATHS` (the last one is
//! read by `legs::load_leg_paths`), and the timetable source:
//! `CRFM_SCHEDULE` (a train export, `export.rs`) with
//! `CRFM_SCHEDULE_SUPPLEMENTS`; unset, the deliverables in `CRFM_OUTPUT_DIR`.

use crate::cn::files::{GTFS_STOPS, OSM_EXTRACT, TIMETABLE_FILES};
use crate::export::{self, Calendar};
use crate::geo::median;
use crate::legs::*;
use crate::names::clean;
use crate::osm;
use crate::timetable::{Deliverable, Train};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

/// Where the recipe's directories are.
pub struct Paths {
    pub data_dir: PathBuf,
    pub files: PathBuf,
    pub overrides_path: PathBuf,
}

impl Paths {
    pub fn from_env() -> Paths {
        let data_dir = if let Ok(d) = env::var("CRFM_DATA_DIR") {
            PathBuf::from(d)
        } else if PathBuf::from("data").exists() {
            PathBuf::from("data")
        } else {
            PathBuf::from("../data")
        };
        let files = if let Ok(d) = env::var("CRFM_OUTPUT_DIR") {
            PathBuf::from(d)
        } else if PathBuf::from("output").exists() {
            PathBuf::from("output")
        } else {
            PathBuf::from("../output")
        };
        let overrides_path = env::var("ATLAS_OVERRIDES")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("leg_overrides.json"));
        Paths {
            data_dir,
            files,
            overrides_path,
        }
    }
}

/// Station coordinates: GTFS first, else the nearest real OSM candidate to
/// the median of the name's candidates.
pub struct StationPoints {
    gtfs: HashMap<String, [f64; 2]>,
    osm: HashMap<String, Vec<[f64; 2]>>,
}

impl StationPoints {
    /// `[lat, lon]` of a station name, if known.
    pub fn point(&self, name: &str) -> Option<[f64; 2]> {
        if let Some(p) = self.gtfs.get(name) {
            return Some(*p);
        }
        let cands = self.osm.get(name)?;
        let lats: Vec<f64> = cands.iter().map(|c| c[0]).collect();
        let lons: Vec<f64> = cands.iter().map(|c| c[1]).collect();
        let m = [median(&lats), median(&lons)];
        // nearest REAL candidate to the median point — independent lat/lon
        // medians invent phantom points for homonym stations (e.g. 迎宾路).
        cands
            .iter()
            .min_by(|x, y| {
                let dx = (x[0] - m[0]).powi(2) + (x[1] - m[1]).powi(2);
                let dy = (y[0] - m[0]).powi(2) + (y[1] - m[1]).powi(2);
                dx.partial_cmp(&dy).unwrap()
            })
            .copied()
    }
}

/// Everything both binaries read before they start counting.
pub struct Inputs {
    pub paths: Paths,
    pub override_map: OverrideMap,
    pub trains: Vec<Train>,
    /// Number of trains from the first timetable file (all of them for an
    /// export).
    pub d1_len: usize,
    /// `CRFM_SCHEDULE` only: per-train calendars (parallel to `trains`) and
    /// the export's date window. Its stop lists are also the schedules.
    pub calendar: Option<(Vec<Calendar>, Vec<String>)>,
    pub city_en: HashMap<String, String>,
    pub stations: StationPoints,
    pub path_map: PathMap,
    /// The raw OSM extract (kept for the way-class pass).
    pub osm_data: Vec<u8>,
    /// `[lon, lat]` of every node the routed geometry touches.
    pub coords: HashMap<i64, [f64; 2]>,
}

impl Inputs {
    /// English name of a city (falls back to the Chinese name).
    pub fn en(&self, c: &str) -> String {
        self.city_en
            .get(c)
            .cloned()
            .unwrap_or_else(|| c.to_string())
    }
}

/// Pair-path files in priority order (first record per pair wins):
/// `ATLAS_PAIR_PATHS` (comma-separated) or the canonical corridor-v3 file
/// plus the base pair geometry.
pub fn pair_path_files(data_dir: &std::path::Path) -> Vec<PathBuf> {
    match env::var("ATLAS_PAIR_PATHS") {
        Ok(v) => v.split(',').map(PathBuf::from).collect(),
        Err(_) => {
            let canon = data_dir.join("derived/corridor-v3/pair_paths_canonical.json");
            let mut list = Vec::new();
            if canon.exists() {
                list.push(canon);
            }
            list.push(data_dir.join("derived/pair_paths.json"));
            list.push(data_dir.join("derived/cs_out/pair_paths.json"));
            list
        }
    }
}

/// Load the recipe inputs (prints the same progress lines the binaries
/// always printed).
pub fn load() -> Inputs {
    let paths = Paths::from_env();
    let mut override_map = load_overrides(&paths.overrides_path);
    load_leg_paths(&mut override_map, &paths.data_dir);
    let override_map = override_map;

    let load_deliverable = |p: &PathBuf| -> Deliverable {
        serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
    };
    let (trains, d1_len, calendar) = match env::var("CRFM_SCHEDULE") {
        Ok(p) => {
            let sups: Vec<PathBuf> = env::var("CRFM_SCHEDULE_SUPPLEMENTS")
                .map(|v| v.split(',').map(PathBuf::from).collect())
                .unwrap_or_default();
            let e = export::load(&PathBuf::from(&p), &sups);
            println!(
                "schedule export {p}: listed {}, kept {}, filled from a supplement {}, no stops {}, no run date {}",
                e.counts[0], e.counts[1], e.counts[2], e.counts[3], e.counts[4]
            );
            let n = e.trains.len();
            (e.trains, n, Some((e.calendars, e.window)))
        }
        Err(_) => {
            let d1 = load_deliverable(&paths.files.join(TIMETABLE_FILES[0]));
            let d2 = load_deliverable(&paths.files.join(TIMETABLE_FILES[1]));
            let d1_len = d1.trains.len();
            let mut trains = d1.trains.clone();
            trains.extend(d2.trains.iter().cloned());
            (trains, d1_len, None)
        }
    };
    println!("trains: {}", trains.len());

    let city_en: HashMap<String, String> =
        serde_json::from_str(&fs::read_to_string(paths.data_dir.join("city_en.json")).unwrap())
            .unwrap();
    let osm_stations: HashMap<String, Vec<[f64; 2]>> = serde_json::from_str(
        &fs::read_to_string(paths.data_dir.join("osm_stations.json")).unwrap(),
    )
    .unwrap();
    let mut gtfs: HashMap<String, [f64; 2]> = HashMap::new();
    for line in fs::read_to_string(paths.files.join(GTFS_STOPS))
        .unwrap()
        .lines()
        .skip(1)
    {
        let f: Vec<&str> = line.split(',').collect();
        if f.len() >= 4 {
            if let (Ok(lat), Ok(lon)) = (f[2].parse::<f64>(), f[3].parse::<f64>()) {
                gtfs.insert(clean(f[1]), [lat, lon]);
            }
        }
    }

    // ---- pair paths ----
    let mut path_map: PathMap = HashMap::new();
    for pth in pair_path_files(&paths.data_dir) {
        let pp: PPFile = serde_json::from_str(&fs::read_to_string(&pth).unwrap()).unwrap();
        for p in pp.pairs {
            let (a, b) = (clean(&p.from), clean(&p.to));
            let key = if a < b { (a, b) } else { (b, a) };
            path_map
                .entry(key)
                .or_insert((p.status.clone(), p.segments.clone()));
        }
    }
    println!("pair path entries: {}", path_map.len());

    // ---- needed node coords from the OSM extract ----
    let needed = osm::needed_nodes(&path_map, LEG_PATHS.get());
    println!("needed nodes: {}", needed.len());
    let osm_path = env::var("CRFM_OSM_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| paths.data_dir.join(OSM_EXTRACT));
    let osm_data = fs::read(&osm_path).unwrap();
    println!("osm bytes: {}", osm_data.len());
    let coords = osm::node_coords(&osm_data, &needed);
    println!("coords resolved: {}", coords.len());

    Inputs {
        paths,
        override_map,
        trains,
        d1_len,
        calendar,
        city_en,
        stations: StationPoints {
            gtfs,
            osm: osm_stations,
        },
        path_map,
        osm_data,
        coords,
    }
}
