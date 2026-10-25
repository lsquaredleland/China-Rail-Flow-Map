//! Demonstrated corridors: stopping services between a pair's two
//! stations (up to `max_intermediate` intermediate stops), per routing
//! group, and which candidates their intermediate stops all lie on.
use crate::classes::{class_group, class_index, NGROUP};
use crate::config::EvidenceConfig;
use crate::legs::{pair_key, Key, PairInfo};
use crate::model::{Cand, Shape};
use crate::schedule::Train;
use crate::stations::Stations;
use rayon::prelude::*;
use std::collections::HashMap;

/// Per pair: per-candidate counts of compatible stopping services and
/// the number of services, each by routing group.
pub type SvcCounts = (Vec<[u32; NGROUP]>, [u32; NGROUP]);

pub fn service_counts(
    trains: &[Train],
    pairs: &[PairInfo],
    cands: &[Vec<Cand>],
    shapes: &[Vec<Shape>],
    pair_idx: &HashMap<&Key, usize>,
    stations: &Stations,
    cfg: &EvidenceConfig,
) -> Vec<SvcCounts> {
    let spans: Vec<(usize, usize, Vec<bool>)> = trains
        .par_iter()
        .flat_map_iter(|t| {
            let gidx = class_group(class_index(&t.class));
            let names: Vec<&String> = t.stops.iter().map(|s| &s.name).collect();
            let mut out = Vec::new();
            for i in 0..names.len() {
                let hi = (i + cfg.max_intermediate + 2).min(names.len());
                for j in i + 2..hi {
                    let (a, c) = (names[i], names[j]);
                    if a == c {
                        continue;
                    }
                    let (key, _) = pair_key(a, c);
                    let Some(&pi) = pair_idx.get(&key) else {
                        continue;
                    };
                    if cands[pi].is_empty() {
                        continue;
                    }
                    let p = &pairs[pi];
                    let pts: Option<Vec<[f64; 2]>> = names[i + 1..j]
                        .iter()
                        .map(|n| stations.stop_point(n, p.pa, p.pb))
                        .collect();
                    let Some(pts) = pts else {
                        continue;
                    };
                    let compat: Vec<bool> = shapes[pi]
                        .iter()
                        .map(|s| pts.iter().all(|q| s.near(*q, cfg.stop_km)))
                        .collect();
                    if compat.iter().any(|x| *x) {
                        out.push((pi, gidx, compat));
                    }
                }
            }
            out.into_iter()
        })
        .collect();
    let mut svc: Vec<SvcCounts> = cands
        .iter()
        .map(|cs| (vec![[0u32; NGROUP]; cs.len()], [0u32; NGROUP]))
        .collect();
    for (pi, gidx, compat) in spans {
        svc[pi].1[gidx] += 1;
        for (k, ok) in compat.iter().enumerate() {
            if *ok {
                svc[pi].0[k][gidx] += 1;
            }
        }
    }
    svc
}
