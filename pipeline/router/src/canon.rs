//! Double track as one corridor, for the map. Every pair's canonical
//! path is redrawn within `buffer_km` of itself onto the busiest track
//! (`rounds` rounds, so "busiest" is judged on already-merged usage);
//! then every chosen non-production corridor is redrawn the same way.
//!
//! The canonical-geometry selection is `best_for_canon` below; which rule
//! it applies is `CanonConfig::mode`.
use crate::classes::NCLASS;
use crate::config::{CanonConfig, CanonMode};
use crate::graph::{self, route_custom, Buffers, FineIndex, Graph};
use crate::model::{Cand, Shape};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};

/// Train-legs per undirected edge.
pub type Usage = HashMap<(u32, u32), u32>;

/// One timetabled leg of a pair: its class index and scheduled minutes.
#[derive(Clone, Copy, Debug)]
pub struct LegTime {
    pub class: usize,
    pub minutes: f64,
}

/// The pair's timetable evidence for the hybrid rule: its legs, and per
/// class the fast edge of the learned scheduled / predicted ratio
/// (`exp(Calibration::q05)`: 95% of the class's undisputed legs run at
/// least this slow against the model).
pub struct Evidence<'a> {
    pub legs: &'a [LegTime],
    pub ratio: &'a [f64; NCLASS],
}

/// Index of the shortest gap-free candidate (first on ties), else of
/// production.
fn shortest(cands: &[Cand]) -> Option<usize> {
    cands
        .iter()
        .enumerate()
        .filter(|(_, c)| c.gap_km == 0.0)
        .min_by(|a, b| a.1.km.total_cmp(&b.1.km))
        .map(|(i, _)| i)
        .or_else(|| cands.iter().position(|c| c.is_base))
}

/// Index of production's candidate when it is gap-free.
fn production_gap_free(cands: &[Cand]) -> Option<usize> {
    cands
        .iter()
        .position(|c| c.is_base)
        .filter(|&i| cands[i].gap_km == 0.0)
}

/// Mean timetable error of `k` over `legs`: by how many minutes the
/// timetable is faster than `k` allows, max(0, predict * ratio - t), with
/// `ratio` the class's fast edge. One-sided because a train can always run
/// slower than its track allows (recovery time, overnight sleepers) but
/// not faster: a timetable slower than every path is no evidence for a
/// longer one. Against the fast edge, not the median, so ordinary spread
/// and speed-tag error on the path are no evidence either. None when some
/// leg's class cannot use `k`.
fn mean_error(k: &Cand, legs: &[LegTime], ratio: &[f64; NCLASS]) -> Option<f64> {
    let mut sum = 0.0;
    for l in legs {
        sum += (k.predict(l.class)? * ratio[l.class] - l.minutes).max(0.0);
    }
    Some(sum / legs.len() as f64)
}

/// The hybrid rule. Production's gap-free path, unless another gap-free
/// candidate fits the pair's timetabled legs better (`mean_error`) by at
/// least `margin_min` minutes AND `margin_rel` of production's error, on
/// at least `min_legs` legs. The evidence is every leg whose class can use
/// production (each scored with its own class's prediction, so the pair's
/// class mix weights it); an alternative some of those classes cannot use
/// is not eligible. Among equally good alternatives the shortest wins.
/// Without gap-free production: as `Shortest`.
fn hybrid(cands: &[Cand], ev: &Evidence, cfg: &CanonConfig) -> Option<usize> {
    let Some(b) = production_gap_free(cands) else {
        return shortest(cands);
    };
    let legs: Vec<LegTime> = ev
        .legs
        .iter()
        .filter(|l| cands[b].predict(l.class).is_some())
        .copied()
        .collect();
    if legs.is_empty() || legs.len() < cfg.min_legs {
        return Some(b);
    }
    let base_err = mean_error(&cands[b], &legs, ev.ratio)?;
    let best = cands
        .iter()
        .enumerate()
        .filter(|&(i, c)| i != b && c.gap_km == 0.0)
        .filter_map(|(i, c)| mean_error(c, &legs, ev.ratio).map(|e| (e, i)))
        .min_by(|x, y| {
            x.0.total_cmp(&y.0)
                .then(cands[x.1].km.total_cmp(&cands[y.1].km))
                .then(x.1.cmp(&y.1))
        });
    match best {
        Some((e, i))
            if base_err - e >= cfg.margin_min && e <= base_err * (1.0 - cfg.margin_rel) =>
        {
            Some(i)
        }
        _ => Some(b),
    }
}

