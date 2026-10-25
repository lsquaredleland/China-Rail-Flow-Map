//! Candidate corridors per station pair: fastest per class group present,
//! shortest, penalty-diversified alternatives, plus the baseline geometry.
use crate::classes::CLASS_NAMES;
use crate::config::CandidateConfig;
use crate::graph::{route, Buffers, FineIndex, Graph, Metric, Snap};
use crate::legs::PairInfo;
use crate::model::{self, Cand, Shape};
use std::collections::{HashMap, HashSet};

/// Candidate corridors for one pair.
#[allow(clippy::too_many_arguments)]
pub fn gen_candidates(
    g: &Graph,
    fine: &FineIndex,
    buf: &mut Buffers,
    p: &PairInfo,
    sa: &Snap,
    sb: &Snap,
    base: Option<&(String, Vec<Vec<u64>>)>,
    cfg: &CandidateConfig,
) -> Vec<Cand> {
    let mut cands: Vec<Cand> = Vec::new();
    let mut sets: Vec<Shape> = Vec::new();
    let no_pen: HashMap<(u32, u32), f64> = HashMap::new();
    let dist_cap = (cfg.max_len_chord * p.chord + 40.0).max(p.chord * 2.5 + 5.0);
    let time_cap = dist_cap / 40.0;
    let accept = |c: Cand, cands: &mut Vec<Cand>, sets: &mut Vec<Shape>| {
        if c.km > dist_cap {
            return;
        }
        let kmin = cands.iter().map(|k| k.km).fold(c.km, f64::min);
        if c.km > cfg.max_len_shortest * kmin + 30.0 {
            return;
        }
        // distinct = a real share of the new path runs away from every
        // existing corridor
        let sh = Shape::of(g, &c);
        if sets.iter().all(|s| sh.covered_by(s) < cfg.distinct_overlap) {
            cands.push(c);
            sets.push(sh);
        }
    };
    // fastest per class group present on the pair, then shortest
    let mut metrics: Vec<(String, Metric)> = Vec::new();
    let mut seen_caps: HashSet<(u64, u64)> = HashSet::new();
    for (c, name) in CLASS_NAMES.iter().enumerate() {
        if p.class_mask & (1 << c) == 0 {
            continue;
        }
        let m = model::class_metric(c);
        if let Metric::Time { cap, hsr_mult } = m {
            if seen_caps.insert((cap.to_bits(), hsr_mult.to_bits())) {
                metrics.push((format!("fast-{name}"), m));
            }
        }
    }
    metrics.push(("shortest".into(), Metric::Distance));
    for (name, m) in &metrics {
        let cap = if matches!(m, Metric::Distance) {
            dist_cap
        } else {
            time_cap
        };
        if let Some((_, path)) = route(g, buf, sa, sb, p.pb, *m, &no_pen, cap) {
            accept(Cand::measure(g, path, name), &mut cands, &mut sets);
        }
    }
    // penalty-diversified alternatives under the dominant class's metric
    let dm = model::class_metric(p.dominant);
    let mut pen: HashMap<(u32, u32), f64> = HashMap::new();
    for r in 0..cfg.penalty_rounds {
        if cands.is_empty() {
            break;
        }
        // penalise every edge within 150 m of a found corridor (both
        // tracks of double-track lines, station loops), not just its own
        for s in &sets {
            for &p in s.samples() {
                for u in fine.near(g, p, 0.15) {
                    for e in &g.adj[u as usize] {
                        pen.insert((u.min(e.to), u.max(e.to)), cfg.penalty_mult);
                    }
                }
            }
        }
        let before = cands.len();
        if let Some((_, path)) = route(g, buf, sa, sb, p.pb, dm, &pen, time_cap * 2.0) {
            accept(
                Cand::measure(g, path, &format!("alt-{}", r + 1)),
                &mut cands,
                &mut sets,
            );
        }
        if cands.len() == before {
            break;
        }
    }
    // the production geometry
    if let Some((_, segs)) = base {
        let mut nodes: Vec<u32> = Vec::new();
        let mut ok = !segs.is_empty();
        for s in segs {
            for id in s {
                match g.index_of(*id) {
                    Some(i) => {
                        if nodes.last() != Some(&i) {
                            nodes.push(i)
                        }
                    }
                    None => ok = false,
                }
            }
        }
        if ok && nodes.len() >= 2 {
            let mut bc = Cand::measure(g, nodes, "production");
            bc.is_base = true;
            let sh = Shape::of(g, &bc);
            let same = sets.iter().position(|s| {
                bc.gap_km == 0.0
                    && sh.covered_by(s) >= cfg.base_same_overlap
                    && s.covered_by(&sh) >= cfg.base_same_overlap
            });
            match same {
                Some(i) => {
                    // keep production's exact geometry for that corridor
                    cands[i] = bc;
                    sets[i] = sh;
                }
                None => {
                    cands.push(bc);
                    sets.push(sh);
                }
            }
        }
    }
    cands
}
