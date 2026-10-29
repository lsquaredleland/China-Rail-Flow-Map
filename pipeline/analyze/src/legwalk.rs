//! A leg's walk over its track segments, station throats and one row's path
//! of sections.

use std::collections::{HashMap, HashSet};

use crate::geo::hav_km_ll;

/// Internal gap (km) above which a resolved leg counts as a chord leg:
/// its geometry has a hole the client must bridge, not animate along.
const CHORD_GAP_KM: f64 = 3.0;

/// A resolved leg's segments as one walk from key.0 to key.1: the
/// segment order and, per segment, whether it is walked against its
/// stored vertex order. Stored geometry is not reliably key-ordered
/// (per-train router paths run in their own train's direction; corridor
/// chains concatenate pair paths in each pair's own order), so the walk
/// is derived from coordinates.
pub struct LegWalk {
    pub steps: Vec<(usize, bool)>,
    /// Largest hole in the walk (km): between consecutive segments, or
    /// between consecutive nodes with coordinates inside one segment
    /// (nodes missing from the extract carry no sections).
    pub max_gap: f64,
}

/// Largest distance (km) spanned by a run of nodes missing coordinates;
/// infinite when a run of 2+ such nodes is at either end of the segment
/// (its length is unknown, and the path stops short of the station).
pub fn seg_hole(s: &[i64], coords: &HashMap<i64, [f64; 2]>) -> f64 {
    let (mut last, mut skipped, mut hole) = (None::<[f64; 2]>, 0usize, 0.0f64);
    for id in s {
        match coords.get(id) {
            Some(p) => {
                match last {
                    Some(q) if skipped > 0 => hole = hole.max(hav_km_ll(q, *p)),
                    None if skipped >= 2 => hole = f64::INFINITY,
                    _ => {}
                }
                last = Some(*p);
                skipped = 0;
            }
            None => skipped += 1,
        }
    }
    if skipped >= 2 {
        hole = f64::INFINITY;
    }
    hole
}

/// Greedy walk over `seqs` from point `from` ([lon, lat]): repeatedly
/// take the unused segment end nearest the current position. Returns the
/// steps, the summed gaps incl. the final hop to `to`, the largest inner
/// gap, and the larger of the two station-to-path gaps.
fn greedy_walk(
    ends: &[Option<([f64; 2], [f64; 2])>],
    from: [f64; 2],
    to: [f64; 2],
) -> (Vec<(usize, bool)>, f64, f64, f64) {
    let mut used = vec![false; ends.len()];
    let mut steps: Vec<(usize, bool)> = Vec::new();
    let (mut cur, mut cost, mut max_gap, mut end_gap) = (from, 0.0f64, 0.0f64, 0.0f64);
    loop {
        let mut best: Option<(usize, bool, f64)> = None;
        for (i, e) in ends.iter().enumerate() {
            if used[i] {
                continue;
            }
            if let Some((s, t)) = e {
                for (flip, entry) in [(false, *s), (true, *t)] {
                    let d = hav_km_ll(cur, entry);
                    if best.is_none_or(|(_, _, bd)| d < bd) {
                        best = Some((i, flip, d));
                    }
                }
            }
        }
        let Some((i, flip, d)) = best else { break };
        used[i] = true;
        cost += d;
        if steps.is_empty() {
            end_gap = d;
        } else {
            max_gap = max_gap.max(d);
        }
        steps.push((i, flip));
        let (s, t) = ends[i].unwrap();
        cur = if flip { s } else { t };
    }
    let last = hav_km_ll(cur, to);
    (steps, cost + last, max_gap, end_gap.max(last))
}

/// Orient a resolved leg's segments key.0 -> key.1 (station points
/// [lon, lat]). Segments without coordinates carry no sections and are
/// left out. The walk is grown from both ends and the cheaper one kept.
/// Also returns the walk's larger station-to-path gap: a large one means
/// a station point is wrong (homonyms), so the orientation is untrusted.
pub fn orient_leg(
    seqs: &[Vec<i64>],
    coords: &HashMap<i64, [f64; 2]>,
    p0: [f64; 2],
    p1: [f64; 2],
) -> (LegWalk, f64) {
    let ends: Vec<Option<([f64; 2], [f64; 2])>> = seqs
        .iter()
        .map(|s| {
            let first = s.iter().find_map(|id| coords.get(id))?;
            let last = s.iter().rev().find_map(|id| coords.get(id))?;
            Some((*first, *last))
        })
        .collect();
    let hole = seqs.iter().map(|s| seg_hole(s, coords)).fold(0.0, f64::max);
    let (fw, fw_cost, fw_gap, fw_end) = greedy_walk(&ends, p0, p1);
    let (bw, bw_cost, bw_gap, bw_end) = greedy_walk(&ends, p1, p0);
    if bw_cost < fw_cost {
        let steps = bw.iter().rev().map(|&(i, f)| (i, !f)).collect();
        (
            LegWalk {
                steps,
                max_gap: bw_gap.max(hole),
            },
            bw_end,
        )
    } else {
        (
            LegWalk {
                steps: fw,
                max_gap: fw_gap.max(hole),
            },
            fw_end,
        )
    }
}

