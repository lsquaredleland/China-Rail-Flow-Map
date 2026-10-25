//! Output seam: every file the router writes into `--out`.
//!
//!   leg_routes.jsonl            one row per train leg: decision + candidates
//!   leg_paths.json              per-leg OSM segments for router-drawn legs
//!                               (atlas.rs ATLAS_LEG_PATHS)
//!   pair_paths_canonical.json   per-pair double-track-merged geometry
//!                               (atlas.rs ATLAS_PAIR_PATHS)
//!   candidates.json             every pair's candidates
//!   bridges.json                pairs given a smaller-gap bridge
//!   validation_wrong_switches.jsonl, summary.json
//!
//! Formats are byte-stable: field order, rounding and separators are
//! part of the contract (the gate `cmp`s them against the committed run).
use crate::baseline::BasePaths;
use crate::classes::{CLASS_NAMES, NCLASS};
use crate::graph::{self, hav, Graph};
use crate::infer::LegDecision;
use crate::legs::{Key, Leg, PairInfo};
use crate::model::{Calibration, Cand};
use crate::schedule::Train;
use crate::validate::Validation;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

pub fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// OSM node-id segments for the atlas. A real gap (unmapped track)
/// splits the path; a parallel-track hop (<= HOP_KM) does not, so a
/// redrawn path stays one continuous line.
pub fn osm_segments(g: &Graph, k: &Cand) -> Vec<Vec<u64>> {
    let mut segs: Vec<Vec<u64>> = vec![Vec::new()];
    for (i, &n) in k.nodes.iter().enumerate() {
        segs.last_mut().unwrap().push(g.ids[n as usize]);
        if k.gaps_at.contains(&i) {
            let jump = hav(g.coords[n as usize], g.coords[k.nodes[i + 1] as usize]);
            if jump > graph::HOP_KM + 1e-9 {
                segs.push(Vec::new());
            }
        }
    }
    segs.retain(|s| s.len() >= 2);
    segs
}

/// What `write_legs` counted, for the summary.
pub struct LegStats {
    pub counts: BTreeMap<&'static str, usize>,
    pub trains_changed: usize,
    pub leg_paths: usize,
}

/// leg_routes.jsonl and leg_paths.json.
#[allow(clippy::too_many_arguments)]
pub fn write_legs(
    out: &Path,
    g: &Graph,
    trains: &[Train],
    legs: &[Leg],
    cands: &[Vec<Cand>],
    pair_idx: &HashMap<&Key, usize>,
    decisions: &[LegDecision],
    drawn: &HashMap<(usize, usize), Cand>,
) -> LegStats {
    let mut counts: BTreeMap<&str, usize> = Default::default();
    let mut leg_rows: Vec<String> = Vec::with_capacity(decisions.len());
    let mut leg_paths: Vec<Value> = Vec::new();
    let mut trains_changed: HashSet<usize> = HashSet::new();
    for d in decisions {
        *counts.entry(d.outcome.as_str()).or_default() += 1;
        let l = &legs[d.leg];
        let t = &trains[l.train];
        let pi = pair_idx.get(&l.key).copied();
        let (from, to) = (&t.stops[l.j].name, &t.stops[l.j + 1].name);
        let kdesc = |i: Option<usize>| -> Value {
            match (i, pi) {
                (Some(i), Some(pi)) => {
                    let k = &cands[pi][i];
                    json!({
                        "cand": i, "source": k.source, "km": r1(k.km),
                        "pred_min": k.predict(l.class).map(r1),
                        "post": d.post.get(i).map(|p| (p * 1000.0).round() / 1000.0),
                        "lines": k.lines.iter().map(|x| &x.0).collect::<Vec<_>>(),
                    })
                }
                _ => Value::Null,
            }
        };
        leg_rows.push(
            json!({
                "train_no": t.train_no, "code": t.code, "class": t.class,
                "from": from, "to": to, "minutes": l.minutes,
                "decision": d.outcome.as_str(), "chosen": kdesc(d.chosen), "production": kdesc(d.base),
            })
            .to_string(),
        );
        if d.outcome.draws_own_path() {
            let (pi, k) = (pi.unwrap(), d.chosen.unwrap());
            trains_changed.insert(l.train);
            leg_paths.push(json!({
                "train_no": t.train_no, "code": t.code, "from": from, "to": to,
                "id": format!("#cv3:{pi}:{k}"), "km": r1(cands[pi][k].km),
                "decision": d.outcome.as_str(),
                "segments": osm_segments(g, &drawn[&(pi, k)]),
            }));
        }
    }
    fs::write(out.join("leg_routes.jsonl"), leg_rows.join("\n") + "\n").unwrap();
    fs::write(
        out.join("leg_paths.json"),
        serde_json::to_string(&leg_paths).unwrap(),
    )
    .unwrap();
    LegStats {
        counts,
        trains_changed: trains_changed.len(),
        leg_paths: leg_paths.len(),
    }
}

