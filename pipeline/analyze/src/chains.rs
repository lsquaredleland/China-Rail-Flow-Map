//! Section chaining shared by `atlas` and `audit`: edges that carry the same
//! count signature form one chain through every node where they are the
//! only two such edges; at a junction (3+ edges) the chain also needs both
//! edges to carry the same trains, so two branches that only happen to
//! carry equal counts stay separate sections. Everything
//! here is order-independent (sorted seeds, sorted adjacency, canonical
//! direction) so section ids and polyline directions do not depend on
//! `HashMap` iteration order.

use std::collections::{HashMap, HashSet};

/// Per-city `(city, distinct trains, per-class trains)` of one atomic edge.
pub type Sig = Vec<(usize, u64, [u32; 8])>;

/// Per edge, a fingerprint of the trains counted on it ([`train_mark`]
/// summed over them), which the chains compare at junctions.
pub type EdgeTrains = HashMap<(i64, i64), u64>;

/// One train's term of an [`EdgeTrains`] fingerprint: train `k` of city `ci`
/// (splitmix64 of the pair). Sums of these are equal for equal train sets,
/// and differ for different ones but with negligible chance.
pub fn train_mark(ci: usize, k: usize) -> u64 {
    let mut z = ((ci as u64) << 32 | k as u64).wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// Intern edge signatures. Ids are assigned in sorted-signature order.
pub fn intern_sigs(
    edge_counts: &HashMap<(i64, i64), HashMap<usize, u64>>,
    edge_class_counts: &HashMap<(i64, i64), HashMap<usize, [u32; 8]>>,
) -> (Vec<Sig>, HashMap<(i64, i64), u32>) {
    let per_edge: Vec<((i64, i64), Sig)> = edge_counts
        .iter()
        .map(|(e, m)| {
            let mut sig: Sig = m
                .iter()
                .map(|(c, n)| {
                    let cls = edge_class_counts
                        .get(e)
                        .and_then(|cm| cm.get(c))
                        .copied()
                        .unwrap_or([0; 8]);
                    (*c, *n, cls)
                })
                .collect();
            sig.sort();
            (*e, sig)
        })
        .collect();
    let mut sig_list: Vec<Sig> = per_edge.iter().map(|(_, s)| s.clone()).collect();
    sig_list.sort();
    sig_list.dedup();
    let edge_sig = {
        let ids: HashMap<&Sig, u32> = sig_list
            .iter()
            .enumerate()
            .map(|(i, s)| (s, i as u32))
            .collect();
        per_edge.iter().map(|(e, s)| (*e, ids[s])).collect()
    };
    (sig_list, edge_sig)
}

/// Chains of equal-signature edges, ordered by their smallest edge and
/// oriented so the lower end node comes first. At a node with 3+ edges a
/// chain continues only onto an edge with the same `edge_trains`
/// fingerprint (edges missing from it compare equal).
pub fn build_section_chains(
    edge_sig: &HashMap<(i64, i64), u32>,
    edge_trains: &EdgeTrains,
) -> Vec<(u32, Vec<i64>)> {
    let mut seeds: Vec<((i64, i64), u32)> = edge_sig.iter().map(|(e, s)| (*e, *s)).collect();
    seeds.sort_unstable();
    let mut nadj: HashMap<i64, Vec<(i64, u32)>> = HashMap::new();
    for (e, sid) in seeds.iter() {
        nadj.entry(e.0).or_default().push((e.1, *sid));
        nadj.entry(e.1).or_default().push((e.0, *sid));
    }
    for v in nadj.values_mut() {
        v.sort_unstable();
    }
    let ekey = |u: i64, v: i64| if u < v { (u, v) } else { (v, u) };
    let next_of = |nadj: &HashMap<i64, Vec<(i64, u32)>>,
                   used: &HashSet<(i64, i64)>,
                   cur: i64,
                   from: i64,
                   sid: u32|
     -> Option<i64> {
        let all = nadj.get(&cur).map(|v| v.as_slice()).unwrap_or_default();
        let cands: Vec<i64> = all
            .iter()
            .filter(|(n, s)| *n != from && *s == sid)
            .map(|(n, _)| *n)
            .collect();
        let same_trains = |n: i64| {
            all.len() < 3 || edge_trains.get(&ekey(from, cur)) == edge_trains.get(&ekey(cur, n))
        };
        if cands.len() == 1 && !used.contains(&ekey(cur, cands[0])) && same_trains(cands[0]) {
            Some(cands[0])
        } else {
            None
        }
    };
    let mut used: HashSet<(i64, i64)> = HashSet::new();
    let mut chains: Vec<(u32, Vec<i64>)> = Vec::new();
    for (e, sid) in seeds.iter() {
        if used.contains(e) {
            continue;
        }
        let sid = *sid;
        let mut chain: Vec<i64> = vec![e.0, e.1];
        used.insert(*e);
        while let Some(n) = next_of(
            &nadj,
            &used,
            *chain.last().unwrap(),
            chain[chain.len() - 2],
            sid,
        ) {
            used.insert(ekey(*chain.last().unwrap(), n));
            chain.push(n);
        }
        let mut head: Vec<i64> = Vec::new();
        loop {
            let (cur, from) = match head.len() {
                0 => (chain[0], chain[1]),
                1 => (head[0], chain[0]),
                n => (head[n - 1], head[n - 2]),
            };
            match next_of(&nadj, &used, cur, from, sid) {
                Some(n) => {
                    used.insert(ekey(cur, n));
                    head.push(n);
                }
                None => break,
            }
        }
        if !head.is_empty() {
            head.reverse();
            head.extend(chain);
            chain = head;
        }
        // canonical direction (rings: first == last, so compare the
        // neighbours instead)
        let n = chain.len();
        let flip = if chain[0] != chain[n - 1] {
            chain[0] > chain[n - 1]
        } else {
            chain[1] > chain[n - 2]
        };
        if flip {
            chain.reverse();
        }
        chains.push((sid, chain));
    }
    chains
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sigs(edges: &[((i64, i64), u32)]) -> HashMap<(i64, i64), u32> {
        edges.iter().copied().collect()
    }

    #[test]
    fn path_is_oriented_low_end_first_and_split_at_signature_change() {
        // 9-5-3 (sig 0) then 3-4-8 (sig 1): two chains, each starting at its lower end
        let c = build_section_chains(
            &sigs(&[((5, 9), 0), ((3, 5), 0), ((3, 4), 1), ((4, 8), 1)]),
            &EdgeTrains::new(),
        );
        // ordered by each chain's smallest edge
        assert_eq!(c, vec![(1, vec![3, 4, 8]), (0, vec![3, 5, 9])]);
    }

    #[test]
    fn junction_splits_branches_with_equal_counts_but_other_trains() {
        // 1-2-3 trunk (sig 1) meets two branches 3-4 and 3-5 (sig 0) at 3
        let e = sigs(&[((1, 2), 1), ((2, 3), 1), ((3, 4), 0), ((3, 5), 0)]);
        let mark = |es: &[(i64, i64)], m: u64| es.iter().map(|&k| (k, m)).collect::<Vec<_>>();
        // the same trains on both branches: one chain through the junction
        let same: EdgeTrains = mark(&[(1, 2), (2, 3)], 7)
            .into_iter()
            .chain(mark(&[(3, 4), (3, 5)], 9))
            .collect();
        let c = build_section_chains(&e, &same);
        assert_eq!(c, vec![(1, vec![1, 2, 3]), (0, vec![4, 3, 5])]);
        // other trains on each branch: a V, cut at the junction
        let other: EdgeTrains = mark(&[(1, 2), (2, 3)], 7)
            .into_iter()
            .chain(mark(&[(3, 4)], train_mark(0, 0)))
            .chain(mark(&[(3, 5)], train_mark(0, 1)))
            .collect();
        let c = build_section_chains(&e, &other);
        assert_eq!(
            c,
            vec![(1, vec![1, 2, 3]), (0, vec![3, 4]), (0, vec![3, 5])]
        );
        // a degree-2 node never compares trains
        let line = sigs(&[((1, 2), 0), ((2, 3), 0)]);
        let c = build_section_chains(&line, &[((1, 2), 1), ((2, 3), 2)].into_iter().collect());
        assert_eq!(c, vec![(0, vec![1, 2, 3])]);
    }

    #[test]
    fn ring_is_deterministic() {
        let ring = [((1, 2), 0), ((2, 3), 0), ((3, 4), 0), ((1, 4), 0)];
        let c = build_section_chains(&sigs(&ring), &EdgeTrains::new());
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].1.first(), c[0].1.last());
        for _ in 0..20 {
            assert_eq!(build_section_chains(&sigs(&ring), &EdgeTrains::new()), c);
        }
    }

    #[test]
    fn class_split_cuts_a_chain() {
        let mut counts: HashMap<(i64, i64), HashMap<usize, u64>> = HashMap::new();
        let mut classes: HashMap<(i64, i64), HashMap<usize, [u32; 8]>> = HashMap::new();
        for (e, cls) in [((1, 2), 0usize), ((2, 3), 1)] {
            counts.entry(e).or_default().insert(0, 2);
            let mut v = [0u32; 8];
            v[cls] = 2;
            classes.entry(e).or_default().insert(0, v);
        }
        let (list, edge_sig) = intern_sigs(&counts, &classes);
        assert_eq!(list.len(), 2);
        assert_eq!(build_section_chains(&edge_sig, &EdgeTrains::new()).len(), 2);
    }
}
