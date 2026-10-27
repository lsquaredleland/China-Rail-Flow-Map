//! Every tunable threshold and penalty of the router, in one place.
//!
//! `Config::default()` is the shipped China setup: it reproduces the
//! corridor-v3-o17 outputs byte for byte. A run can override any subset
//! from a TOML file (`--config <file>`; unknown keys are an error) and,
//! for the model and decision parameters that already had them, from the
//! `CV3_*` environment variables, which win over the file. `--dump-config`
//! prints the effective configuration as TOML.
//!
//! Search internals (snap radii, grid cell sizes, the production-track
//! discount, parallel-track hop costs, KDE grid) stay as constants next
//! to the code that uses them: they are geometry plumbing, not policy.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub network: NetworkConfig,
    pub candidates: CandidateConfig,
    pub bridge: BridgeConfig,
    pub calibration: CalibrationConfig,
    pub model: ModelConfig,
    pub evidence: EvidenceConfig,
    pub decide: DecideConfig,
    pub canon: CanonConfig,
    pub schedule: ScheduleConfig,
}

/// Which `ScheduleSource` the run reads (an input choice, not a
/// threshold; here so the recipe file names it).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleKind {
    /// The timetable deliverables in `--files` (`china::TimetableJson`).
    #[default]
    Timetables,
    /// One train export with an operating calendar (`export::TrainExport`).
    Export,
}

/// The schedule input.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ScheduleConfig {
    /// "timetables" | "export".                             [timetables]
    pub source: ScheduleKind,
    /// Export: the train file, relative to `--files`.
    pub export: String,
    /// Export: stop-list supplements for its placeholder stop lists,
    /// relative to `--files`, first match wins.             [none]
    pub supplements: Vec<String>,
}

/// OSM extract -> rail graph. Defaults: China's `railway=rail` /
/// `railway=ferry` network with the production graph's speed defaults.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NetworkConfig {
    /// Way tag that selects track ways.
    pub way_key: String,
    /// `way_key` values routed as track.                    [rail]
    pub rail_values: Vec<String>,
    /// `way_key` values routed as train ferries.            [ferry]
    pub ferry_values: Vec<String>,
    /// Way tag holding the line name shown in `lines`.      [name]
    pub name_key: String,
    /// Join components whose nearest nodes are within this (km). Must be
    /// <= 1.0 (the stitch grid's reach).                    [0.25]
    pub stitch_km: f64,
    /// Speed (km/h) on a stitch edge.                       [40]
    pub stitch_kmh: f64,
    /// Speed (km/h) on a train-ferry link.                  [15]
    pub ferry_kmh: f64,
    /// Speed (km/h) on `service=*` track (sidings, yards).  [30]
    pub service_kmh: f64,
    /// Tagged maxspeed is clamped to this range (km/h). The A* bound
    /// assumes no edge is faster than 350, so max must stay <= 350.
    pub maxspeed_min: f64,
    pub maxspeed_max: f64,
    /// Untagged `highspeed=yes` track (km/h).               [250]
    pub highspeed_kmh: f64,
    /// Untagged track by `usage=*` value (km/h).
    pub usage_kmh: BTreeMap<String, f64>,
    /// Untagged track of any other usage (km/h).            [100]
    pub default_kmh: f64,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        let usage = [
            ("main", 120.0),
            ("branch", 80.0),
            ("industrial", 40.0),
            ("military", 40.0),
            ("tourism", 40.0),
            ("test", 40.0),
        ];
        NetworkConfig {
            way_key: "railway".into(),
            rail_values: vec!["rail".into()],
            ferry_values: vec!["ferry".into()],
            name_key: "name".into(),
            stitch_km: 0.25,
            stitch_kmh: 40.0,
            ferry_kmh: 15.0,
            service_kmh: 30.0,
            maxspeed_min: 10.0,
            maxspeed_max: 350.0,
            highspeed_kmh: 250.0,
            usage_kmh: usage.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            default_kmh: 100.0,
        }
    }
}