/// Index of the candidate whose redraw becomes the pair's canonical
/// geometry, by `cfg.mode` (None = nothing to draw).
pub fn best_for_canon(cands: &[Cand], ev: &Evidence, cfg: &CanonConfig) -> Option<usize> {
    match cfg.mode {
        CanonMode::Shortest => shortest(cands),
        CanonMode::Production => production_gap_free(cands).or_else(|| shortest(cands)),
        CanonMode::Hybrid => hybrid(cands, ev, cfg),
    }
}

/// Redraw a chosen corridor for the map: between the same end nodes
/// (per segment, for bridged paths), stay within `buffer_km` of the
/// corridor and follow the track that carries the most production
/// train-legs, so a re-routed train joins the line already drawn instead
/// of creating a parallel one on the other track of a double-track line.
pub fn redraw(
    g: &Graph,
    fine: &FineIndex,
    buf: &mut Buffers,
    k: &Cand,
    usage: &HashMap<(u32, u32), u32>,
    buffer_km: f64,
) -> Cand {
    let shape = Shape::of(g, k);
    let mut allowed: HashSet<(u32, u32)> = HashSet::new();
    for &p in shape.samples() {
        for u in fine.near(g, p, buffer_km) {
            for e in &g.adj[u as usize] {
                allowed.insert((u.min(e.to), u.max(e.to)));
            }
        }
    }
    // also every edge of the path itself (samples are 0.3 km apart)
    for w in k.nodes.windows(2) {
        allowed.insert((w[0].min(w[1]), w[0].max(w[1])));
    }
    let cost = |u: u32, e: &graph::Edge| -> f64 {
        let key = (u.min(e.to), u.max(e.to));
        let base = e.km as f64;
        if !allowed.contains(&key) {
            return base * 50.0;
        }
        match usage.get(&key) {
            Some(&n) => base / (1.0 + n as f64).sqrt(),
            None => base,
        }
    };
    let mut cuts: Vec<usize> = vec![0];
    for &i in &k.gaps_at {
        cuts.push(i);
        cuts.push(i + 1);
    }
    cuts.push(k.nodes.len() - 1);
    let mut nodes: Vec<u32> = Vec::new();
    for seg in cuts.chunks(2) {
        let (a, b) = (k.nodes[seg[0]], k.nodes[seg[1]]);
        let part = if a == b {
            vec![a]
        } else {
            route_custom(g, buf, a, b, cost, Some(fine), k.km * 60.0)
                .unwrap_or_else(|| k.nodes[seg[0]..=seg[1]].to_vec())
        };
        nodes.extend(part);
    }
    let mut out = Cand::measure(g, nodes, &k.source);
    out.is_base = k.is_base;
    out
}

/// Train-legs per undirected edge over weighted paths.
pub fn edge_usage<'a>(paths: impl Iterator<Item = (&'a Cand, u32)>) -> HashMap<(u32, u32), u32> {
    let mut usage: HashMap<(u32, u32), u32> = HashMap::new();
    for (k, n) in paths {
        for w in k.nodes.windows(2) {
            *usage.entry((w[0].min(w[1]), w[0].max(w[1]))).or_default() += n;
        }
    }
    usage
}

/// Canonical geometry per pair (None = nothing to draw) and the final
/// track usage it implies. `picks[pi]` is pair `pi`'s `best_for_canon`
/// index; `weight(pi)` its train-leg count.
pub fn canonical(
    g: &Graph,
    fine: &FineIndex,
    cands: &[Vec<Cand>],
    picks: &[Option<usize>],
    weight: &(dyn Fn(usize) -> u32 + Sync),
    cfg: &CanonConfig,
) -> (Vec<Option<Cand>>, Usage) {
    let best_for_canon = |pi: usize| picks[pi].map(|k| &cands[pi][k]);
    let mut usage = edge_usage(
        cands
            .iter()
            .enumerate()
            .filter_map(|(pi, _)| best_for_canon(pi).map(|b| (b, weight(pi)))),
    );
    let mut canon: Vec<Option<Cand>> = vec![None; cands.len()];
    for _round in 0..cfg.rounds {
        canon = (0..cands.len())
            .into_par_iter()
            .map_init(
                || Buffers::new(g.coords.len()),
                |buf, pi| {
                    best_for_canon(pi).map(|b| redraw(g, fine, buf, b, &usage, cfg.buffer_km))
                },
            )
            .collect();
        usage = edge_usage(
            canon
                .iter()
                .enumerate()
                .filter_map(|(pi, c)| c.as_ref().map(|c| (c, weight(pi)))),
        );
    }
    (canon, usage)
}