/// pair_paths_canonical.json: every baseline pair plus every routed pair
/// with canonical geometry, sorted; canonical geometry where there is
/// one, else the baseline's segments.
pub fn write_pair_paths_canonical(
    out: &Path,
    g: &Graph,
    base_paths: &BasePaths,
    pair_idx: &HashMap<&Key, usize>,
    canon: &[Option<Cand>],
) {
    let mut all_keys: HashSet<&Key> = base_paths.keys().collect();
    for key in pair_idx.keys() {
        if canon[pair_idx[key]].is_some() {
            all_keys.insert(key);
        }
    }
    let mut pp_keys: Vec<&Key> = all_keys.into_iter().collect();
    pp_keys.sort();
    let pp_rows: Vec<Value> = pp_keys
        .into_iter()
        .map(|key| {
            let base_info = base_paths.get(key);
            let status = base_info.map(|(s, _)| s.as_str()).unwrap_or("ok");
            let segs = base_info.map(|(_, s)| s.clone()).unwrap_or_default();
            let segments = match pair_idx.get(key).and_then(|&pi| canon[pi].as_ref()) {
                Some(c) => osm_segments(g, c),
                None => segs,
            };
            json!({"from": key.0, "to": key.1, "status": status, "segments": segments})
        })
        .collect();
    fs::write(
        out.join("pair_paths_canonical.json"),
        json!({
            "about": "Production pair geometry with double track merged: each pair path redrawn within 200 m of itself onto the track carrying the most train-legs (corridor-v3 staging). For atlas.rs via ATLAS_PAIR_PATHS.",
            "pairs": pp_rows,
        })
        .to_string(),
    )
    .unwrap();
}

/// candidates.json.
pub fn write_candidates(out: &Path, pairs: &[PairInfo], cands: &[Vec<Cand>]) {
    let cand_rows: Vec<Value> = pairs
        .iter()
        .zip(cands)
        .map(|(p, cs)| {
            json!({
                "from": p.key.0, "to": p.key.1, "chord_km": r1(p.chord),
                "prod_status": p.prod_status, "prod_track_km": p.prod_track,
                "cands": cs.iter().map(|k| json!({
                    "source": k.source, "km": r1(k.km), "gap_km": r1(k.gap_km),
                    "hsr_km": r1(k.hsr_km), "production": k.is_base,
                    "lines": k.lines.iter().map(|x| json!([x.0, r1(x.1)])).collect::<Vec<_>>(),
                    "pred_min": (0..NCLASS).map(|c| k.predict(c).map(r1)).collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    fs::write(
        out.join("candidates.json"),
        serde_json::to_string(&cand_rows).unwrap(),
    )
    .unwrap();
}

/// One bridges.json row.
pub fn bridge_row(p: &PairInfo, b: &Cand) -> Value {
    json!({
        "from": p.key.0, "to": p.key.1, "chord_km": r1(p.chord),
        "prod_status": p.prod_status, "prod_gap_km": p.prod_gap, "prod_track_km": p.prod_track,
        "new_gap_km": (b.gap_km * 1000.0).round() / 1000.0, "new_total_km": r1(b.km),
    })
}

pub fn write_bridges(out: &Path, rows: &[Value]) {
    fs::write(
        out.join("bridges.json"),
        serde_json::to_string_pretty(rows).unwrap(),
    )
    .unwrap();
}

pub fn write_validation(out: &Path, v: &Validation) {
    fs::write(
        out.join("validation_wrong_switches.jsonl"),
        v.wrong_switches.join("\n") + "\n",
    )
    .unwrap();
}

/// summary.json (timings vary run to run; everything else is stable).
pub fn write_summary(
    out: &Path,
    stats: &LegStats,
    cal: &Calibration,
    validation: &Value,
    timings: &[(String, f64)],
    total_s: f64,
) {
    let summary = json!({
        "decisions": stats.counts,
        "trains_with_changed_legs": stats.trains_changed,
        "leg_paths": stats.leg_paths,
        "calibration": (0..NCLASS).map(|c| json!({
            "class": CLASS_NAMES[c], "n": cal.n[c],
            "median_ratio": (cal.median[c].exp() * 1000.0).round() / 1000.0,
            "p5": (cal.q05[c].exp() * 1000.0).round() / 1000.0,
            "p95": (cal.q95[c].exp() * 1000.0).round() / 1000.0,
            "feasibility_floor": (cal.x_min[c].exp() * 1000.0).round() / 1000.0,
        })).collect::<Vec<_>>(),
        "validation": validation,
        "timings_s": timings.iter().map(|(k, s)| json!([k, (s * 100.0).round() / 100.0])).collect::<Vec<_>>(),
        "total_s": (total_s * 100.0).round() / 100.0,
    });
    fs::write(
        out.join("summary.json"),
        serde_json::to_string_pretty(&summary).unwrap(),
    )
    .unwrap();
}
