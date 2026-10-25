//! Double track as one corridor, for the map. Every pair's canonical
//! path is redrawn within `buffer_km` of itself onto the busiest track
//! (`rounds` rounds, so "busiest" is judged on already-merged usage);
//! then every chosen non-production corridor is redrawn the same way.
//!
//! The canonical-geometry selection is `best_for_canon` below.
use crate::config::CanonConfig;
use crate::graph::{self, route_custom, Buffers, FineIndex, Graph};
use crate::model::{Cand, Shape};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};

/// Train-legs per undirected edge.
pub type Usage = HashMap<(u32, u32), u32>;

/// The candidate whose redraw becomes pair `pi`'s canonical geometry.
pub fn best_for_canon(cands: &[Vec<Cand>], pi: usize) -> Option<&Cand> {
    cands[pi]
        .iter()
        .filter(|c| c.gap_km == 0.0)
        .min_by(|a, b| a.km.total_cmp(&b.km))
        .or_else(|| cands[pi].iter().find(|c| c.is_base))
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
/// track usage it implies. `weight(pi)` is pair `pi`'s train-leg count.
pub fn canonical(
    g: &Graph,
    fine: &FineIndex,
    cands: &[Vec<Cand>],
    weight: &(dyn Fn(usize) -> u32 + Sync),
    cfg: &CanonConfig,
) -> (Vec<Option<Cand>>, Usage) {
    let mut usage = edge_usage(
        cands
            .iter()
            .enumerate()
            .filter_map(|(pi, _)| best_for_canon(cands, pi).map(|b| (b, weight(pi)))),
    );
    let mut canon: Vec<Option<Cand>> = vec![None; cands.len()];
    for _round in 0..cfg.rounds {
        canon = (0..cands.len())
            .into_par_iter()
            .map_init(
                || Buffers::new(g.coords.len()),
                |buf, pi| {
                    best_for_canon(cands, pi)
                        .map(|b| redraw(g, fine, buf, b, &usage, cfg.buffer_km))
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