/// Station-to-path gap (km) above which a leg's station points are not
/// trusted for orientation; the stored segment order is used instead.
pub const ORIENT_TRUST_KM: f64 = 10.0;

/// Station-throat pieces (O1): track edges that `near_station` trims from
/// the flow sections, kept as geometry only so per-train paths run through
/// stations. One piece = a maximal run of consecutive trimmed edges inside
/// one leg's walk, interned globally by node chain (either direction).
#[derive(Default, Clone)]
pub struct Throats {
    ids: HashMap<Vec<i64>, usize>,
    pub chains: Vec<Vec<i64>>,
}

/// Throat runs shorter than this (km) are not emitted (sub-rounding slivers).
const THROAT_MIN_KM: f64 = 0.02;

impl Throats {
    /// Intern node chain `c` (travel order): (throat index, walked against
    /// its stored order), or None for a sliver (shorter than `min_km`).
    fn intern(
        &mut self,
        c: &[i64],
        coords: &HashMap<i64, [f64; 2]>,
        min_km: f64,
    ) -> Option<(usize, bool)> {
        let km: f64 = c
            .windows(2)
            .map(|w| hav_km_ll(coords[&w[0]], coords[&w[1]]))
            .sum();
        if km < min_km {
            return None;
        }
        let rev: Vec<i64> = c.iter().rev().copied().collect();
        let (key, flip) = if rev[..] < c[..] {
            (rev, true)
        } else {
            (c.to_vec(), false)
        };
        let j = match self.ids.get(&key) {
            Some(&j) => j,
            None => {
                let j = self.chains.len();
                self.ids.insert(key.clone(), j);
                self.chains.push(key);
                j
            }
        };
        Some((j, flip))
    }

    /// Close the current run of trimmed edges: append its throat entry
    /// (`base + j`, `!` when reversed) to `secs`. A run on flow section `on`
    /// (a stretch of a section the train only partly covers) is kept however
    /// short and recorded as `(throat index, section)` in `on_sec`; any other
    /// run shorter than THROAT_MIN_KM is a sliver and dropped.
    fn flush(
        &mut self,
        run: &mut Vec<i64>,
        secs: &mut Vec<i64>,
        coords: &HashMap<i64, [f64; 2]>,
        base: usize,
        on: Option<usize>,
        on_sec: &mut Vec<(usize, usize)>,
    ) {
        if run.len() >= 2 {
            let min_km = if on.is_some() { 0.0 } else { THROAT_MIN_KM };
            if let Some((j, flip)) = self.intern(run, coords, min_km) {
                let v = (base + j) as i64;
                secs.push(if flip { !v } else { v });
                if let Some(s) = on {
                    on_sec.push((j, s));
                }
            }
        }
        run.clear();
    }
}

/// Which throat run an edge `(u, v, midpoint)` is part of (see `row_path`).
pub type RunKey<'a> = dyn Fn(i64, i64, &[f64; 2]) -> Option<Option<usize>> + 'a;

/// A leg's resolved geometry and walk, if it has them (see `row_path`).
pub type LegGeom<'g> =
    dyn Fn(&(String, String, String)) -> Option<(&'g Vec<Vec<i64>>, &'g LegWalk)> + 'g;

/// One train row's path (O1): `secs` holds flow sections and throats in
/// travel order; `full_cnt[li]` = entries before leg li, `flow_cnt[li]` =
/// flow sections before leg li; chord legs in `secs` positions.
pub struct RowPath {
    pub secs: Vec<i64>,
    pub full_cnt: Vec<usize>,
    pub flow_cnt: Vec<usize>,
    pub chord_legs: Vec<[usize; 3]>,
    /// `(throat index, section)` for the throat entries that lie on a flow
    /// section (`run_key` gave `Some(Some(s))`).
    pub on_sec: Vec<(usize, usize)>,
}