/// Candidate corridors per station pair.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CandidateConfig {
    /// A candidate may be at most this many times the chord (+40 km).  [2.0]
    pub max_len_chord: f64,
    /// ... and this many times the shortest candidate (+30 km).        [1.6]
    pub max_len_shortest: f64,
    /// A new candidate is distinct when less than this share of it lies
    /// within 150 m of every existing one.                              [0.8]
    pub distinct_overlap: f64,
    /// Production geometry replaces a found candidate when each covers
    /// at least this share of the other.                                [0.9]
    pub base_same_overlap: f64,
    /// Penalty-diversified alternative rounds.                          [3]
    pub penalty_rounds: usize,
    /// Cost multiplier on edges near an already-found corridor.        [4.0]
    pub penalty_mult: f64,
}

impl Default for CandidateConfig {
    fn default() -> Self {
        CandidateConfig {
            max_len_chord: 2.0,
            max_len_shortest: 1.6,
            distinct_overlap: 0.8,
            base_same_overlap: 0.9,
            penalty_rounds: 3,
            penalty_mult: 4.0,
        }
    }
}

/// Smallest-gap bridging across unmapped track (limits as production).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BridgeConfig {
    /// Longest straight-line jump (km).                     [10.0]
    pub max_gap_km: f64,
    /// Bridged length / chord must lie in [ratio_min, ratio_max].
    pub ratio_min: f64,
    pub ratio_max: f64,
    /// Bridged length over the pair's fastest schedule (km/h). [355]
    pub max_kmh: f64,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        BridgeConfig {
            max_gap_km: 10.0,
            ratio_min: 0.95,
            ratio_max: 1.45,
            max_kmh: 355.0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CalibrationConfig {
    /// A leg is undisputed when its feasible candidates' predictions are
    /// within this ratio of each other.                     [1.04]
    pub undisputed_spread: f64,
    /// Classes with fewer undisputed legs borrow the pooled fit. [200]
    pub min_class_samples: usize,
}

impl Default for CalibrationConfig {
    fn default() -> Self {
        CalibrationConfig {
            undisputed_spread: 1.04,
            min_class_samples: 200,
        }
    }
}

/// Run-time model and HMM. Env overrides in brackets.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ModelConfig {
    /// Acceleration / braking rate, m/s^2.         [CV3_ACCEL 0.4]
    pub accel: f64,
    /// Fixed minutes per nonstop leg.              [CV3_OVERHEAD 1.0]
    pub overhead: f64,
    /// Slow-side tail scale, ln-ratio units; 0 = plain learned density.
    ///                                             [CV3_TAIL_TAU 0.25]
    pub tail_tau: f64,
    /// Log-prior per ln(length / shortest).        [CV3_LENGTH_PRIOR 3.0]
    pub length_prior: f64,
    /// Weight of the demonstrated-corridor prior.  [CV3_SERVICE_PRIOR 2.0]
    pub service_prior: f64,
    /// Dedicated-HSR km above which a conventional class cannot use a
    /// candidate.                                  [5.0]
    pub conv_hsr_km: f64,
    /// Ferry handling minutes on top of the crossing. [60]
    pub ferry_handling_min: f64,
    /// Speed (km/h) across an unmapped gap.        [80]
    pub gap_kmh: f64,
    /// Log-penalty for reversing through a station... [4.0]
    pub reversal_penalty: f64,
    /// ...whose dwell is shorter than this (min).  [6]
    pub reversal_dwell_min: i64,
    /// Log-penalty per turn-back inside a candidate path: a train runs a
    /// leg without stopping, so it cannot reverse between its stations
    /// (e.g. at a junction). 0 = off.               [0]
    pub inner_reversal_penalty: f64,
    /// A turn-back is a heading change above 150 degrees between the
    /// path this far (km) before a node and this far after it. [1.0]
    pub inner_reversal_km: f64,
    /// ...and not within this distance (km) of any station point, where a
    /// train may reverse (a stop or a technical stop). [1.5]
    pub inner_reversal_station_km: f64,
    /// Log-likelihood of a run faster than ever observed. [-30]
    pub infeasible_loglik: f64,
}

