//! The static-flow counting rule, shared by every flow table `atlas` builds
//! (per-city outbound, per-city inbound, national):
//!
//! - a train counts once per atomic track edge, however many of its legs'
//!   paths cover that edge (re-covered track counts once);
//! - edges whose midpoint lies near a stop (`near_station`, 1.3 km) are left
//!   out: they are station throats, not flow sections;
//! - counts are split into the 8 class buckets of `cn::classes::class_idx`.
//!
//! [`train_edges`] is the one implementation of the first two rules; the
//! per-city counts and the national table both call it.

use std::collections::{HashMap, HashSet};

/// An undirected atomic track edge, `(lower node id, higher node id)`.
pub type Edge = (i64, i64);

/// The edges one train covers on `legs`, each once. `seqs` gives a leg's
/// node sequences (`None` = unresolved leg, skipped); `near_station` is the
/// throat test on an edge midpoint (`[lon, lat]`).
pub fn train_edges<'k, 's, K: 'k>(
    legs: impl IntoIterator<Item = &'k K>,
    seqs: impl Fn(&K) -> Option<&'s Vec<Vec<i64>>>,
    coords: &HashMap<i64, [f64; 2]>,
    near_station: impl Fn(&[f64; 2]) -> bool,
) -> HashSet<Edge> {
    let mut eset: HashSet<Edge> = HashSet::new();
    for key in legs {
        let Some(seqs) = seqs(key) else { continue };
        for s in seqs.iter() {
            for win in s.windows(2) {
                let (c1, c2) = match (coords.get(&win[0]), coords.get(&win[1])) {
                    (Some(x), Some(y)) => (*x, *y),
                    _ => continue,
                };
                let mid = [(c1[0] + c2[0]) / 2.0, (c1[1] + c2[1]) / 2.0];
                if near_station(&mid) {
                    continue;
                }
                eset.insert(if win[0] < win[1] {
                    (win[0], win[1])
                } else {
                    (win[1], win[0])
                });
            }
        }
    }
    eset
}

/// The national per-section table: per section, the distinct trains that
/// cover any of its edges (`total`), split by class (`by_class[c][s]`).
#[derive(Debug, Default, PartialEq, serde::Serialize)]
pub struct National {
    /// Distinct trains with at least one counted edge on a section.
    pub trains: usize,
    pub total: Vec<u32>,
    pub by_class: Vec<Vec<u32>>,
}

/// How far the per-edge national counts vary inside one section (the
/// sections are cut where per-city counts change, not national ones).
#[derive(Debug, Default, PartialEq)]
pub struct Uniformity {
    /// Sections whose edges do not all carry the same national count.
    pub nonuniform: usize,
    /// Largest (max - min) per-edge national count inside one section.
    pub max_spread: u32,
    /// Sections whose distinct-train total exceeds their busiest edge.
    pub union_above_max: usize,
    /// Largest (total - busiest edge) over the sections.
    pub max_union_gain: u32,
}