/// Build one row's path over its legs. Edges `sec_of` maps (directed edge
/// -> section, travelled against its stored order) emit their flow section
/// exactly as before throats (consecutive repeats of the same signed section
/// collapse); runs of edges `run_key` trims (from the edge's nodes and
/// midpoint: `None` = not trimmed, `Some(on)` = trimmed, lying on flow
/// section `on` or on none) become throat entries `base + j`, one per run of
/// equal `on`. A flow repeat with only throats since the last flow
/// entry drops those throats too, so the flow-only sequence is unchanged;
/// `drops` counts [such drops, drops reaching back into an earlier leg].
///
/// Partial re-coverage: a run of one leg's edges over only part of a
/// section (`sec_edges[s]` edges) that the row also runs over whole (a
/// reversal at a station, a turn-back onto a branch) is drawn as a piece
/// on that section instead of the whole section again, so the path stays
/// continuous. The row's set of flow sections does not change.
#[allow(clippy::too_many_arguments)]
pub fn row_path<'g>(
    leg_keys: &[(String, String, String)],
    leg_fwd: &[bool],
    leg_stop: &[usize],
    geom: &LegGeom<'g>,
    sec_of: &dyn Fn(i64, i64) -> Option<(usize, bool)>,
    sec_edges: &[usize],
    run_key: &RunKey<'_>,
    coords: &HashMap<i64, [f64; 2]>,
    throats: &mut Throats,
    base: usize,
    drops: &mut [u64; 2],
) -> RowPath {
    let partial = partial_runs(leg_keys, leg_fwd, geom, sec_of, sec_edges);
    let mut visit = 0usize;
    let n = leg_keys.len();
    let mut p = RowPath {
        secs: Vec::new(),
        full_cnt: vec![0; n + 1],
        flow_cnt: vec![0; n + 1],
        chord_legs: Vec::new(),
        on_sec: Vec::new(),
    };
    let (mut last_flow, mut n_flow): (Option<usize>, usize) = (None, 0);
    for (li, key) in leg_keys.iter().enumerate() {
        let g = geom(key);
        if let Some((seqs, walk)) = g {
            let mut run: Vec<i64> = Vec::new();
            let mut run_on: Option<usize> = None;
            let mut flush = |run: &mut Vec<i64>, on: Option<usize>, secs: &mut Vec<i64>| {
                throats.flush(run, secs, coords, base, on, &mut p.on_sec)
            };
            walk_edges(seqs, walk, leg_fwd[li], |u, v| {
                let sec = sec_of(u, v);
                let piece = partial[visit];
                visit += 1;
                if let (Some((sidx, rev)), false) = (sec, piece) {
                    flush(&mut run, run_on, &mut p.secs);
                    let s = if rev { !(sidx as i64) } else { sidx as i64 };
                    match last_flow {
                        Some(k) if p.secs[k] == s => {
                            if p.secs.len() > k + 1 {
                                drops[0] += 1;
                                if k + 1 < p.full_cnt[li] {
                                    drops[1] += 1;
                                }
                                p.secs.truncate(k + 1);
                                let len = p.secs.len();
                                for c in p.full_cnt[..=li].iter_mut() {
                                    *c = (*c).min(len);
                                }
                                for l in p.chord_legs.iter_mut() {
                                    l[1] = l[1].min(len);
                                    l[2] = l[2].min(len);
                                }
                            }
                        }
                        _ => {
                            last_flow = Some(p.secs.len());
                            p.secs.push(s);
                            n_flow += 1;
                        }
                    }
                } else if let (Some(c1), Some(c2)) = (coords.get(&u), coords.get(&v)) {
                    let key = if piece {
                        Some(sec.map(|x| x.0))
                    } else {
                        run_key(u, v, &[(c1[0] + c2[0]) / 2.0, (c1[1] + c2[1]) / 2.0])
                    };
                    match key {
                        Some(on) => {
                            if run.last() != Some(&u) || on != run_on {
                                flush(&mut run, run_on, &mut p.secs);
                                run.push(u);
                            }
                            run_on = on;
                            run.push(v);
                        }
                        None => flush(&mut run, run_on, &mut p.secs),
                    }
                } else {
                    flush(&mut run, run_on, &mut p.secs);
                }
            });
            flush(&mut run, run_on, &mut p.secs);
        }
        if g.is_none_or(|(_, w)| w.max_gap > CHORD_GAP_KM) {
            p.chord_legs
                .push([leg_stop[li], p.full_cnt[li], p.secs.len()]);
        }
        p.full_cnt[li + 1] = p.secs.len();
        p.flow_cnt[li + 1] = n_flow;
    }
    p
}

