// corridor-router — per-train corridor inference (staging, corridor-v3).
//
// Production draws every train between two consecutive stops on ONE
// stored geometry per station pair. This tool instead:
//   1. builds the rail graph with OSM speed limits / high-speed flags;
//   2. generates several genuinely different candidate corridors per
//      pair (fastest per class group, shortest, penalty-diversified
//      alternatives, plus the production geometry itself);
//   3. learns how scheduled minutes relate to modelled run time per
//      class from legs whose corridor is not in doubt;
//   4. re-bridges gapped pairs choosing the SMALLEST plausible gap
//      (production minimises total length, which favours the largest
//      allowed straight-line shortcut);
//   5. scores every train leg against every candidate, links each
//      train's consecutive legs (reversal penalty), and takes the
//      posterior;
//   6. switches a leg away from production geometry only on decisive
//      evidence, and writes per-leg paths for atlas.rs (ATLAS_LEG_PATHS);
//   7. self-checks on stopping trains: hide the stop, ask the model
//      which corridor the train took, compare with where it stopped.
//
// Usage: corridor-router [--data <dir>] [--files <dir>] [--osm <file>]
//                        [--project <dir>] [--out <dir>]
//                        [--limit <n pairs>] [--pair "A,B"] [--threads <n>]
//                        [--station-fixes <station_resolution-format json>]
//                        [--config <toml>] [--dump-config]
//
// This file only wires the stages together; see README.md for modules.
use corridor_router::baseline::Baseline;
use corridor_router::config::{self, Config, ScheduleKind};
use corridor_router::graph::{self, Buffers, FineIndex, SnapIndex};
use corridor_router::model::{Calibration, Cand, Shape, CLASS_NAMES, NCLASS};
use corridor_router::schedule::{ScheduleSource, Train};
use corridor_router::stations::{normalize_name, Stations};
use corridor_router::{
    bridge, candidates, canon, china, evidence, export, infer, legs, output, validate,
};
use rayon::prelude::*;
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

fn argval(flag: &str) -> Option<String> {
    let a: Vec<String> = env::args().collect();
    a.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
}

fn has_flag(flag: &str) -> bool {
    env::args().any(|a| a == flag)
}

struct Timer {
    t0: Instant,
    last: Instant,
    marks: Vec<(String, f64)>,
}

impl Timer {
    fn new() -> Self {
        let now = Instant::now();
        Timer {
            t0: now,
            last: now,
            marks: Vec::new(),
        }
    }
    fn mark(&mut self, what: &str) {
        let s = self.last.elapsed().as_secs_f64();
        println!(
            "[{:7.2}s] {what} ({s:.2}s)",
            self.t0.elapsed().as_secs_f64()
        );
        self.marks.push((what.to_string(), s));
        self.last = Instant::now();
    }
}

