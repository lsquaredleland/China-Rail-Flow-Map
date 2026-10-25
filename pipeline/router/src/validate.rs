//! Self-check on stopping trains: hide an intermediate stop B of a
//! stopping train A->B->C and ask which A-C corridor the train took; the
//! truth is the corridor that passes B. Only tests where some candidate
//! passes B (<= 1 km) and some other misses it by > 5 km count.
use crate::classes::{class_group, class_index, CLASS_NAMES, NCLASS};
use crate::config::{DecideConfig, EvidenceConfig};
use crate::decide::is_decisive;
use crate::evidence::SvcCounts;
use crate::graph::{hav, Graph};
use crate::legs::{pair_key, Key, PairInfo};
use crate::model::{self, Calibration, Cand, Shape};
use crate::output::r1;
use crate::schedule::{dwell, travel_time, Train};
use crate::stations::Stations;
use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Minimum distance (km) from a point to a candidate's nodes.
fn dist_to_path(g: &Graph, k: &Cand, pt: [f64; 2]) -> f64 {
    k.nodes
        .iter()
        .map(|&n| hav(pt, g.coords[n as usize]))
        .fold(f64::INFINITY, f64::min)
}

pub struct Validation {
    /// The `validation` block of summary.json.
    pub summary: Value,
    /// One JSON line per wrong decisive switch.
    pub wrong_switches: Vec<String>,
}

pub struct Inputs<'a> {
    pub g: &'a Graph,
    pub trains: &'a [Train],
    pub pairs: &'a [PairInfo],
    pub cands: &'a [Vec<Cand>],
    pub shapes: &'a [Vec<Shape>],
    pub svc: &'a [SvcCounts],
    pub pair_idx: &'a HashMap<&'a Key, usize>,
    pub cal: &'a Calibration,
    pub stations: &'a Stations,
}