/// Redraw each chosen `(pair, candidate)` on the merged track usage.
pub fn redraw_chosen(
    g: &Graph,
    fine: &FineIndex,
    cands: &[Vec<Cand>],
    todo: &[(usize, usize)],
    usage: &HashMap<(u32, u32), u32>,
    cfg: &CanonConfig,
) -> HashMap<(usize, usize), Cand> {
    todo.par_iter()
        .map_init(
            || Buffers::new(g.coords.len()),
            |buf, &(pi, k)| {
                (
                    (pi, k),
                    redraw(g, fine, buf, &cands[pi][k], usage, cfg.buffer_km),
                )
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::classes::class_index;

    /// A candidate of `km` whose every class predicts `run` minutes
    /// (+ the 1-minute overhead).
    fn cand(km: f64, gap_km: f64, is_base: bool, run: f64) -> Cand {
        Cand {
            nodes: Vec::new(),
            km,
            gap_km,
            gaps_at: Vec::new(),
            hsr_km: 0.0,
            run_min: [run; NCLASS],
            source: String::new(),
            is_base,
            head_start: 0.0,
            head_end: 0.0,
            lines: Vec::new(),
        }
    }

    const ONE: [f64; NCLASS] = [1.0; NCLASS];

    fn legs(minutes: &[f64]) -> Vec<LegTime> {
        minutes
            .iter()
            .map(|&m| LegTime {
                class: 0,
                minutes: m,
            })
            .collect()
    }

    fn pick(cands: &[Cand], mode: CanonMode, l: &[LegTime], cfg: CanonConfig) -> Option<usize> {
        let cfg = CanonConfig { mode, ..cfg };
        let ev = Evidence {
            legs: l,
            ratio: &ONE,
        };
        best_for_canon(cands, &ev, &cfg)
    }

    fn margins(margin_min: f64, margin_rel: f64, min_legs: usize) -> CanonConfig {
        CanonConfig {
            margin_min,
            margin_rel,
            min_legs,
            ..CanonConfig::default()
        }
    }

    /// Production 0 (120 km, predicts 41 min), shortest 1 (100 km, 31 min).
    fn two() -> Vec<Cand> {
        vec![cand(120.0, 0.0, true, 40.0), cand(100.0, 0.0, false, 30.0)]
    }

    const HY: CanonMode = CanonMode::Hybrid;

    #[test]
    fn shortest_and_production_modes() {
        let c = two();
        let d = CanonConfig::default;
        assert_eq!(pick(&c, CanonMode::Shortest, &[], d()), Some(1));
        assert_eq!(pick(&c, CanonMode::Production, &[], d()), Some(0));
        // gapped production: both fall back to the shortest gap-free one
        let g = vec![cand(90.0, 2.0, true, 25.0), cand(100.0, 0.0, false, 30.0)];
        assert_eq!(pick(&g, CanonMode::Production, &[], d()), Some(1));
        assert_eq!(pick(&g, CanonMode::Shortest, &[], d()), Some(1));
        assert_eq!(pick(&g, HY, &legs(&[26.0]), d()), Some(1));
        // nothing gap-free: production
        let n = vec![cand(90.0, 2.0, false, 25.0), cand(95.0, 1.0, true, 25.0)];
        assert_eq!(pick(&n, CanonMode::Shortest, &[], d()), Some(1));
        assert_eq!(pick(&n, CanonMode::Production, &[], d()), Some(1));
        assert_eq!(pick(&n, HY, &legs(&[26.0]), d()), Some(1));
        assert_eq!(pick(&[], HY, &[], d()), None);
    }

    #[test]
    fn shortest_mode_keeps_the_first_of_equal_lengths() {
        let c = vec![cand(100.0, 0.0, false, 30.0), cand(100.0, 0.0, true, 30.0)];
        assert_eq!(
            pick(&c, CanonMode::Shortest, &[], CanonConfig::default()),
            Some(0)
        );
    }

    #[test]
    fn hybrid_switches_only_on_evidence() {
        // legs at 31 min: production 10 min too slow, shortest fits
        let fast = legs(&[31.0, 31.0]);
        assert_eq!(pick(&two(), HY, &fast, margins(1.0, 0.2, 1)), Some(1));
        // legs at 41 min: production fits and stays
        let slow = legs(&[41.0, 41.0]);
        assert_eq!(pick(&two(), HY, &slow, margins(1.0, 0.2, 1)), Some(0));
        // no legs: production, even with zero margins
        assert_eq!(pick(&two(), HY, &[], margins(0.0, 0.0, 0)), Some(0));
    }

    #[test]
    fn hybrid_min_legs_edge() {
        let one = legs(&[31.0]);
        let two_legs = legs(&[31.0, 31.0]);
        assert_eq!(pick(&two(), HY, &one, margins(1.0, 0.2, 2)), Some(0));
        assert_eq!(pick(&two(), HY, &two_legs, margins(1.0, 0.2, 2)), Some(1));
    }

    #[test]
    fn hybrid_absolute_margin_edge() {
        // production predicts 32, shortest 31; a leg at 30: errors 2 and 1,
        // a gain of exactly 1.0 (and exactly half of production's error)
        let c = vec![cand(120.0, 0.0, true, 31.0), cand(100.0, 0.0, false, 30.0)];
        let l = legs(&[30.0]);
        assert_eq!(pick(&c, HY, &l, margins(1.0, 0.0, 1)), Some(1));
        assert_eq!(pick(&c, HY, &l, margins(1.01, 0.0, 1)), Some(0));
        assert_eq!(pick(&c, HY, &l, margins(1.0, 0.5, 1)), Some(1));
        assert_eq!(pick(&c, HY, &l, margins(1.0, 0.51, 1)), Some(0));
    }

    #[test]
    fn hybrid_relative_margin_edge() {
        // a leg at 21: production error 20, shortest 10 (half of it)
        let l = legs(&[21.0]);
        assert_eq!(pick(&two(), HY, &l, margins(1.0, 0.5, 1)), Some(1));
        assert_eq!(pick(&two(), HY, &l, margins(1.0, 0.51, 1)), Some(0));
        // both margins must hold: the absolute floor applies too
        assert_eq!(pick(&two(), HY, &l, margins(10.0, 0.5, 1)), Some(1));
        assert_eq!(pick(&two(), HY, &l, margins(10.5, 0.0, 1)), Some(0));
    }

    #[test]
    fn hybrid_ignores_timetables_slower_than_production() {
        // legs at 60: slower than every path. A 60-minute detour fits them
        // exactly but is no evidence: a train can always run slower.
        let mut c = two();
        c.push(cand(200.0, 0.0, false, 59.0));
        let l = legs(&[60.0, 60.0]);
        assert_eq!(pick(&c, HY, &l, margins(0.5, 0.0, 1)), Some(0));
    }

    #[test]
    fn hybrid_takes_the_best_fitting_alternative() {
        // production 0 (120 km, 41), slow short line 1 (100 km, 45),
        // fast line 2 (110 km, 31); legs at 31
        let mut c = vec![cand(120.0, 0.0, true, 40.0), cand(100.0, 0.0, false, 44.0)];
        c.push(cand(110.0, 0.0, false, 30.0));
        let l = legs(&[31.0, 31.0]);
        assert_eq!(pick(&c, HY, &l, margins(1.0, 0.2, 1)), Some(2));
        // equally good alternatives: the shorter one
        c.push(cand(105.0, 0.0, false, 29.0));
        assert_eq!(pick(&c, HY, &l, margins(1.0, 0.2, 1)), Some(3));
        // a gapped candidate is never an alternative (and the slow line,
        // error 14 vs 10, is worse than production)
        c[2].gap_km = 0.5;
        c[3].gap_km = 0.5;
        assert_eq!(pick(&c, HY, &l, margins(1.0, 0.2, 1)), Some(0));
    }

    #[test]
    fn hybrid_is_class_aware() {
        // shortest 1 is dedicated HSR: a K leg cannot use it, so a pair
        // with K legs never moves to it; G legs alone can move it
        let mut c = two();
        c[1].hsr_km = 50.0;
        let (g, k) = (class_index("G"), class_index("K"));
        let mixed = [
            LegTime {
                class: g,
                minutes: 31.0,
            },
            LegTime {
                class: k,
                minutes: 41.0,
            },
        ];
        assert_eq!(pick(&c, HY, &mixed, margins(1.0, 0.2, 1)), Some(0));
        let only_g = [LegTime {
            class: g,
            minutes: 34.1,
        }];
        assert_eq!(pick(&c, HY, &only_g, margins(1.0, 0.2, 1)), Some(1));
        // the class ratio scales the prediction: with G scheduled at 1.1x
        // the model, production predicts 45.1 (error 11) and shortest 34.1
        // (error ~0); unscaled the errors are 6.9 and 0
        let mut ratio = ONE;
        ratio[g] = 1.1;
        let cfg = CanonConfig {
            mode: HY,
            ..margins(10.9, 0.0, 1)
        };
        let ev = Evidence {
            legs: &only_g,
            ratio: &ratio,
        };
        assert_eq!(best_for_canon(&c, &ev, &cfg), Some(1));
        let ev1 = Evidence {
            legs: &only_g,
            ratio: &ONE,
        };
        // unscaled: production 41 (error 6.9) does not clear 10.9
        assert_eq!(best_for_canon(&c, &ev1, &cfg), Some(0));
    }
}