/// Per edge visit of a row (its legs' walks in order, as `row_path` visits
/// them): whether the edge is on a run over part of a section that the
/// row also covers whole in one run. A run is a leg's consecutive edges on
/// one section; whole = all `sec_edges[s]` of its edges.
fn partial_runs<'g>(
    leg_keys: &[(String, String, String)],
    leg_fwd: &[bool],
    geom: &LegGeom<'g>,
    sec_of: &dyn Fn(i64, i64) -> Option<(usize, bool)>,
    sec_edges: &[usize],
) -> Vec<bool> {
    // per visit its run (index into `runs`); runs as (section, edges)
    let mut run_of: Vec<Option<usize>> = Vec::new();
    let mut runs: Vec<(usize, HashSet<(i64, i64)>)> = Vec::new();
    for (li, key) in leg_keys.iter().enumerate() {
        let Some((seqs, walk)) = geom(key) else {
            continue;
        };
        let mut open: Option<usize> = None;
        walk_edges(seqs, walk, leg_fwd[li], |u, v| match sec_of(u, v) {
            Some((s, _)) => {
                let r = match open {
                    Some(r) if runs[r].0 == s => r,
                    _ => {
                        runs.push((s, HashSet::new()));
                        runs.len() - 1
                    }
                };
                runs[r].1.insert((u.min(v), u.max(v)));
                open = Some(r);
                run_of.push(Some(r));
            }
            None => {
                open = None;
                run_of.push(None);
            }
        });
    }
    let whole = |r: usize| runs[r].1.len() == sec_edges[runs[r].0];
    let whole_secs: HashSet<usize> = (0..runs.len())
        .filter(|&r| whole(r))
        .map(|r| runs[r].0)
        .collect();
    run_of
        .iter()
        .map(|r| r.is_some_and(|r| !whole(r) && whole_secs.contains(&runs[r].0)))
        .collect()
}

/// Nodes where a row's walk leaves (or joins) a stretch of equal-signature
/// track that goes on past the node: it arrives on an edge of signature
/// `edge_sig` and then stops, turns back over that edge, or takes an edge
/// of another (or no) signature, while another edge of the same signature
/// meets the node. Cutting the section chains there makes every row run
/// whole sections (a reversal at a station or a junction re-runs only what
/// it really re-runs). Rows are `(leg keys, leg directions)`.
pub fn chain_cuts<'r, 'g>(
    rows: impl Iterator<Item = (&'r [(String, String, String)], &'r [bool])>,
    geom: &LegGeom<'g>,
    edge_sig: &HashMap<(i64, i64), u32>,
) -> HashSet<i64> {
    let key = |u: i64, v: i64| if u < v { (u, v) } else { (v, u) };
    // node -> (neighbour, signature) over the signed edges
    let mut nadj: HashMap<i64, Vec<(i64, u32)>> = HashMap::new();
    for (&(u, v), &s) in edge_sig.iter() {
        nadj.entry(u).or_default().push((v, s));
        nadj.entry(v).or_default().push((u, s));
    }
    // an edge of signature `s` from `from` ends at `v`: does `s` go on?
    let goes_on = |v: i64, from: i64, s: u32| {
        nadj.get(&v)
            .is_some_and(|es| es.iter().any(|&(n, t)| n != from && t == s))
    };
    let mut cuts: HashSet<i64> = HashSet::new();
    let mut steps: Vec<Option<(i64, i64)>> = Vec::new();
    for (keys, fwd) in rows {
        steps.clear();
        for (li, k) in keys.iter().enumerate() {
            steps.push(None);
            if let Some((seqs, walk)) = geom(k) {
                walk_edges(seqs, walk, fwd[li], |u, v| steps.push(Some((u, v))));
            }
        }
        steps.push(None);
        for w in steps.windows(2) {
            let sig =
                |st: Option<(i64, i64)>| st.and_then(|(u, v)| edge_sig.get(&key(u, v)).copied());
            let (a, b) = (w[0], w[1]);
            let same = match (a, b) {
                (Some((u0, v0)), Some((u1, v1))) => {
                    v0 == u1 && u0 != v1 && sig(a).is_some() && sig(a) == sig(b)
                }
                _ => false,
            };
            if same {
                continue;
            }
            // leaving a's signature at a's end
            if let (Some((u0, v0)), Some(s)) = (a, sig(a)) {
                if goes_on(v0, u0, s) {
                    cuts.insert(v0);
                }
            }
            // joining b's signature at b's start
            if let (Some((u1, v1)), Some(s)) = (b, sig(b)) {
                if goes_on(u1, v1, s) {
                    cuts.insert(u1);
                }
            }
        }
    }
    cuts
}