/// Map per-train edge sets onto `n_sections` sections. `trains` yields
/// `(train id, class bucket, edge set)` with each train id at most once;
/// `edge_sec` maps an edge to its section (`None` = on no section: a throat
/// or track no section carries). A train counts once on a section when it
/// covers any of the section's edges, so the section value is the union of
/// its edges' train sets: never below any edge's count, hence never below
/// any single origin's (constant) count on the section.
pub fn national_table(
    trains: impl IntoIterator<Item = (usize, usize, HashSet<Edge>)>,
    edge_sec: impl Fn(&Edge) -> Option<usize>,
    n_sections: usize,
) -> (National, Uniformity) {
    let mut total = vec![0u32; n_sections];
    let mut by_class = vec![vec![0u32; n_sections]; 8];
    let mut edge_n: HashMap<Edge, u32> = HashMap::new();
    let mut seen: HashSet<usize> = HashSet::new();
    let mut n_trains = 0usize;
    for (ti, cls, eset) in trains {
        assert!(seen.insert(ti), "train {ti} listed twice");
        let mut secs: Vec<usize> = Vec::new();
        for e in eset.iter() {
            if let Some(s) = edge_sec(e) {
                secs.push(s);
                *edge_n.entry(*e).or_insert(0) += 1;
            }
        }
        secs.sort_unstable();
        secs.dedup();
        n_trains += !secs.is_empty() as usize;
        for s in secs {
            total[s] += 1;
            by_class[cls][s] += 1;
        }
    }
    let mut lo = vec![u32::MAX; n_sections];
    let mut hi = vec![0u32; n_sections];
    for (e, n) in edge_n.iter() {
        let s = edge_sec(e).unwrap();
        lo[s] = lo[s].min(*n);
        hi[s] = hi[s].max(*n);
    }
    let mut u = Uniformity::default();
    for s in 0..n_sections {
        if hi[s] == 0 {
            continue;
        }
        if lo[s] != hi[s] {
            u.nonuniform += 1;
            u.max_spread = u.max_spread.max(hi[s] - lo[s]);
        }
        if total[s] > hi[s] {
            u.union_above_max += 1;
            u.max_union_gain = u.max_union_gain.max(total[s] - hi[s]);
        }
    }
    let nat = National {
        trains: n_trains,
        total,
        by_class,
    };
    (nat, u)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Nodes 1..=6 on a line, 0.1 deg apart.
    fn coords() -> HashMap<i64, [f64; 2]> {
        (1..=6).map(|i| (i, [0.1 * i as f64, 0.0])).collect()
    }

    #[test]
    fn train_edges_counts_recovered_track_once_and_skips_throats() {
        let c = coords();
        let legs: HashMap<&str, Vec<Vec<i64>>> = [
            ("a", vec![vec![1, 2, 3]]),
            // runs back over 2-3, then on to 4
            ("b", vec![vec![3, 2], vec![2, 3, 4]]),
        ]
        .into_iter()
        .collect();
        let keys = ["a", "b", "missing"];
        // a "station" around node 4's neighbourhood: edge 3-4 midpoint
        let near = |p: &[f64; 2]| (p[0] - 0.35).abs() < 1e-9;
        let e = train_edges(keys.iter(), |k| legs.get(k), &c, near);
        let mut v: Vec<Edge> = e.into_iter().collect();
        v.sort();
        assert_eq!(v, vec![(1, 2), (2, 3)]);
    }

    #[test]
    fn national_counts_a_train_once_per_section_and_reports_spread() {
        // section 0 = edges (1,2),(2,3); section 1 = edge (3,4)
        let sec = |e: &Edge| match e {
            (1, 2) | (2, 3) => Some(0),
            (3, 4) => Some(1),
            _ => None,
        };
        let set = |es: &[Edge]| es.iter().copied().collect::<HashSet<Edge>>();
        let trains = vec![
            (0, 0, set(&[(1, 2), (2, 3), (3, 4)])),
            (1, 6, set(&[(2, 3)])),
            (2, 6, set(&[(1, 2)])),
            (3, 1, set(&[(5, 6)])), // on no section
        ];
        let (nat, u) = national_table(trains, sec, 2);
        assert_eq!(nat.trains, 3);
        assert_eq!(nat.total, vec![3, 1]);
        assert_eq!(nat.by_class[0], vec![1, 1]);
        assert_eq!(nat.by_class[6], vec![2, 0]);
        for s in 0..2 {
            assert_eq!(nat.by_class.iter().map(|c| c[s]).sum::<u32>(), nat.total[s]);
        }
        // section 0: both edges carry 2 trains, but 3 distinct trains overall
        assert_eq!(
            u,
            Uniformity {
                nonuniform: 0,
                max_spread: 0,
                union_above_max: 1,
                max_union_gain: 1,
            }
        );
    }

    #[test]
    fn national_reports_nonuniform_sections() {
        let sec = |e: &Edge| (e.0 < 4).then_some(0);
        let set = |es: &[Edge]| es.iter().copied().collect::<HashSet<Edge>>();
        let trains = vec![
            (0, 0, set(&[(1, 2), (2, 3)])),
            (1, 0, set(&[(1, 2), (2, 3)])),
            (2, 0, set(&[(2, 3)])),
        ];
        let (nat, u) = national_table(trains, sec, 1);
        assert_eq!(nat.total, vec![3]);
        assert_eq!((u.nonuniform, u.max_spread), (1, 1));
        assert_eq!(u.union_above_max, 0);
    }
}
