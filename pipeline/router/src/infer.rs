//! Calibration sampling, bridge selection and per-train inference: the
//! glue between the candidates, the run-time model (`model`) and the
//! decision policy (`decide`).
use crate::config::{CalibrationConfig, DecideConfig};
use crate::decide::{decide, Outcome};
use crate::evidence::SvcCounts;
use crate::graph::Snap;
use crate::legs::{Key, Leg, PairInfo};
use crate::model::{self, Calibration, Cand, LegObs};
use crate::schedule::{dwell, Train};
use rayon::prelude::*;
use std::collections::HashMap;

/// (class, ln(scheduled / predicted)) of every leg whose gap-free
/// candidates all predict within `undisputed_spread` of each other.
pub fn calibration_samples(
    legs: &[Leg],
    pair_idx: &HashMap<&Key, usize>,
    cands: &[Vec<Cand>],
    cfg: &CalibrationConfig,
) -> Vec<(usize, f64)> {
    legs.iter()
        .filter_map(|l| {
            let m = l.minutes?;
            let pi = *pair_idx.get(&l.key)?;
            let preds: Vec<f64> = cands[pi]
                .iter()
                .filter(|k| k.gap_km == 0.0)
                .filter_map(|k| k.predict(l.class))
                .collect();
            if preds.is_empty() {
                return None;
            }
            let lo = preds.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = preds.iter().copied().fold(0.0, f64::max);
            (hi / lo <= cfg.undisputed_spread).then(|| (l.class, (m / lo).ln()))
        })
        .collect()
}

/// Pairs to search for a smaller-gap bridge: baseline-bridged pairs,
/// pairs with no candidate, and pairs where some leg fits no candidate.
pub fn needs_bridge(
    pairs: &[PairInfo],
    snaps: &[(Snap, Snap)],
    cands: &[Vec<Cand>],
    pair_legs: &HashMap<Key, Vec<usize>>,
    legs: &[Leg],
    cal: &Calibration,
) -> Vec<usize> {
    (0..pairs.len())
        .filter(|&pi| {
            if snaps[pi].0.is_empty() || snaps[pi].1.is_empty() {
                return false;
            }
            if pairs[pi].prod_status == "bridged" || cands[pi].is_empty() {
                return true;
            }
            pair_legs[&pairs[pi].key].iter().any(|&li| {
                let l = &legs[li];
                l.minutes.is_some_and(|m| {
                    cands[pi].iter().all(|k| {
                        k.predict(l.class)
                            .is_none_or(|p| !cal.is_feasible(l.class, (m / p).ln()))
                    })
                })
            })
        })
        .collect()
}

/// One leg's outcome, with its posterior for the diagnostics.
pub struct LegDecision {
    pub leg: usize,
    pub chosen: Option<usize>,
    pub base: Option<usize>,
    pub post: Vec<f64>,
    pub outcome: Outcome,
}

/// Per train (in parallel): split its legs into chains of consecutive
/// legs that have candidates, score each leg (run-time likelihood +
/// length prior + demonstrated-corridor prior), run forward-backward per
/// chain and decide each leg. Output is in train, then leg order.
#[allow(clippy::too_many_arguments)]
pub fn infer(
    trains: &[Train],
    legs: &[Leg],
    cands: &[Vec<Cand>],
    pair_idx: &HashMap<&Key, usize>,
    svc: &[SvcCounts],
    cal: &Calibration,
    cfg: &DecideConfig,
) -> Vec<LegDecision> {
    let mut train_legs: Vec<Vec<usize>> = vec![Vec::new(); trains.len()];
    for (i, l) in legs.iter().enumerate() {
        train_legs[l.train].push(i);
    }
    train_legs
        .par_iter()
        .flat_map_iter(|tl| {
            let mut out: Vec<LegDecision> = Vec::new();
            // split into chains of consecutive legs that have candidates
            let mut chain: Vec<usize> = Vec::new();
            let flush = |chain: &mut Vec<usize>, out: &mut Vec<LegDecision>| {
                if chain.is_empty() {
                    return;
                }
                let obs: Vec<LegObs> = chain
                    .iter()
                    .map(|&li| {
                        let l = &legs[li];
                        let pc = &cands[pair_idx[&l.key]];
                        let pi = pair_idx[&l.key];
                        let gidx = model::class_group(l.class);
                        let compat: Vec<u32> = svc[pi].0.iter().map(|x| x[gidx]).collect();
                        let sp = model::service_logprior(&compat, svc[pi].1[gidx]);
                        let emit = match l.minutes {
                            Some(m) => model::emissions(cal, pc, l.class, m),
                            None => {
                                let kmin = pc.iter().map(|k| k.km).fold(f64::INFINITY, f64::min);
                                pc.iter()
                                    .map(|k| -model::params().length_prior * (k.km / kmin).ln())
                                    .collect()
                            }
                        };
                        let emit: Vec<f64> = emit.iter().zip(&sp).map(|(e, p)| e + p).collect();
                        let t = &trains[l.train];
                        LegObs {
                            cands: pc,
                            forward: l.forward,
                            emit,
                            dwell_end: dwell(&t.stops, l.j + 1),
                        }
                    })
                    .collect();
                let posts = model::posteriors(&obs);
                for (k, &li) in chain.iter().enumerate() {
                    let post = posts[k].clone();
                    let d = decide(&obs[k], &post, cfg);
                    out.push(LegDecision {
                        leg: li,
                        chosen: d.chosen,
                        base: d.base,
                        post,
                        outcome: d.outcome,
                    });
                }
                chain.clear();
            };
            for &li in tl {
                let has = pair_idx
                    .get(&legs[li].key)
                    .is_some_and(|&pi| !cands[pi].is_empty());
                let contiguous = chain
                    .last()
                    .is_none_or(|&prev| legs[prev].j + 1 == legs[li].j);
                if !has || !contiguous {
                    flush(&mut chain, &mut out);
                }
                if has {
                    chain.push(li);
                } else {
                    out.push(LegDecision {
                        leg: li,
                        chosen: None,
                        base: None,
                        post: Vec::new(),
                        outcome: if pair_idx.contains_key(&legs[li].key) {
                            Outcome::NoCandidates
                        } else {
                            Outcome::NotRouted
                        },
                    });
                }
            }
            flush(&mut chain, &mut out);
            out.into_iter()
        })
        .collect()
}