/// Visit a leg's track edges in travel order: along the walk when the
/// train runs key.0 -> key.1 (`fwd`), else the walk reversed.
pub fn walk_edges(seqs: &[Vec<i64>], walk: &LegWalk, fwd: bool, mut f: impl FnMut(i64, i64)) {
    let mut visit = |i: usize, flip: bool| {
        if flip {
            for w in seqs[i].windows(2).rev() {
                f(w[1], w[0]);
            }
        } else {
            for w in seqs[i].windows(2) {
                f(w[0], w[1]);
            }
        }
    };
    if fwd {
        for &(i, flip) in walk.steps.iter() {
            visit(i, flip);
        }
    } else {
        for &(i, flip) in walk.steps.iter().rev() {
            visit(i, !flip);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Nodes on the equator, 0.1 deg of lon (about 9.6 km) apart.
    fn line_coords() -> HashMap<i64, [f64; 2]> {
        (1..=4).map(|i| (i, [0.1 * (i - 1) as f64, 0.0])).collect()
    }

    #[test]
    fn orient_leg_keeps_stored_order_when_it_matches_the_stations() {
        let c = line_coords();
        let (w, gap) = orient_leg(&[vec![1, 2], vec![3, 4]], &c, c[&1], c[&4]);
        assert_eq!(w.steps, vec![(0, false), (1, false)]);
        assert!(gap < 1e-9, "stations sit on the path ends: {gap}");
    }

    #[test]
    fn orient_leg_flips_and_reorders_segments() {
        let c = line_coords();
        // segments stored backwards and out of order
        let (w, _) = orient_leg(&[vec![4, 3], vec![2, 1]], &c, c[&1], c[&4]);
        assert_eq!(w.steps, vec![(1, true), (0, true)]);
        let (w, _) = orient_leg(&[vec![3, 4], vec![1, 2]], &c, c[&1], c[&4]);
        assert_eq!(w.steps, vec![(1, false), (0, false)]);
    }

    #[test]
    fn orient_leg_is_symmetric_in_the_stations() {
        let c = line_coords();
        let seqs = [vec![1, 2], vec![3, 4]];
        let (w, _) = orient_leg(&seqs, &c, c[&4], c[&1]);
        assert_eq!(w.steps, vec![(1, true), (0, true)]);
    }

    #[test]
    fn orient_leg_skips_segments_without_coordinates() {
        let c = line_coords();
        let (w, _) = orient_leg(&[vec![1, 2], vec![98, 99], vec![3, 4]], &c, c[&1], c[&4]);
        assert_eq!(w.steps, vec![(0, false), (2, false)]);
    }

    #[test]
    fn orient_leg_reports_the_gap_between_segments() {
        let c = line_coords();
        let (w, _) = orient_leg(&[vec![1, 2], vec![3, 4]], &c, c[&1], c[&4]);
        // 2 -> 3 is one 0.1 deg lon hop at 96 km/deg
        assert!((w.max_gap - 9.6).abs() < 1e-6, "{}", w.max_gap);
    }

    #[test]
    fn throats_intern_dedupes_either_direction() {
        let c = line_coords();
        let mut t = Throats::default();
        assert_eq!(t.intern(&[1, 2, 3], &c, THROAT_MIN_KM), Some((0, false)));
        // the same chain walked the other way is the same throat, flipped
        assert_eq!(t.intern(&[3, 2, 1], &c, THROAT_MIN_KM), Some((0, true)));
        assert_eq!(t.intern(&[2, 3, 4], &c, THROAT_MIN_KM), Some((1, false)));
        assert_eq!(t.intern(&[1, 2, 3], &c, THROAT_MIN_KM), Some((0, false)));
        assert_eq!(t.chains, vec![vec![1, 2, 3], vec![2, 3, 4]]);
    }

    #[test]
    fn throats_intern_drops_slivers() {
        let mut c = line_coords();
        c.insert(10, [0.0, 0.0]);
        c.insert(11, [0.0001, 0.0]); // about 9.6 m
        let mut t = Throats::default();
        assert_eq!(t.intern(&[10, 11], &c, THROAT_MIN_KM), None);
        assert!(t.chains.is_empty());
    }

    #[test]
    fn throats_flush_appends_signed_ids_and_clears_the_run() {
        let c = line_coords();
        let mut t = Throats::default();
        let mut secs = Vec::new();
        let mut run = vec![3, 2, 1];
        t.flush(&mut run, &mut secs, &c, 100, None, &mut Vec::new());
        assert!(run.is_empty());
        assert_eq!(secs, vec![!100i64]); // throat 0, walked against its stored order
        let mut run = vec![1];
        t.flush(&mut run, &mut secs, &c, 100, None, &mut Vec::new());
        assert_eq!(secs.len(), 1, "a single node is not a run");
    }

    #[test]
    fn row_path_splits_trimmed_runs_by_the_section_they_lie_on() {
        // one leg 1-2-3-4: edge 1-2 is section 0, edges 2-3 and 3-4 are
        // trimmed, 3-4 lying on section 1 (which the train covers only partly)
        let c = line_coords();
        let seqs = vec![vec![1, 2, 3, 4]];
        let walk = LegWalk {
            steps: vec![(0, false)],
            max_gap: 0.0,
        };
        let key = ("a".to_string(), "b".to_string(), String::new());
        let geom = |_: &(String, String, String)| Some((&seqs, &walk));
        let sec_of = |u: i64, v: i64| match (u, v) {
            (1, 2) => Some((0, false)),
            _ => None,
        };
        let run_key = |u: i64, v: i64, _: &[f64; 2]| match (u, v) {
            (3, 4) => Some(Some(1)),
            _ => Some(None),
        };
        let mut t = Throats::default();
        let p = row_path(
            std::slice::from_ref(&key),
            &[true],
            &[0],
            &geom,
            &sec_of,
            &[1, 1],
            &run_key,
            &c,
            &mut t,
            10,
            &mut [0; 2],
        );
        assert_eq!(p.secs, vec![0, 10, 11]);
        assert_eq!(t.chains, vec![vec![2, 3], vec![3, 4]]);
        assert_eq!(p.on_sec, vec![(1, 1)]);
        assert_eq!(p.full_cnt, vec![0, 3]);
    }

    #[test]
    fn row_path_draws_a_partial_rerun_of_a_section_as_a_piece() {
        // leg a: 1-2-3-4 runs all of section 0; leg b reverses at 4 and runs
        // back over part of it (4-3), then off onto section 1 (3-5)
        let mut c = line_coords();
        c.insert(5, [0.2, 0.1]);
        let (sa, sb) = (vec![vec![1, 2, 3, 4]], vec![vec![4, 3, 5]]);
        let walk = |n: usize| LegWalk {
            steps: (0..n).map(|i| (i, false)).collect(),
            max_gap: 0.0,
        };
        let (wa, wb) = (walk(1), walk(1));
        let ka = ("a".to_string(), "b".to_string(), String::new());
        let kb = ("b".to_string(), "c".to_string(), String::new());
        let geom = |k: &(String, String, String)| {
            if k.0 == "a" {
                Some((&sa, &wa))
            } else {
                Some((&sb, &wb))
            }
        };
        let sec_of = |u: i64, v: i64| match (u.min(v), u.max(v)) {
            (1, 2) | (2, 3) | (3, 4) => Some((0, u > v)),
            (3, 5) => Some((1, u > v)),
            _ => None,
        };
        let mut t = Throats::default();
        let p = row_path(
            &[ka, kb],
            &[true, true],
            &[0, 1],
            &geom,
            &sec_of,
            &[3, 1],
            &|_, _, _| None,
            &c,
            &mut t,
            10,
            &mut [0; 2],
        );
        // section 0 once, the piece 4-3 on it (reversed: stored 3-4), section 1
        assert_eq!(p.secs, vec![0, !10, 1]);
        assert_eq!(t.chains, vec![vec![3, 4]]);
        assert_eq!(p.on_sec, vec![(0, 0)]);
        assert_eq!(p.flow_cnt, vec![0, 1, 2]);
        assert_eq!(p.full_cnt, vec![0, 1, 3]);
    }
}
