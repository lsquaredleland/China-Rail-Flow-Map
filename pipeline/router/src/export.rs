//! Schedule source: a train export with an operating calendar.
//!
//! The file is the timetable-deliverable shape (`{"trains": [{train_no,
//! code, class, stops: [{name, arrive, depart}]}]}`, times "HH:MM" or
//! "----") with optional per-train calendar fields; only `run_dates` is
//! read here. Selected by `[schedule] source = "export"`.
//!
//! The rules, in order:
//! - **Placeholder stop lists.** A stop list whose names are all empty is
//!   a placeholder: the export knows the stop count but not the stops.
//!   It is replaced by the first supplement file that lists the same
//!   `train_no` with a stop list of the same length whose names are all
//!   given. Supplements have the same shape; only `train_no` and `stops`
//!   are read from them.
//! - **The window's union.** A train is included when it has a stop list
//!   (after the supplements) and, if the file gives `run_dates`, runs on
//!   at least one of them. Every included train counts once, whichever
//!   dates it runs on.
//! - **Order.** File order (outputs follow it).
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::schedule::{parse_hhmm, ScheduleSource, Stop, Train};
use crate::stations::normalize_name;

/// A train export plus its stop-list supplements.
pub struct TrainExport {
    pub path: PathBuf,
    pub supplements: Vec<PathBuf>,
}

#[derive(Deserialize)]
struct RawFile {
    trains: Vec<RawTrain>,
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
    stops: Option<Vec<RawStop>>,
    #[serde(default)]
    run_dates: Option<Vec<String>>,
}

#[derive(Deserialize, Clone)]
struct RawStop {
    name: String,
    arrive: String,
    depart: String,
}

/// What the rules did to the file, for the run log.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ExportCounts {
    pub listed: usize,
    pub included: usize,
    /// Placeholder stop lists filled from a supplement.
    pub supplemented: usize,
    /// Left out: no stop list (none, empty, or an unfilled placeholder).
    pub no_stops: usize,
    /// Left out: has stops but no run date.
    pub not_running: usize,
}

fn read(p: &Path) -> RawFile {
    let txt = fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&txt).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

fn is_placeholder(stops: &[RawStop]) -> bool {
    !stops.is_empty() && stops.iter().all(|s| s.name.trim().is_empty())
}

fn is_complete(stops: &[RawStop]) -> bool {
    !stops.is_empty() && stops.iter().all(|s| !s.name.trim().is_empty())
}

impl TrainExport {
    /// The trains and what the rules did.
    pub fn load_counted(&self) -> (Vec<Train>, ExportCounts) {
        let file = read(&self.path);
        let sups: Vec<HashMap<String, Vec<RawStop>>> = self
            .supplements
            .iter()
            .map(|p| {
                read(p)
                    .trains
                    .into_iter()
                    .filter_map(|t| Some((t.train_no, t.stops?)))
                    .collect()
            })
            .collect();
        let mut n = ExportCounts {
            listed: file.trains.len(),
            ..Default::default()
        };
        let mut out = Vec::new();
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
                        n.supplemented += 1;
                    }
                    None => stops.clear(),
                }
            }
            if !is_complete(&stops) {
                n.no_stops += 1;
                continue;
            }
            if t.run_dates.as_ref().is_some_and(|d| d.is_empty()) {
                n.not_running += 1;
                continue;
            }
            n.included += 1;
            out.push(Train {
                train_no: t.train_no,
                code: t.code,
                class: t.class,
                stops: stops
                    .into_iter()
                    .map(|s| Stop {
                        name: normalize_name(&s.name),
                        arrive: parse_hhmm(&s.arrive),
                        depart: parse_hhmm(&s.depart),
                    })
                    .collect(),
            });
        }
        (out, n)
    }
}

impl ScheduleSource for TrainExport {
    fn load(&self) -> Vec<Train> {
        self.load_counted().0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn placeholders_fill_from_supplements_and_the_window_union_is_kept() {
        let dir = std::env::temp_dir().join(format!("export-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let blank = r#"{"name": "", "arrive": "", "depart": ""}"#;
        let main = write(
            &dir,
            "all.json",
            &format!(
                r#"{{"trains": [
                {{"train_no": "1", "code": "G1", "class": "G", "run_dates": ["d1"],
                  "stops": [{{"name": "A", "arrive": "----", "depart": "08:00"}},
                            {{"name": "B ", "arrive": "09:00", "depart": "09:00"}}]}},
                {{"train_no": "2", "code": "G2", "class": "G", "run_dates": ["d2"],
                  "stops": [{blank}, {blank}]}},
                {{"train_no": "3", "code": "G3", "class": "G", "run_dates": ["d1"],
                  "stops": [{blank}, {blank}]}},
                {{"train_no": "4", "code": "G4", "class": "G", "run_dates": [],
                  "stops": [{{"name": "A", "arrive": "----", "depart": "08:00"}},
                            {{"name": "B", "arrive": "09:00", "depart": "09:00"}}]}},
                {{"train_no": "5", "code": "G5", "class": "G", "stops": null}}
            ]}}"#
            ),
        );
        let sup = write(
            &dir,
            "sup.json",
            r#"{"trains": [
                {"train_no": "1", "stops": []},
                {"train_no": "2", "stops": [{"name": "B", "arrive": "----", "depart": "23:50"},
                                            {"name": "C", "arrive": "00:20", "depart": "00:20"}]},
                {"train_no": "3", "stops": [{"name": "B", "arrive": "----", "depart": "10:00"}]}
            ]}"#,
        );
        let src = TrainExport {
            path: main,
            supplements: vec![sup],
        };
        let (trains, n) = src.load_counted();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            n,
            ExportCounts {
                listed: 5,
                included: 2,
                supplemented: 1,
                no_stops: 2,
                not_running: 1,
            }
        );
        let codes: Vec<&str> = trains.iter().map(|t| t.code.as_str()).collect();
        assert_eq!(codes, ["G1", "G2"]);
        assert_eq!(trains[0].stops[1].name, "B");
        assert_eq!(trains[1].stops[0].depart, Some(23 * 60 + 50));
        assert_eq!(trains[1].stops[1].arrive, Some(20));
    }
}