fn main() {
    let cfg = Config::load(argval("--config").map(PathBuf::from).as_deref())
        .unwrap_or_else(|e| panic!("config: {e}"));
    if has_flag("--dump-config") {
        print!("{}", cfg.to_toml());
        return;
    }
    config::install(cfg);
    let cfg = config::get();

    let mut timer = Timer::new();
    let project = PathBuf::from(argval("--project").unwrap_or_else(|| ".".into()));
    let data = china::data_dir(argval("--data"));
    let files = china::files_dir(argval("--files"));
    let out = PathBuf::from(argval("--out").unwrap_or_else(|| "out".into()));
    fs::create_dir_all(&out).unwrap();
    if let Some(n) = argval("--threads").and_then(|s| s.parse().ok()) {
        rayon::ThreadPoolBuilder::new()
            .num_threads(n)
            .build_global()
            .unwrap();
    }

    // ---- inputs: schedule (`[schedule]`), baseline, stations ----
    let trains: Vec<Train> = match cfg.schedule.source {
        ScheduleKind::Timetables => china::TimetableJson::in_dir(&files).load(),
        ScheduleKind::Export => {
            assert!(
                !cfg.schedule.export.is_empty(),
                "[schedule] source = \"export\" needs `export`"
            );
            let src = export::TrainExport {
                path: files.join(&cfg.schedule.export),
                supplements: cfg
                    .schedule
                    .supplements
                    .iter()
                    .map(|p| files.join(p))
                    .collect(),
            };
            let (trains, n) = src.load_counted();
            println!("schedule export {}: {n:?}", src.path.display());
            trains
        }
    };
    let baseline: Baseline = china::load_baseline(&data);
    // --station-fixes (station_resolution format) is applied last, so it
    // replaces the analyzer's chosen clusters for the names it lists.
    let stations: Stations =
        china::load_stations(&data, argval("--station-fixes").map(PathBuf::from));
    let mut unknown: Vec<&str> = trains
        .iter()
        .flat_map(|t| t.stops.iter().map(|s| s.name.as_str()))
        .filter(|n| stations.get(n).is_none())
        .collect();
    unknown.sort_unstable();
    unknown.dedup();
    timer.mark(&format!(
        "inputs: {} trains, {} production pairs, {} base paths, {} station names ({} stop names unknown: {unknown:?})",
        trains.len(),
        baseline.pairs.len(),
        baseline.paths.len(),
        stations.len(),
        unknown.len()
    ));

    // ---- network ----
    let osm_path = china::osm_path(argval("--osm"), &data, &project);
    let mut g = graph::build(&osm_path, &cfg.network);
    let prod_segs: Vec<&Vec<u64>> = baseline
        .paths
        .values()
        .flat_map(|(_, s)| s.iter())
        .collect();
    let n_prod = g.mark_prod(&prod_segs);
    drop(prod_segs);
    println!("production track edges preferred on double track: {n_prod}");
    let g = g;
    let snapper = SnapIndex::new(&g);
    let fine = FineIndex::new(&g);
    timer.mark("graph");

    // ---- legs and pairs ----
    let legs = legs::legs_of(&trains);
    let only_pair = argval("--pair").map(|s| {
        let mut it = s.split(',').map(normalize_name);
        let (a, b) = (it.next().unwrap(), it.next().unwrap());
        legs::pair_key(&a, &b).0
    });
    let pair_legs = legs::by_pair(&legs);
    let keys = legs::route_keys(
        &pair_legs,
        only_pair.as_ref(),
        argval("--limit").and_then(|s| s.parse::<usize>().ok()),
    );
    let snaps_ok = |pt: [f64; 2]| !snapper.snap(&g, pt).is_empty();
    let (pairs, dup_pairs) =
        legs::pair_infos(&keys, &pair_legs, &legs, &baseline, &stations, &snaps_ok);
    timer.mark(&format!(
        "legs: {} legs, {} pairs to route ({} duplicate-name pairs left on production)",
        legs.len(),
        pairs.len(),
        dup_pairs
    ));

    // ---- candidates (parallel) ----
    let snaps: Vec<_> = pairs
        .par_iter()
        .map(|p| (snapper.snap(&g, p.pa), snapper.snap(&g, p.pb)))
        .collect();
    let mut cands: Vec<Vec<Cand>> = pairs
        .par_iter()
        .zip(snaps.par_iter())
        .map_init(
            || Buffers::new(g.coords.len()),
            |buf, (p, (sa, sb))| {
                if sa.is_empty() || sb.is_empty() {
                    return Vec::new();
                }
                candidates::gen_candidates(
                    &g,
                    &fine,
                    buf,
                    p,
                    sa,
                    sb,
                    baseline.paths.get(&p.key),
                    &cfg.candidates,
                )
            },
        )
        .collect();
    let ncand: usize = cands.iter().map(|c| c.len()).sum();
    timer.mark(&format!("candidates: {ncand} over {} pairs", pairs.len()));

    // ---- calibration on undisputed legs ----
    let pair_idx: HashMap<&legs::Key, usize> =
        pairs.iter().enumerate().map(|(i, p)| (&p.key, i)).collect();
    let calib_samples = infer::calibration_samples(&legs, &pair_idx, &cands, &cfg.calibration);
    let cal = Calibration::fit(&calib_samples, cfg.calibration.min_class_samples);
    timer.mark(&format!(
        "calibration: {} undisputed legs",
        calib_samples.len()
    ));
    for (c, name) in CLASS_NAMES.iter().enumerate() {
        println!(
            "  {:>2}: n={:>6}  scheduled/model median {:.3}  p5 {:.3}  p95 {:.3}  floor {:.3}",
            name,
            cal.n[c],
            cal.median[c].exp(),
            cal.q05[c].exp(),
            cal.q95[c].exp(),
            cal.x_min[c].exp()
        );
    }

    // ---- min-gap bridging: production-bridged pairs, and pairs where
    // some leg fits no candidate ----
    let needs_bridge = infer::needs_bridge(&pairs, &snaps, &cands, &pair_legs, &legs, &cal);
    let bridges: Vec<(usize, Option<Cand>)> = needs_bridge
        .par_iter()
        .map(|&pi| {
            (
                pi,
                bridge::min_gap_bridge(&g, &pairs[pi], &snaps[pi].0, &snaps[pi].1, &cfg.bridge),
            )
        })
        .collect();
    let mut bridge_rows: Vec<Value> = Vec::new();
    for (pi, b) in bridges {
        if let Some(b) = b {
            bridge_rows.push(output::bridge_row(&pairs[pi], &b));
            cands[pi].push(b);
        }
    }
    timer.mark(&format!(
        "bridging: {} pairs searched, {} bridged",
        needs_bridge.len(),
        bridge_rows.len()
    ));

    // ---- demonstrated corridors ----
    let shapes: Vec<Vec<Shape>> = cands
        .par_iter()
        .map(|cs| cs.iter().map(|k| Shape::of(&g, k)).collect())
        .collect();
    let svc = evidence::service_counts(
        &trains,
        &pairs,
        &cands,
        &shapes,
        &pair_idx,
        &stations,
        &cfg.evidence,
    );
    let n_svc: u32 = svc.iter().map(|x| x.1.iter().sum::<u32>()).sum();
    timer.mark(&format!("service evidence: {n_svc} stopping-service spans"));

    // ---- per-train inference + decisions (parallel over trains) ----
    let decisions = infer::infer(&trains, &legs, &cands, &pair_idx, &svc, &cal, &cfg.decide);
    timer.mark(&format!("inference: {} legs", decisions.len()));

    // ---- double track as one corridor, for the map ----
    let weight = |pi: usize| pair_legs[&pairs[pi].key].len() as u32;
    let fast_edge: [f64; NCLASS] = std::array::from_fn(|c| cal.q05[c].exp());
    // pairs with a leg the router disagrees with production on
    let mut router_moved = vec![false; pairs.len()];
    for d in &decisions {
        let Some(&pi) = pair_idx.get(&legs[d.leg].key) else {
            continue;
        };
        if canon::router_disagrees(d.outcome, d.chosen, &d.post, &cands[pi]) {
            router_moved[pi] = true;
        }
    }
    let canon_picks: Vec<Option<usize>> = (0..pairs.len())
        .map(|pi| {
            let times: Vec<canon::LegTime> = pair_legs[&pairs[pi].key]
                .iter()
                .filter_map(|&li| {
                    legs[li].minutes.map(|minutes| canon::LegTime {
                        class: legs[li].class,
                        minutes,
                    })
                })
                .collect();
            let ev = canon::Evidence {
                legs: &times,
                ratio: &fast_edge,
                router_moved: router_moved[pi],
            };
            canon::best_for_canon(&cands[pi], &ev, &cfg.canon)
        })
        .collect();
    let (canon, usage) = canon::canonical(&g, &fine, &cands, &canon_picks, &weight, &cfg.canon);
    let not_base = canon_picks
        .iter()
        .enumerate()
        .filter(|&(pi, k)| k.is_some_and(|k| !cands[pi][k].is_base))
        .count();
    timer.mark(&format!(
        "canonical production geometry: {} pairs ({:?}; {not_base} not production's path)",
        canon.iter().filter(|c| c.is_some()).count(),
        cfg.canon.mode
    ));
    let mut todo: Vec<(usize, usize)> = decisions
        .iter()
        .filter(|d| d.outcome.draws_own_path())
        .map(|d| (pair_idx[&legs[d.leg].key], d.chosen.unwrap()))
        .collect();
    todo.sort_unstable();
    todo.dedup();
    let drawn = canon::redraw_chosen(&g, &fine, &cands, &todo, &usage, &cfg.canon);
    timer.mark(&format!("map redraw: {} chosen corridors", drawn.len()));

    // ---- outputs ----
    let stats = output::write_legs(
        &out, &g, &trains, &legs, &cands, &pair_idx, &decisions, &drawn,
    );
    output::write_pair_paths_canonical(&out, &g, &baseline.paths, &pair_idx, &canon);
    output::write_candidates(&out, &pairs, &cands);
    output::write_bridges(&out, &bridge_rows);
    timer.mark("outputs");

    // ---- self-check on stopping trains ----
    let validation = validate::validate(
        &validate::Inputs {
            g: &g,
            trains: &trains,
            pairs: &pairs,
            cands: &cands,
            shapes: &shapes,
            svc: &svc,
            pair_idx: &pair_idx,
            cal: &cal,
            stations: &stations,
        },
        &cfg.decide,
        &cfg.evidence,
    );
    output::write_validation(&out, &validation);
    timer.mark("validation");

    output::write_summary(
        &out,
        &stats,
        &cal,
        &validation.summary,
        &timer.marks,
        timer.t0.elapsed().as_secs_f64(),
    );
    println!("decisions: {:?}", stats.counts);
    println!(
        "trains with >=1 changed leg: {}; leg paths written: {}",
        stats.trains_changed, stats.leg_paths
    );
    println!("validation: {}", validation.summary);
    println!("TOTAL {:.2}s", timer.t0.elapsed().as_secs_f64());
}
