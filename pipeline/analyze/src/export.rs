//! A train export with an operating calendar, as a second timetable source
//! (`CRFM_SCHEDULE`; the deliverables in `CRFM_OUTPUT_DIR` stay the default).
//!
//! The file is the deliverable shape (`{"trains": [{train_no, code, class,
//! stops: [{name, arrive, depart}]}]}`) plus optional per-train `run_dates`,
//! `pattern` and `listed_suspended`, and an optional top-level
//! `window.dates`. The rules are the router's (`corridor-router`
//! `export.rs`), so both read the same trains in the same order:
//! - a stop list whose names are all empty is a placeholder, replaced by the
//!   first supplement (`CRFM_SCHEDULE_SUPPLEMENTS`, comma-separated, same
//!   shape) listing the same `train_no` with a complete list of that length;
//! - a train is kept when it has a stop list and, if `run_dates` is given,
//!   runs on at least one date: the window's union, each train once;
//! - file order.

use crate::timetable::{Stop, Train};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// One kept train's calendar, parallel to the trains.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Calendar {
    /// One char per `window` date: '1' runs, '0' does not. Empty when the
    /// export gives no `run_dates` for the train.
    pub days: String,
    pub pattern: Option<String>,
    pub listed_suspended: bool,
}

/// The kept trains, their calendars and the export's date window.
pub struct Export {
    pub trains: Vec<Train>,
    pub calendars: Vec<Calendar>,
    pub window: Vec<String>,
    /// listed, kept, filled from a supplement, left out without stops,
    /// left out without a run date.
    pub counts: [usize; 5],
}

#[derive(Deserialize)]
struct RawFile {
    #[serde(default)]
    window: Option<RawWindow>,
    trains: Vec<RawTrain>,
}

#[derive(Deserialize)]
struct RawWindow {
    #[serde(default)]
    dates: Vec<String>,
}

#[derive(Deserialize)]
struct RawTrain {
    #[serde(default)]
    train_no: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    class: String,
    #[serde(default)]
    stops: Option<Vec<Stop>>,
    #[serde(default)]
    run_dates: Option<Vec<String>>,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    listed_suspended: bool,
}

fn read(p: &Path) -> RawFile {
    let txt = fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&txt).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

fn is_placeholder(stops: &[Stop]) -> bool {
    !stops.is_empty() && stops.iter().all(|s| s.name.trim().is_empty())
}

fn is_complete(stops: &[Stop]) -> bool {
    !stops.is_empty() && stops.iter().all(|s| !s.name.trim().is_empty())
}

pub fn load(path: &Path, supplements: &[PathBuf]) -> Export {
    let file = read(path);
    let sups: Vec<HashMap<String, Vec<Stop>>> = supplements
        .iter()
        .map(|p| {
            read(p)
                .trains
                .into_iter()
                .filter_map(|t| Some((t.train_no, t.stops?)))
                .collect()
        })
        .collect();
    let window = file.window.map(|w| w.dates).unwrap_or_default();
    let mut counts = [file.trains.len(), 0, 0, 0, 0];
    let (mut trains, mut calendars) = (Vec::new(), Vec::new());
    for t in file.trains {
        let mut stops = t.stops.unwrap_or_default();
        if is_placeholder(&stops) {
            let fill = sups.iter().find_map(|m| {
                m.get(&t.train_no)
                    .filter(|s| s.len() == stops.len() && is_complete(s))
            });
            match fill {
                Some(s) => {
                    stops = s.clone();
                    counts[2] += 1;
                }
                None => stops.clear(),
            }
        }
        if !is_complete(&stops) {
            counts[3] += 1;
            continue;
        }
        if t.run_dates.as_ref().is_some_and(|d| d.is_empty()) {
            counts[4] += 1;
            continue;
        }
        counts[1] += 1;
        let days = match &t.run_dates {
            Some(d) => window
                .iter()
                .map(|w| if d.contains(w) { '1' } else { '0' })
                .collect(),
            None => String::new(),
        };
        calendars.push(Calendar {
            days,
            pattern: t.pattern,
            listed_suspended: t.listed_suspended,
        });
        trains.push(Train {
            train_no: t.train_no,
            code: t.code,
            train_class: t.class,
            stops,
        });
    }
    Export {
        trains,
        calendars,
        window,
        counts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_fill_and_the_window_union_is_kept() {
        let dir = std::env::temp_dir().join(format!("analyze-export-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let blank = r#"{"name": "", "arrive": "", "depart": ""}"#;
        let stop = |n: &str| format!(r#"{{"name": "{n}", "arrive": "----", "depart": "08:00"}}"#);
        let main = dir.join("all.json");
        fs::write(
            &main,
            format!(
                r#"{{"window": {{"dates": ["d1", "d2", "d3"]}}, "trains": [
                {{"train_no": "1", "code": "G1", "class": "G", "run_dates": ["d1", "d3"],
                  "pattern": "irregular", "stops": [{a}, {b}]}},
                {{"train_no": "2", "code": "G1", "class": "G", "run_dates": ["d2"],
                  "listed_suspended": true, "stops": [{blank}, {blank}]}},
                {{"train_no": "3", "code": "G3", "class": "G", "run_dates": [], "stops": [{a}, {b}]}},
                {{"train_no": "4", "code": "G4", "class": "G", "stops": null}}
            ]}}"#,
                a = stop("A"),
                b = stop("B")
            ),
        )
        .unwrap();
        let sup = dir.join("sup.json");
        fs::write(
            &sup,
            format!(
                r#"{{"trains": [{{"train_no": "2", "stops": [{}, {}]}}]}}"#,
                stop("C"),
                stop("D")
            ),
        )
        .unwrap();
        let e = load(&main, &[sup]);
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(e.counts, [4, 2, 1, 1, 1]);
        assert_eq!(e.window, ["d1", "d2", "d3"]);
        let names: Vec<&str> = e.trains[1].stops.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["C", "D"]);
        assert_eq!(
            e.calendars,
            [
                Calendar {
                    days: "101".into(),
                    pattern: Some("irregular".into()),
                    listed_suspended: false
                },
                Calendar {
                    days: "010".into(),
                    pattern: None,
                    listed_suspended: true
                },
            ]
        );
    }
}