impl Default for ModelConfig {
    fn default() -> Self {
        ModelConfig {
            accel: 0.4,
            overhead: 1.0,
            tail_tau: 0.25,
            length_prior: 3.0,
            service_prior: 2.0,
            conv_hsr_km: 5.0,
            ferry_handling_min: 60.0,
            gap_kmh: 80.0,
            reversal_penalty: 4.0,
            reversal_dwell_min: 6,
            inner_reversal_penalty: 0.0,
            inner_reversal_km: 1.0,
            inner_reversal_station_km: 1.5,
            infeasible_loglik: -30.0,
        }
    }
}

/// Demonstrated corridors from stopping services.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct EvidenceConfig {
    /// A stop lies on a corridor within this distance (km). [1.0]
    pub stop_km: f64,
    /// Longest stopping span counted (intermediate stops).  [6]
    pub max_intermediate: usize,
}

impl Default for EvidenceConfig {
    fn default() -> Self {
        EvidenceConfig {
            stop_km: 1.0,
            max_intermediate: 6,
        }
    }
}

/// The decision policy (`decide::decide`). Env overrides in brackets.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DecideConfig {
    /// Posterior a candidate needs to replace production. [CV3_SWITCH_POST 0.9]
    pub switch_post: f64,
    /// ...while production's posterior is at most this.   [CV3_BASE_MAX 0.05]
    pub base_max: f64,
    /// Posterior needed to draw a pair with no production geometry.
    ///                                                    [CV3_FILL_POST 0.8]
    pub fill_post: f64,
    /// A nearly gap-free candidate (gap < fill_near_gap_km) fills at the
    /// lower posterior fill_near_post.                    [1.0, 0.35]
    pub fill_near_gap_km: f64,
    pub fill_near_post: f64,
    /// A candidate is feasible when its emission exceeds this (the
    /// infeasible log-likelihood is -30).                 [-29.0]
    pub feasible_emit_min: f64,
    /// A bridge fix must shrink production's gap by more than this (km),
    /// or close it.                                       [0.5]
    pub bridge_gap_gain_km: f64,
}

impl Default for DecideConfig {
    fn default() -> Self {
        DecideConfig {
            switch_post: 0.9,
            base_max: 0.05,
            fill_post: 0.8,
            fill_near_gap_km: 1.0,
            fill_near_post: 0.35,
            feasible_emit_min: -29.0,
            bridge_gap_gain_km: 0.5,
        }
    }
}

/// Which candidate becomes a pair's canonical map geometry
/// (`canon::best_for_canon`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanonMode {
    /// The shortest gap-free candidate, else production. The shipped
    /// corridor-v3-o17 behaviour.
    #[default]
    Shortest,
    /// Production's path when gap-free, else as `Shortest`.
    Production,
    /// As `Production`, unless the pair's timetabled legs fit another
    /// gap-free candidate better by `margin_min` and `margin_rel`.
    Hybrid,
}

/// Canonical (double-track-merged) map geometry.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CanonConfig {
    /// A redraw stays within this distance of the corridor (km). [0.2]
    pub buffer_km: f64,
    /// Usage re-weighting rounds (busier parallel track wins).   [4]
    pub rounds: usize,
    /// "shortest" | "production" | "hybrid".                    [shortest]
    pub mode: CanonMode,
    /// Hybrid: the alternative's timetable error over the pair's legs
    /// (minutes the timetable is faster than the path allows at the
    /// class's fast edge; `canon::best_for_canon`) must beat production's
    /// by at least this many minutes...                          [1.0]
    pub margin_min: f64,
    /// ...plus this many minutes per km the alternative is longer than
    /// production...                                             [0.1]
    pub longer_min_per_km: f64,
    /// ...and by at least this share of production's error...   [0.2]
    pub margin_rel: f64,
    /// ...on at least this many timetabled legs.                 [1]
    pub min_legs: usize,
    /// Hybrid: a pair may leave production only if the router disagrees
    /// with production on at least one of its legs: an own path
    /// (`switched` / `filled` / `bridge-fix`) on a non-production
    /// candidate, or `ambiguous-keep` with a non-production best guess
    /// (`canon::router_disagrees`).                             [false]
    pub require_router_agreement: bool,
}

impl Default for CanonConfig {
    fn default() -> Self {
        CanonConfig {
            buffer_km: 0.2,
            rounds: 4,
            mode: CanonMode::Shortest,
            margin_min: 1.0,
            longer_min_per_km: 0.1,
            margin_rel: 0.2,
            min_legs: 1,
            require_router_agreement: false,
        }
    }
}