pub fn validate(inp: &Inputs, decide_cfg: &DecideConfig, ev: &EvidenceConfig) -> Validation {
    let Inputs {
        g,
        trains,
        pairs,
        cands,
        shapes,
        svc,
        pair_idx,
        cal,
        stations,
    } = *inp;
    struct T {
        detail: Option<Value>,
        model_ok: bool,
        model_switch: Option<bool>,
        base_ok: Option<bool>,
        short_ok: bool,
        class: usize,
    }
    let tests: Vec<T> = trains
        .par_iter()
        .flat_map_iter(|t| {
            let c = class_index(&t.class);
            let mut out = Vec::new();
            for j in 0..t.stops.len().saturating_sub(2) {
                let (a, b, cc) = (&t.stops[j].name, &t.stops[j + 1].name, &t.stops[j + 2].name);
                if a == b || b == cc || a == cc {
                    continue;
                }
                let (key, _) = pair_key(a, cc);
                let Some(&pi) = pair_idx.get(&key) else {
                    continue;
                };
                let pc = &cands[pi];
                if pc.len() < 2 {
                    continue;
                }
                let Some(total) = travel_time(&t.stops, j, j + 2) else {
                    continue;
                };
                let m = total as f64 - dwell(&t.stops, j + 1) as f64 - model::stop_loss_min(c);
                if m <= 0.0 {
                    continue;
                }
                let p = &pairs[pi];
                let Some(bp) = stations.stop_point(b, p.pa, p.pb) else {
                    continue;
                };
                let d: Vec<f64> = pc.iter().map(|k| dist_to_path(g, k, bp)).collect();
                let pass: Vec<bool> = d.iter().map(|x| *x <= 1.0).collect();
                if !pass.iter().any(|x| *x) || !d.iter().any(|x| *x > 5.0) {
                    continue;
                }
                // leave-one-out: remove this train's own A-[B]-C span
                let gidx = class_group(c);
                let own: Vec<bool> = shapes[pi].iter().map(|s| s.near(bp, ev.stop_km)).collect();
                let counted = own.iter().any(|x| *x);
                let compat: Vec<u32> = svc[pi]
                    .0
                    .iter()
                    .zip(&own)
                    .map(|(x, o)| x[gidx] - u32::from(*o && x[gidx] > 0))
                    .collect();
                let n = svc[pi].1[gidx] - u32::from(counted && svc[pi].1[gidx] > 0);
                let sp = model::service_logprior(&compat, n);
                let emit: Vec<f64> = model::emissions(cal, pc, c, m)
                    .iter()
                    .zip(&sp)
                    .map(|(e, p)| e + p)
                    .collect();
                let z = emit.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let post: Vec<f64> = {
                    let e: Vec<f64> = emit.iter().map(|x| (x - z).exp()).collect();
                    let s: f64 = e.iter().sum();
                    e.iter().map(|x| x / s).collect()
                };
                let best = (0..pc.len()).max_by(|&x, &y| post[x].total_cmp(&post[y])).unwrap();
                let base = pc.iter().position(|k| k.is_base);
                let shortest = (0..pc.len())
                    .min_by(|&x, &y| pc[x].km.total_cmp(&pc[y].km))
                    .unwrap();
                let switch = base.and_then(|bi| {
                    is_decisive(&post, best, bi, decide_cfg).then_some(pass[best])
                });
                let detail = (switch == Some(false)).then(|| {
                    let kd = |i: usize| {
                        json!({"source": pc[i].source, "km": r1(pc[i].km), "pred": pc[i].predict(c).map(r1),
                               "post": (post[i] * 1000.0).round() / 1000.0, "d_stop_km": r1(d[i]),
                               "lines": pc[i].lines.iter().map(|x| &x.0).collect::<Vec<_>>()})
                    };
                    json!({"code": t.code, "a": a, "hidden_stop": b, "c": cc, "minutes": m,
                           "chosen": kd(best), "production": base.map(kd),
                           "all": (0..pc.len()).map(kd).collect::<Vec<_>>()})
                });
                out.push(T {
                    detail,
                    model_ok: pass[best],
                    model_switch: switch,
                    base_ok: base.map(|bi| pass[bi]),
                    short_ok: pass[shortest],
                    class: c,
                });
            }
            out.into_iter()
        })
        .collect();
    let wrong_switches: Vec<String> = tests
        .iter()
        .filter_map(|t| t.detail.as_ref().map(|d| d.to_string()))
        .collect();
    let n = tests.len() as f64;
    let frac = |f: &dyn Fn(&T) -> bool| {
        (tests.iter().filter(|t| f(t)).count() as f64 / n * 1000.0).round() / 10.0
    };
    let with_base: Vec<&T> = tests.iter().filter(|t| t.base_ok.is_some()).collect();
    let nb = with_base.len() as f64;
    let base_acc = with_base.iter().filter(|t| t.base_ok == Some(true)).count() as f64 / nb;
    // production + decisive switches (what the router would ship)
    let shipped = with_base
        .iter()
        .filter(|t| match t.model_switch {
            Some(ok) => ok,
            None => t.base_ok == Some(true),
        })
        .count() as f64
        / nb;
    let switches: Vec<&&T> = with_base
        .iter()
        .filter(|t| t.model_switch.is_some())
        .collect();
    let switch_ok = switches
        .iter()
        .filter(|t| t.model_switch == Some(true))
        .count();
    let per_class: Vec<Value> = (0..NCLASS)
        .map(|c| {
            let ts: Vec<&T> = tests.iter().filter(|t| t.class == c).collect();
            let k = ts.len().max(1) as f64;
            json!({
                "class": CLASS_NAMES[c], "n": ts.len(),
                "model_pct": (ts.iter().filter(|t| t.model_ok).count() as f64 / k * 1000.0).round() / 10.0,
                "production_pct": (ts.iter().filter(|t| t.base_ok == Some(true)).count() as f64 / k * 1000.0).round() / 10.0,
            })
        })
        .collect();
    let summary = json!({
        "tests": tests.len(),
        "model_argmax_pct": frac(&|t| t.model_ok),
        "shortest_pct": frac(&|t| t.short_ok),
        "with_production_geometry": with_base.len(),
        "production_pct": (base_acc * 1000.0).round() / 10.0,
        "production_plus_switches_pct": (shipped * 1000.0).round() / 10.0,
        "switches": switches.len(),
        "switches_correct": switch_ok,
        "per_class": per_class,
    });
    Validation {
        summary,
        wrong_switches,
    }
}