impl Config {
    /// Defaults, then the TOML file (if any), then `CV3_*` env overrides.
    pub fn load(toml_path: Option<&Path>) -> Result<Config, String> {
        let mut cfg = match toml_path {
            Some(p) => {
                let txt =
                    std::fs::read_to_string(p).map_err(|e| format!("read {}: {e}", p.display()))?;
                toml::from_str(&txt).map_err(|e| format!("parse {}: {e}", p.display()))?
            }
            None => Config::default(),
        };
        cfg.apply_env();
        Ok(cfg)
    }

    /// The model / decision overrides the router has always read.
    pub fn apply_env(&mut self) {
        let f = |k: &str, d: &mut f64| {
            if let Some(v) = std::env::var(k).ok().and_then(|v| v.parse().ok()) {
                *d = v;
            }
        };
        f("CV3_ACCEL", &mut self.model.accel);
        f("CV3_OVERHEAD", &mut self.model.overhead);
        f("CV3_TAIL_TAU", &mut self.model.tail_tau);
        f("CV3_LENGTH_PRIOR", &mut self.model.length_prior);
        f("CV3_SWITCH_POST", &mut self.decide.switch_post);
        f("CV3_BASE_MAX", &mut self.decide.base_max);
        f("CV3_FILL_POST", &mut self.decide.fill_post);
        f("CV3_SERVICE_PRIOR", &mut self.model.service_prior);
    }

    pub fn to_toml(&self) -> String {
        toml::to_string(self).expect("serialise config")
    }
}

static INSTALLED: OnceLock<Config> = OnceLock::new();

/// Make `cfg` the process-wide configuration read by the run-time model
/// (`model::params()`). Call once, before any routing; panics if the
/// configuration was already installed or read.
pub fn install(cfg: Config) {
    if INSTALLED.set(cfg).is_err() {
        panic!("config already installed");
    }
}

/// The installed configuration, or defaults + env when none was
/// installed (unit tests, helper binaries).
pub fn get() -> &'static Config {
    INSTALLED.get_or_init(|| {
        let mut c = Config::default();
        c.apply_env();
        c
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toml_round_trips_and_partial_files_keep_defaults() {
        let d = Config::default();
        let back: Config = toml::from_str(&d.to_toml()).unwrap();
        assert_eq!(back.to_toml(), d.to_toml());
        let p: Config = toml::from_str("[decide]\nswitch_post = 0.95\n").unwrap();
        assert_eq!(p.decide.switch_post, 0.95);
        assert_eq!(p.decide.base_max, 0.05);
        assert_eq!(p.network.rail_values, vec!["rail".to_string()]);
        assert!(toml::from_str::<Config>("[decide]\nswitch_pst = 1.0\n").is_err());
    }

    #[test]
    fn canon_mode_parses_lowercase_and_defaults_to_shortest() {
        assert_eq!(Config::default().canon.mode, CanonMode::Shortest);
        let p: Config = toml::from_str("[canon]\nmode = \"hybrid\"\nmargin_min = 2.0\n").unwrap();
        assert_eq!(p.canon.mode, CanonMode::Hybrid);
        assert_eq!(p.canon.margin_min, 2.0);
        assert_eq!(p.canon.margin_rel, 0.2);
        assert_eq!(p.canon.rounds, 4);
        assert!(toml::from_str::<Config>("[canon]\nmode = \"longest\"\n").is_err());
    }

    #[test]
    fn schedule_defaults_to_the_timetables() {
        assert_eq!(Config::default().schedule.source, ScheduleKind::Timetables);
        let p: Config = toml::from_str(
            "[schedule]\nsource = \"export\"\nexport = \"t.json\"\nsupplements = [\"s.json\"]\n",
        )
        .unwrap();
        assert_eq!(p.schedule.source, ScheduleKind::Export);
        assert_eq!(p.schedule.export, "t.json");
        assert_eq!(p.schedule.supplements, ["s.json"]);
        assert!(toml::from_str::<Config>("[schedule]\nsource = \"gtfs\"\n").is_err());
    }
}
