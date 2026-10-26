use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::PathBuf;

use analyze_rs::chains;
use analyze_rs::cn::*;
use analyze_rs::flows;
use analyze_rs::geo::*;
use analyze_rs::inputs;
use analyze_rs::legs::*;
use analyze_rs::model::*;
use analyze_rs::names::*;
use analyze_rs::osm;
use analyze_rs::polyline::*;
use analyze_rs::provenance;
use analyze_rs::timetable::*;
use analyze_rs::trainpath;

/// One train in data/raw/stops*.jsonl (the 12306 stop-list dump).
#[derive(Deserialize)]
struct RawTrain {
    train_no: String,
    stops: Vec<RawStop>,
}
#[derive(Deserialize)]
struct RawStop {
    station_name: String,
    arrive_time: String,
    start_time: String,
}
/// One schedule row: [station idx, arrive mins, depart mins (-1 = none),
/// day offset of the call from the train's origin day, leg km from the
/// previous stop (-1 = unknown)].
type ScheduleRow = (i64, i64, i64, i64, f64);
#[derive(Default, Clone)]
struct DestStats {
    total: u64,
    fast: u64,
    terminating: u64,
    times: Vec<i64>,
    rail: Vec<f64>,
    calls: Vec<CallRaw>,
    first: usize,
}

fn is_zero(v: &u8) -> bool {
    *v == 0
}

fn pack_flow_row(sec_idx: usize, n: usize, cls_counts: &[u32; 8]) -> Vec<usize> {
    let mut row = Vec::with_capacity(10);
    row.push(sec_idx);
    row.push(n);
    let mut last_nz = 0usize;
    for (i, &c) in cls_counts.iter().enumerate() {
        if c > 0 {
            last_nz = i + 1;
        }
    }
    for &c in &cls_counts[..last_nz] {
        row.push(c as usize);
    }
    row
}

#[derive(serde::Serialize)]
struct AtlasSection {
    a: i64,
    b: i64,
    g: String,
    #[serde(skip_serializing_if = "is_zero")]
    h: u8,
}
#[derive(serde::Serialize)]
struct AtlasChord {
    a: i64,
    b: i64,
    n: u64,
    g: String,
}
/// One call row in an origin's calls list: (dep row idx, arr, dep, day off, terminates, sec_cnt).
type CallList = Vec<(usize, String, String, i64, u8, usize)>;
/// One call row in a destination's inbound calls list:
/// (arr row idx, board time, arrival time, day off, started-here, board station idx, sec_cnt).
type InCallList = Vec<(usize, String, String, i64, u8, i64, usize)>;
/// Join key for a train's departure row: (train index, origin station, depart time).
type DepKey = (usize, String, String);
/// Join key for a train's arrival row: (train index, origin station, depart time, dataset index).
type ArrKey = (usize, String, String, u8);
#[derive(serde::Serialize)]
struct AtlasDep {
    t: usize,
    fs: i64,
    dep: String,
    ts: i64,
    tc: i64,
    arr: String,
    dur: i64,
    stops: u64,
    set: u8,
    km: i64,
}

#[derive(serde::Serialize)]
struct AtlasArr {
    t: usize,
    fs: i64,
    fc: i64,
    dep: String,
    ts: i64,
    arr: String,
    dur: i64,
    stops: u64,
    set: u8,
    km: i64,
}
#[derive(serde::Serialize)]
struct AtlasOrigin {
    zh: String,
    en: String,
    pt: [f64; 2],
    outbound: u64,
    fully_tracked: u64,
    dests: Vec<[i64; 8]>,
    calls: Vec<CallList>,
    flows: Vec<Vec<usize>>,
    chords: Vec<AtlasChord>,
    deps: Vec<AtlasDep>,
    pub dep_secs: Vec<Vec<i64>>,
    /// Per dep: [stop, s0, s1] for each leg without usable geometry
    /// (unresolved, or a gap > CHORD_GAP_KM): the leg departs the train's
    /// stop index `stop`; its entries (sections and throats) are
    /// dep_secs[s0..s1].
    dep_chord_legs: Vec<Vec<[usize; 3]>>,
    /// Per dep: path position of every stop after boarding (station level).
    dep_stop_pos: Vec<Vec<usize>>,
    inbound: u64,
    srcs: Vec<[i64; 8]>,
    in_calls: Vec<InCallList>,
    in_flows: Vec<Vec<usize>>,
    arrs: Vec<AtlasArr>,
    pub arr_secs: Vec<Vec<i64>>,
    /// Per arr: as dep_chord_legs, positions into arr_secs.
    arr_chord_legs: Vec<Vec<[usize; 3]>>,
}
#[derive(serde::Serialize)]
struct AtlasOut {
    about: String,
    /// Provenance (code revision, input hashes); atlaspack copies it to `shared.build`.
    build: serde_json::Value,
    origins: Vec<AtlasOrigin>,
    sections: Vec<AtlasSection>,
    in_sections: Vec<AtlasSection>,
    /// O1 station-throat pieces (polylines): path entries `base + j` (base =
    /// sections.len() in dep_secs, in_sections.len() in arr_secs).
    throats: Vec<String>,
    city_table: Vec<AtlasCity>,
    station_table: Vec<AtlasStation>,
    train_table: Vec<AtlasTrainRef>,
    network: Vec<String>,
    stats: std::collections::BTreeMap<String, i64>,
    /// Indexed by train_table index t: the train's full stop list.
    schedules: Vec<Vec<ScheduleRow>>,
    /// P3.1 national per-section table over `sections` (this file's
    /// numbering; atlaspack renumbers it with the sections). Last, so the
    /// fields before it serialize exactly as before it existed.
    national: flows::National,
    /// P2.2 national trains (A): every national train's whole run, after
    /// `national` for the same reason.
    national_trains: NationalTrains,
    /// Per-train national facts for filtering (section numbering as `national`).
    national_index: flows::NationalIndex,
    /// Train-export builds only: the export's dates, which each train_table
    /// row's `days` indexes.
    #[serde(skip_serializing_if = "Option::is_none")]
    calendar: Option<Vec<String>>,
}

/// Every national train's whole path (see atlaspack's header for the
/// packed form), indexed by train_table t like `schedules`; a train outside
/// the national set has an empty path.
#[derive(serde::Serialize, Default)]
struct NationalTrains {
    /// Whole path per train, out-tables encoding over `sections` (this
    /// file's numbering), then `throats`, then `extra`.
    paths: Vec<Vec<i64>>,
    /// Per train: entries before each stop after its first.
    stop_pos: Vec<Vec<usize>>,
    /// `[t, legs]` for trains with chord legs (`[stop, s0, s1]`).
    chords: Vec<(usize, Vec<[usize; 3]>)>,
    /// Geometry-only pieces the shared throats lack: path entries
    /// `sections.len() + throats.len() + j` (polylines like `throats`).
    extra: Vec<String>,
    /// `(path id, section)` for the geometry-only entries that lie on a flow
    /// section a head covers only part of (a train counts on that section).
    on_sec: Vec<(usize, usize)>,
}

/// One train's call at one destination city (first stop in that city).
#[derive(Clone)]
struct CallRaw {
    /// The train's index into `trains`.
    ti: usize,
    from_station: String,
    depart: String,
    arr: String,
    dep: String,
    off: i64,
    term: bool,
    leg_cnt: usize,
}

/// One train's boarding at one source city, for the inbound view of the
/// city it later arrives at (first stop in the source city).
#[derive(Clone)]
struct InCallRaw {
    /// The train's index into `trains`.
    ti: usize,
    from_station: String,
    depart: String,
    arr: String,
    off: i64,
    started: bool,
    okey_station: String,
    okey_depart: String,
    set: u8,
    leg_start: usize,
}

/// Per (destination city, source city) inbound stats; mirrors DestStats.
#[derive(Default)]
struct InSrcStats {
    total: u64,
    fast: u64,
    originating: u64,
    times: Vec<i64>,
    rail: Vec<f64>,
    calls: Vec<InCallRaw>,
    first: usize,
}

/// Internal gap (km) above which a resolved leg counts as a chord leg:
/// its geometry has a hole the client must bridge, not animate along.
const CHORD_GAP_KM: f64 = 3.0;

/// A resolved leg's segments as one walk from key.0 to key.1: the
/// segment order and, per segment, whether it is walked against its
/// stored vertex order. Stored geometry is not reliably key-ordered
/// (per-train router paths run in their own train's direction; corridor
/// chains concatenate pair paths in each pair's own order), so the walk
/// is derived from coordinates.
struct LegWalk {
    steps: Vec<(usize, bool)>,
    /// Largest hole in the walk (km): between consecutive segments, or
    /// between consecutive nodes with coordinates inside one segment
    /// (nodes missing from the extract carry no sections).
    max_gap: f64,
}

/// Largest distance (km) spanned by a run of nodes missing coordinates;
/// infinite when a run of 2+ such nodes is at either end of the segment
/// (its length is unknown, and the path stops short of the station).
fn seg_hole(s: &[i64], coords: &HashMap<i64, [f64; 2]>) -> f64 {
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
fn orient_leg(
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
const ORIENT_TRUST_KM: f64 = 10.0;

/// Station-throat pieces (O1): track edges that `near_station` trims from
/// the flow sections, kept as geometry only so per-train paths run through
/// stations. One piece = a maximal run of consecutive trimmed edges inside
/// one leg's walk, interned globally by node chain (either direction).
#[derive(Default, Clone)]
struct Throats {
    ids: HashMap<Vec<i64>, usize>,
    chains: Vec<Vec<i64>>,
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
type RunKey<'a> = dyn Fn(i64, i64, &[f64; 2]) -> Option<Option<usize>> + 'a;

/// A leg's resolved geometry and walk, if it has them (see `row_path`).
type LegGeom<'g> =
    dyn Fn(&(String, String, String)) -> Option<(&'g Vec<Vec<i64>>, &'g LegWalk)> + 'g;

/// One train row's path (O1): `secs` holds flow sections and throats in
/// travel order; `full_cnt[li]` = entries before leg li, `flow_cnt[li]` =
/// flow sections before leg li; chord legs in `secs` positions.
struct RowPath {
    secs: Vec<i64>,
    full_cnt: Vec<usize>,
    flow_cnt: Vec<usize>,
    chord_legs: Vec<[usize; 3]>,
    /// `(throat index, section)` for the throat entries that lie on a flow
    /// section (`run_key` gave `Some(Some(s))`).
    on_sec: Vec<(usize, usize)>,
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
fn row_path<'g>(
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
fn chain_cuts<'r, 'g>(
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
fn walk_edges(seqs: &[Vec<i64>], walk: &LegWalk, fwd: bool, mut f: impl FnMut(i64, i64)) {
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

fn main() {
    let inp = inputs::load();
    let out_path = env::var("ATLAS_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| inp.paths.files.join("china-flow-atlas-data.json"));
    let data_dir = inp.paths.data_dir.clone();
    let override_map = &inp.override_map;
    let trains = &inp.trains;
    let d1_len = inp.d1_len;
    let path_map = &inp.path_map;
    let coords = &inp.coords;
    let city_en = &inp.city_en;
    let en = |c: &str| -> String { inp.en(c) };
    let station_pt = |name: &str| -> Option<[f64; 2]> { inp.stations.point(name) };

    // ---- HSR edges & nodes from the OSM ways (highspeed=yes or maxspeed>=200) ----
    let osm::WayClasses {
        hsr_edges,
        conv_edges,
        hsr_nodes,
    } = osm::scan_ways(&inp.osm_data);
    let chain_hsr = |chain: &[i64]| -> u8 {
        let total = chain.len().saturating_sub(1);
        let hsr_n = chain
            .windows(2)
            .filter(|w| {
                let e = if w[0] < w[1] {
                    (w[0], w[1])
                } else {
                    (w[1], w[0])
                };
                hsr_edges.contains(&e)
                    || (!conv_edges.contains(&e)
                        && hsr_nodes.contains(&w[0])
                        && hsr_nodes.contains(&w[1]))
            })
            .count();
        u8::from(total > 0 && hsr_n * 2 >= total)
    };

    let seg_coords = |ids: &[i64]| -> Vec<[f64; 2]> {
        ids.iter()
            .filter_map(|id| coords.get(id).copied())
            .collect()
    };

    // ---- precompute per-train names/cities ----
    let train_names: Vec<Vec<String>> = trains
        .iter()
        .map(|t| t.stops.iter().map(|s| clean(&s.name)).collect())
        .collect();
    let train_cities: Vec<Vec<String>> = train_names
        .iter()
        .map(|ns| ns.iter().map(|n| city_of(n)).collect())
        .collect();

    // ---- rank cities by outbound trains ----
    let mut outbound_count: HashMap<String, u64> = HashMap::new();
    for cities in train_cities.iter() {
        let mut seen: HashSet<&str> = HashSet::new();
        for (i, c) in cities.iter().enumerate() {
            if i + 1 < cities.len() && seen.insert(c.as_str()) {
                *outbound_count.entry(c.clone()).or_insert(0) += 1;
            }
        }
    }
    let mut ranked: Vec<(String, u64)> = outbound_count.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let top_n = 100usize;
    let mut selected: Vec<String> = ranked.iter().take(top_n).map(|(c, _)| c.clone()).collect();
    for (zh, en) in FEATURED_ORIGINS {
        if !selected.iter().any(|c| c == zh) {
            if let Some((_, n)) = ranked.iter().find(|(c, _)| c == zh) {
                println!(
                    "Adding {en} ({zh}) as a special featured origin city ({n} outbound trains)"
                );
                selected.push(zh.to_string());
            }
        }
    }
    for th in [300u64, 200, 150, 100, 75, 50, 25, 10] {
        println!(
            "TIER outbound >= {}: {} cities",
            th,
            ranked.iter().filter(|(_, n)| *n >= th).count()
        );
    }
    println!("total cities with >= 1 outbound train: {}", ranked.len());
    println!("TOP {} CITIES BY OUTBOUND TRAINS:", top_n);
    for (i, (c, n)) in ranked.iter().take(top_n).enumerate() {
        println!("  {:>2}. {} {} - {}", i + 1, c, en(c), n);
    }

    // ---- global station stop counts per city -> principal points ----
    let mut city_stations: HashMap<String, HashMap<String, (u64, usize)>> = HashMap::new();
    let mut cs_counter = 0usize;
    for (ti, _) in trains.iter().enumerate() {
        for (i, nm) in train_names[ti].iter().enumerate() {
            let e = city_stations
                .entry(train_cities[ti][i].clone())
                .or_default()
                .entry(nm.clone())
                .or_insert_with(|| {
                    let v = cs_counter;
                    cs_counter += 1;
                    (0, v)
                });
            e.0 += 1;
        }
    }
    let mut city_pt: HashMap<String, [f64; 2]> = HashMap::new(); // [lat, lon]
    for (cty, sts) in city_stations.iter() {
        let mut ordered: Vec<(&String, &(u64, usize))> = sts.iter().collect();
        ordered.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.1 .1.cmp(&b.1 .1)));
        for (nm, _) in ordered {
            if let Some(p) = station_pt(nm) {
                city_pt.insert(cty.clone(), p);
                break;
            }
        }
        if let Some(p) = city_point_override(cty) {
            city_pt.insert(cty.clone(), p);
        }
    }

    // ---- corridor graph (shared by all cities) ----
    let pair_len: HashMap<(String, String), f64> = path_map
        .iter()
        .filter(|(_, (_, segs))| segs.iter().any(|s| s.len() >= 2))
        .map(|(k, (_, segs))| {
            let l: f64 = segs
                .iter()
                .map(|s| {
                    let c = seg_coords(s);
                    c.windows(2).map(|w| hav_km_ll(w[0], w[1])).sum::<f64>()
                })
                .sum();
            (k.clone(), l)
        })
        .collect();
    let mut adj_pure: CorridorAdj = HashMap::new();
    let mut adj: CorridorAdj = HashMap::new();
    let mut pair_lens: Vec<(&(String, String), &f64)> = pair_len.iter().collect();
    pair_lens.sort_by(|a, b| a.0.cmp(b.0));
    for (k, l) in pair_lens {
        adj_pure
            .entry(k.0.clone())
            .or_default()
            .push((k.1.clone(), Some(k.clone()), *l));
        adj_pure
            .entry(k.1.clone())
            .or_default()
            .push((k.0.clone(), Some(k.clone()), *l));
        adj.entry(k.0.clone())
            .or_default()
            .push((k.1.clone(), Some(k.clone()), *l));
        adj.entry(k.1.clone())
            .or_default()
            .push((k.0.clone(), Some(k.clone()), *l));
    }
    {
        let mut all_stations: HashSet<String> = HashSet::new();
        for (a, b) in path_map.keys() {
            all_stations.insert(a.clone());
            all_stations.insert(b.clone());
        }
        let mut by_city: HashMap<String, Vec<String>> = HashMap::new();
        for s in all_stations.iter() {
            by_city.entry(city_of(s)).or_default().push(s.clone());
        }
        let mut by_city: Vec<(String, Vec<String>)> = by_city.into_iter().collect();
        by_city.sort();
        for (_, sts) in by_city.iter_mut() {
            sts.sort();
            if sts.len() < 2 || sts.len() > 12 {
                continue;
            }
            for i in 0..sts.len() {
                for j in (i + 1)..sts.len() {
                    if let (Some(p), Some(q)) = (station_pt(&sts[i]), station_pt(&sts[j])) {
                        let w = hav_km_ll([p[1], p[0]], [q[1], q[0]]) * 2.0 + 2.0;
                        if w > 60.0 {
                            continue;
                        }
                        adj.entry(sts[i].clone())
                            .or_default()
                            .push((sts[j].clone(), None, w));
                        adj.entry(sts[j].clone())
                            .or_default()
                            .push((sts[i].clone(), None, w));
                    }
                }
            }
        }
    }
    let mut leg_cache: HashMap<(String, String), Option<Vec<Vec<i64>>>> = HashMap::new();
    let mut variant_cache: VariantCache = HashMap::new();
    let mut variant_stats: (u64, u64) = (0, 0);

    // ---- interning tables (filled during assembly) ----
    let mut city_table: Vec<AtlasCity> = Vec::new();
    let mut city_idx: HashMap<String, i64> = HashMap::new();
    let mut station_table: Vec<AtlasStation> = Vec::new();
    let mut station_idx: HashMap<String, i64> = HashMap::new();
    let mut train_table: Vec<AtlasTrainRef> = Vec::new();
    // train_table t -> index into `trains` (train_ti[t]), and back
    let mut train_ti: Vec<usize> = Vec::new();
    let mut train_idx: HashMap<usize, usize> = HashMap::new();

    // ---- per-city work ----
    struct DepRaw {
        code: String,
        from_station: String,
        depart: String,
        to_station: String,
        to_city: String,
        arrive: String,
        dur: Option<i64>,
        stops_after: u64,
        set: u8,
        km: f64,
        leg_keys: Vec<(String, String, String)>,
        /// Per leg: travelled key.0 -> key.1 (the key is canonical (min, max)).
        leg_fwd: Vec<bool>,
        /// Per leg: index of its departing stop in the train's stop list.
        leg_stop: Vec<usize>,
        /// Index of the boarding stop in the train's stop list.
        board: usize,
        /// The train's index into `trains`.
        ti: usize,
    }
    /// (class bucket, train index into `trains`, leg keys)
    type TrainLegs = (usize, usize, Vec<(String, String, String)>);
    struct CityWork {
        zh: String,
        outbound: u64,
        fully_tracked: u64,
        legs: Vec<((String, String, String), u64)>,
        dests: Vec<(String, DestStats)>,
        deps: Vec<DepRaw>,
        home_pt: [f64; 2],
        train_leg_keys: Vec<TrainLegs>,
    }
    let mut works: Vec<CityWork> = Vec::new();
    // dep rows with stations that have no city call: [home city, terminus
    // city, intermediate city, any]; and the distinct trains behind "any"
    let mut skipped_rows = [0u64; 4];
    let mut skipped_trains: HashSet<String> = HashSet::new();
    let mut skipped_example: [Option<String>; 3] = [None, None, None];
    let mut throat_stations: HashSet<String> = HashSet::new();
    for home_city in selected.iter() {
        let mut out_stats: HashMap<String, DestStats> = HashMap::new();
        let mut counter = 0usize;
        let mut leg_count: HashMap<(String, String, String), u64> = HashMap::new();
        let mut deps: Vec<DepRaw> = Vec::new();
        let mut outbound = 0u64;
        let mut train_legs: Vec<TrainLegs> = Vec::new();
        for (ti, t) in trains.iter().enumerate() {
            let names = &train_names[ti];
            let cities = &train_cities[ti];
            let Some(cd_idx) = flows::departs_from(cities, home_city) else {
                continue;
            };
            outbound += 1;
            let is_fast = ["G", "D", "C", "S"].contains(&t.train_class.as_str());
            let final_city = cities.last().unwrap().clone();
            let mut legs: Vec<(String, String, String)> = Vec::new();
            let (mut leg_fwd, mut leg_stop) = (Vec::new(), Vec::new());
            let mut leg_prefix: Vec<usize> = vec![0; names.len()];
            for k in cd_idx..(names.len() - 1) {
                let (a, b) = (names[k].clone(), names[k + 1].clone());
                if a != b {
                    let key = leg_key3(override_map, t, &a, &b);
                    *leg_count.entry(key.clone()).or_insert(0) += 1;
                    legs.push(key);
                    leg_fwd.push(a < b);
                    leg_stop.push(k);
                }
                leg_prefix[k + 1] = legs.len();
            }
            deps.push(DepRaw {
                code: t.code.clone(),
                from_station: names[cd_idx].clone(),
                depart: t.stops[cd_idx].depart.clone(),
                to_station: names.last().unwrap().clone(),
                to_city: final_city.clone(),
                arrive: t.stops.last().unwrap().arrive.clone(),
                dur: travel_time(&t.stops, cd_idx, t.stops.len() - 1),
                stops_after: (t.stops.len() - 1 - cd_idx) as u64,
                set: if ti < d1_len { 0 } else { 1 },
                km: -1.0,
                leg_keys: legs.clone(),
                leg_fwd,
                leg_stop,
                board: cd_idx,
                ti,
            });
            let mut seen_dest: HashSet<String> = HashSet::new();
            let mut skipped = [false; 3];
            let mut cum_km = 0f64;
            let mut cum_ok = true;
            let mut last_k = cd_idx;
            // j walks cities/names/stops in lockstep; the index is the join.
            #[allow(clippy::needless_range_loop)]
            for j in (cd_idx + 1)..cities.len() {
                // extend cumulative track distance from stop last_k to stop j
                while last_k < j {
                    let (a, b) = (names[last_k].clone(), names[last_k + 1].clone());
                    if a != b {
                        match leg_km(override_map, &pair_len, t, &a, &b) {
                            Some(l) => cum_km += l,
                            None => cum_ok = false,
                        }
                    }
                    last_k += 1;
                }
                if &cities[j] == home_city || !seen_dest.insert(cities[j].clone()) {
                    // a station with no city call of its own: in the home
                    // city, at the terminus city, or in an intermediate city
                    let class = if &cities[j] == home_city {
                        0
                    } else if j == cities.len() - 1 {
                        1
                    } else {
                        2
                    };
                    skipped[class] = true;
                    skipped_example[class].get_or_insert_with(|| {
                        format!("{} from {}: {}", t.code, home_city, names[j])
                    });
                    continue;
                }
                let dest = cities[j].clone();
                let e = out_stats.entry(dest.clone()).or_insert_with(|| {
                    let v = counter;
                    counter += 1;
                    DestStats {
                        first: v,
                        ..Default::default()
                    }
                });
                e.total += 1;
                if is_fast {
                    e.fast += 1;
                }
                if final_city == dest {
                    e.terminating += 1;
                }
                let tt = travel_time(&t.stops, cd_idx, j);
                if let Some(ttv) = tt {
                    if ttv > 0 && ttv < 6000 {
                        e.times.push(ttv);
                    }
                }
                if cum_ok && cum_km > 0.0 {
                    e.rail.push(cum_km);
                }
                let off = match (mins(&t.stops[cd_idx].depart), tt) {
                    (Some(dm), Some(ttv)) => (dm + ttv) / 1440,
                    _ => 0,
                };
                e.calls.push(CallRaw {
                    ti,
                    from_station: names[cd_idx].clone(),
                    depart: t.stops[cd_idx].depart.clone(),
                    arr: t.stops[j].arrive.clone(),
                    dep: t.stops[j].depart.clone(),
                    off,
                    term: final_city == dest,
                    leg_cnt: leg_prefix[j],
                });
            }
            if cum_ok && cum_km > 0.0 {
                if let Some(d0) = deps.last_mut() {
                    d0.km = cum_km;
                }
            }
            for (n, hit) in skipped_rows.iter_mut().zip(skipped) {
                *n += hit as u64;
            }
            if skipped.iter().any(|&x| x) {
                skipped_rows[3] += 1;
                skipped_trains.insert(t.code.clone());
            }
            train_legs.push((class_idx(&t.train_class), ti, legs));
        }
        let mut legs_vec: Vec<((String, String, String), u64)> = Vec::new();
        let mut resolved_flags: HashMap<(String, String, String), bool> = HashMap::new();
        for (k, n) in leg_count.iter() {
            let r = resolve_leg3(
                k,
                path_map,
                &adj_pure,
                &adj,
                &pair_len,
                &station_pt,
                &mut leg_cache,
                &mut variant_cache,
                &mut variant_stats,
            );
            resolved_flags.insert(k.clone(), r.is_some());
            legs_vec.push((k.clone(), *n));
            throat_stations.insert(k.0.clone());
            throat_stations.insert(k.1.clone());
        }
        let mut fully = 0u64;
        for (_, _, legs) in train_legs.iter() {
            if legs
                .iter()
                .all(|k| resolved_flags.get(k).copied().unwrap_or(false))
            {
                fully += 1;
            }
        }
        deps.sort_by(|x, y| x.depart.cmp(&y.depart).then(x.code.cmp(&y.code)));
        let mut dests: Vec<(String, DestStats)> = out_stats.into_iter().collect();
        dests.sort_by(|a, b| b.1.total.cmp(&a.1.total).then(a.1.first.cmp(&b.1.first)));
        let hp = city_pt.get(home_city).copied().unwrap_or([30.63, 104.13]);
        println!(
            "{}: outbound {} dests {} legs {} fully {}",
            home_city,
            outbound,
            dests.len(),
            legs_vec.len(),
            fully
        );
        works.push(CityWork {
            zh: home_city.clone(),
            outbound,
            fully_tracked: fully,
            legs: legs_vec,
            dests,
            deps,
            home_pt: [hp[1], hp[0]],
            train_leg_keys: train_legs,
        });
    }

    // ---- inbound works: for each selected city, every train arriving there.
    // Mirror of the outbound pass. cd_in = the train's first stop in the city
    // at index >= 1 (a real arrival). Sources = every distinct city boarded
    // before a later arrival in this city; per source, the arrival used is
    // the first home-city stop AFTER boarding, which makes the pair identity
    // srcs[X][P].total == dests[P][X].total exact (checked at assembly).
    struct InArrRaw {
        code: String,
        from_station: String,
        from_city: String,
        depart: String,
        arr_station: String,
        arrive: String,
        dur: Option<i64>,
        stops_before: u64,
        set: u8,
        km: f64,
        leg_keys: Vec<(String, String, String)>,
        /// Per leg: travelled key.0 -> key.1 (the key is canonical (min, max)).
        leg_fwd: Vec<bool>,
        /// Per leg: index of its departing stop in the train's stop list.
        leg_stop: Vec<usize>,
        /// The train's index into `trains`.
        ti: usize,
    }
    struct InCityWork {
        zh: String,
        arrivals: u64,
        sources: Vec<(String, InSrcStats)>,
        arrs: Vec<InArrRaw>,
        home_pt: [f64; 2],
        train_leg_keys: Vec<TrainLegs>,
    }
    let mut in_works: Vec<InCityWork> = Vec::new();
    for home_city in selected.iter() {
        let mut src_stats: HashMap<String, InSrcStats> = HashMap::new();
        let mut counter = 0usize;
        let mut arrs: Vec<InArrRaw> = Vec::new();
        let mut train_leg_keys_in: Vec<TrainLegs> = Vec::new();
        for (ti, t) in trains.iter().enumerate() {
            let names = &train_names[ti];
            let cities = &train_cities[ti];
            let Some(cd_in) = flows::arrives_at(cities, home_city) else {
                continue;
            };
            let is_fast = ["G", "D", "C", "S"].contains(&t.train_class.as_str());
            // prefix track distances from stop 0: cumulative km + bad-leg count
            let mut pref_km: Vec<f64> = vec![0.0; cities.len()];
            let mut pref_bad: Vec<i64> = vec![0; cities.len()];
            for k in 1..cities.len() {
                let (a, b) = (names[k - 1].clone(), names[k].clone());
                pref_bad[k] = pref_bad[k - 1];
                pref_km[k] = pref_km[k - 1];
                if a != b {
                    match leg_km(override_map, &pair_len, t, &a, &b) {
                        Some(l) => pref_km[k] += l,
                        None => pref_bad[k] += 1,
                    }
                }
            }
            let journey_km = if pref_bad[cd_in] == 0 && pref_km[cd_in] > 0.0 {
                pref_km[cd_in]
            } else {
                -1.0
            };
            let mut legs: Vec<(String, String, String)> = Vec::new();
            let (mut leg_fwd, mut leg_stop) = (Vec::new(), Vec::new());
            let mut leg_prefix: Vec<usize> = vec![0; cities.len()];
            for k in 0..cd_in {
                let (a, b) = (names[k].clone(), names[k + 1].clone());
                if a != b {
                    legs.push(leg_key3(override_map, t, &a, &b));
                    leg_fwd.push(a < b);
                    leg_stop.push(k);
                }
                leg_prefix[k + 1] = legs.len();
            }
            for p in leg_prefix.iter_mut().skip(cd_in + 1) {
                *p = legs.len();
            }
            arrs.push(InArrRaw {
                code: t.code.clone(),
                from_station: names[0].clone(),
                from_city: cities[0].clone(),
                depart: t.stops[0].depart.clone(),
                arr_station: names[cd_in].clone(),
                arrive: t.stops[cd_in].arrive.clone(),
                dur: travel_time(&t.stops, 0, cd_in),
                stops_before: cd_in as u64,
                set: if ti < d1_len { 0 } else { 1 },
                km: journey_km,
                leg_keys: legs.clone(),
                leg_fwd,
                leg_stop,
                ti,
            });
            // sources: distinct cities (first index each), home city excluded
            let mut seen_src: HashSet<String> = HashSet::new();
            let mut src_list: Vec<(String, usize)> = Vec::new();
            // k walks cities/names in lockstep; the index is the join.
            #[allow(clippy::needless_range_loop)]
            for k in 0..cities.len() {
                if &cities[k] == home_city {
                    continue;
                }
                if seen_src.insert(cities[k].clone()) {
                    src_list.push((cities[k].clone(), k));
                }
            }
            for (pcity, p_idx) in src_list.iter() {
                let p_idx = *p_idx;
                let arr_j = match (p_idx + 1..cities.len()).find(|&j| &cities[j] == home_city) {
                    Some(j) => j,
                    None => continue,
                };
                let e = src_stats.entry(pcity.clone()).or_insert_with(|| {
                    let v = counter;
                    counter += 1;
                    InSrcStats {
                        first: v,
                        ..Default::default()
                    }
                });
                e.total += 1;
                if is_fast {
                    e.fast += 1;
                }
                if p_idx == 0 {
                    e.originating += 1;
                }
                let tt = travel_time(&t.stops, p_idx, arr_j);
                if let Some(ttv) = tt {
                    if ttv > 0 && ttv < 6000 {
                        e.times.push(ttv);
                    }
                }
                if pref_bad[arr_j] - pref_bad[p_idx] == 0 {
                    let d = pref_km[arr_j] - pref_km[p_idx];
                    if d > 0.0 {
                        e.rail.push(d);
                    }
                }
                let off = match (mins(&t.stops[p_idx].depart), tt) {
                    (Some(dm), Some(ttv)) => (dm + ttv) / 1440,
                    _ => 0,
                };
                e.calls.push(InCallRaw {
                    ti,
                    from_station: names[p_idx].clone(),
                    depart: t.stops[p_idx].depart.clone(),
                    arr: t.stops[arr_j].arrive.clone(),
                    off,
                    started: p_idx == 0,
                    okey_station: names[0].clone(),
                    okey_depart: t.stops[0].depart.clone(),
                    set: if ti < d1_len { 0 } else { 1 },
                    leg_start: leg_prefix[p_idx.min(cd_in)],
                });
            }
            train_leg_keys_in.push((class_idx(&t.train_class), ti, legs));
        }
        arrs.sort_by(|x, y| x.arrive.cmp(&y.arrive).then(x.code.cmp(&y.code)));
        let mut sources: Vec<(String, InSrcStats)> = src_stats.into_iter().collect();
        sources.sort_by(|a, b| b.1.total.cmp(&a.1.total).then(a.1.first.cmp(&b.1.first)));
        let hp = city_pt.get(home_city).copied().unwrap_or([30.63, 104.13]);
        println!(
            "IN {}: arrivals {} sources {}",
            home_city,
            arrs.len(),
            sources.len()
        );
        in_works.push(InCityWork {
            zh: home_city.clone(),
            arrivals: arrs.len() as u64,
            sources,
            arrs,
            home_pt: [hp[1], hp[0]],
            train_leg_keys: train_leg_keys_in,
        });
    }
    // Inbound legs resolve exactly like outbound ones. Legs before the first
    // selected city on a train are never seen outbound, so resolve them here
    // (cached per key, so outbound legs are unaffected). Their stations trim
    // throats in the inbound pass only, which keeps outbound flows unchanged.
    let mut in_throat_stations = throat_stations.clone();
    for key in in_works
        .iter()
        .flat_map(|w| w.train_leg_keys.iter())
        .flat_map(|(_, _, legs)| legs.iter())
    {
        in_throat_stations.insert(key.0.clone());
        in_throat_stations.insert(key.1.clone());
        resolve_leg3(
            key,
            path_map,
            &adj_pure,
            &adj,
            &pair_len,
            &station_pt,
            &mut leg_cache,
            &mut variant_cache,
            &mut variant_stats,
        );
    }

    // ---- leg walks: every resolved leg oriented key.0 -> key.1 ----
    // One-time direction check: base pair paths must already run
    // key.0 -> key.1 (fail loudly otherwise); router, variant (via) and
    // corridor-chain geometry is oriented from coordinates and reported.
    let mut leg_walks: HashMap<(String, String, String), LegWalk> = HashMap::new();
    // kind -> [as stored, reversed, mixed, unchecked (station point missing/untrusted)]
    let mut orient_stats: std::collections::BTreeMap<&str, [u64; 4]> = Default::default();
    let mut bad_pairs: Vec<String> = Vec::new();
    let out_keys = works
        .iter()
        .flat_map(|w| w.deps.iter())
        .flat_map(|d| d.leg_keys.iter());
    let in_keys = in_works
        .iter()
        .flat_map(|w| w.arrs.iter())
        .flat_map(|a| a.leg_keys.iter());
    for key in out_keys.chain(in_keys) {
        if leg_walks.contains_key(key) {
            continue;
        }
        let Some(seqs) = leg_seqs(key, &leg_cache, &variant_cache) else {
            continue;
        };
        let kind = if leg_path(&key.2).is_some() {
            "router"
        } else if !key.2.is_empty() {
            "variant"
        } else if path_map
            .get(&(key.0.clone(), key.1.clone()))
            .is_some_and(|(_, segs)| segs.iter().any(|s| s.len() >= 2))
        {
            "pair"
        } else {
            "chain"
        };
        let st = orient_stats.entry(kind).or_default();
        let oriented = match (station_pt(&key.0), station_pt(&key.1)) {
            (Some(p0), Some(p1)) => Some(orient_leg(seqs, coords, [p0[1], p0[0]], [p1[1], p1[0]])),
            _ => None,
        };
        let stored = || {
            let ends: Vec<[f64; 2]> = seqs
                .iter()
                .flat_map(|s| {
                    let first = s.iter().find_map(|id| coords.get(id));
                    let last = s.iter().rev().find_map(|id| coords.get(id));
                    first.zip(last).map(|(a, b)| [*a, *b])
                })
                .flatten()
                .collect();
            let max_gap = ends
                .chunks(2)
                .collect::<Vec<_>>()
                .windows(2)
                .map(|w| hav_km_ll(w[0][1], w[1][0]))
                .chain(seqs.iter().map(|s| seg_hole(s, coords)))
                .fold(0.0, f64::max);
            LegWalk {
                steps: (0..seqs.len()).map(|i| (i, false)).collect(),
                max_gap,
            }
        };
        let walk = match oriented {
            Some((walk, end_gap)) if end_gap <= ORIENT_TRUST_KM => {
                let as_stored = walk.steps.windows(2).all(|w| w[0].0 < w[1].0)
                    && walk.steps.iter().all(|s| !s.1);
                let reversed = walk.steps.windows(2).all(|w| w[0].0 > w[1].0)
                    && walk.steps.iter().all(|s| s.1);
                st[if as_stored {
                    0
                } else if reversed {
                    1
                } else {
                    2
                }] += 1;
                if kind == "pair" && !as_stored {
                    bad_pairs.push(format!("{} -> {} {:?}", key.0, key.1, walk.steps));
                }
                walk
            }
            _ => {
                st[3] += 1;
                stored()
            }
        };
        leg_walks.insert(key.clone(), walk);
    }
    for (kind, st) in orient_stats.iter() {
        println!(
            "leg orientation {kind}: as stored {} reversed {} mixed {} unchecked {}",
            st[0], st[1], st[2], st[3]
        );
    }
    assert!(
        bad_pairs.is_empty(),
        "pair paths not stored key.0 -> key.1: {bad_pairs:?}"
    );
    println!("leg orientation: all checked pair paths run key.0 -> key.1");

    // ---- global atomic sections over the union of all selected cities ----
    let throat_grid = |names: &HashSet<String>| {
        let mut grid: HashMap<(i32, i32), Vec<[f64; 2]>> = HashMap::new();
        for nm in names.iter() {
            if let Some(p) = station_pt(nm) {
                let ll = [p[1], p[0]];
                grid.entry(((ll[0] * 50.0).floor() as i32, (ll[1] * 50.0).floor() as i32))
                    .or_default()
                    .push(ll);
            }
        }
        grid
    };
    let station_grid = throat_grid(&throat_stations);
    let in_station_grid = throat_grid(&in_throat_stations);
    let near_station = |station_grid: &HashMap<(i32, i32), Vec<[f64; 2]>>, pt: &[f64; 2]| -> bool {
        let gx = (pt[0] * 50.0).floor() as i32;
        let gy = (pt[1] * 50.0).floor() as i32;
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(cell) = station_grid.get(&(gx + dx, gy + dy)) {
                    for c in cell {
                        if hav_km_ll(*pt, *c) < 1.3 {
                            return true;
                        }
                    }
                }
            }
        }
        false
    };
    // atomic edge -> per-city DISTINCT train counts: each train counts at
    // most once per edge, no matter how many of its legs' paths overlap
    // there (adjacent-leg path overlap near stations otherwise inflates
    // short sections between close stations). The rule lives in
    // flows::train_edges, shared with the inbound and national counts.
    let seqs_of = |k: &(String, String, String)| leg_seqs(k, &leg_cache, &variant_cache);
    let mut edge_counts: HashMap<(i64, i64), HashMap<usize, u64>> = HashMap::new();
    let mut edge_class_counts: HashMap<(i64, i64), HashMap<usize, [u32; 8]>> = HashMap::new();
    let mut edge_trains = chains::EdgeTrains::new();
    for (ci, w) in works.iter().enumerate() {
        for (k, (cidx, _, legs)) in w.train_leg_keys.iter().enumerate() {
            let eset =
                flows::train_edges(legs, seqs_of, coords, |p| near_station(&station_grid, p));
            let mark = chains::train_mark(ci, k);
            for e in eset {
                let m = edge_trains.entry(e).or_insert(0);
                *m = m.wrapping_add(mark);
                *edge_counts.entry(e).or_default().entry(ci).or_insert(0) += 1;
                edge_class_counts
                    .entry(e)
                    .or_default()
                    .entry(ci)
                    .or_insert([0; 8])[*cidx] += 1;
            }
        }
    }
    println!("union atomic edges: {}", edge_counts.len());
    // intern count signatures: a global section has constant per-city counts
    let (sig_list, edge_sig) = chains::intern_sigs(&edge_counts, &edge_class_counts);
    println!("distinct signatures: {}", sig_list.len());
    let walk_geom = |key: &(String, String, String)| {
        leg_seqs(key, &leg_cache, &variant_cache).zip(leg_walks.get(key))
    };
    let cuts = chain_cuts(
        works
            .iter()
            .flat_map(|w| w.deps.iter())
            .map(|d| (&d.leg_keys[..], &d.leg_fwd[..])),
        &walk_geom,
        &edge_sig,
    );
    println!(
        "section chain cuts (rows leaving equal-signature track mid-way): {}",
        cuts.len()
    );
    let section_chains = chains::build_section_chains(&edge_sig, &edge_trains, &cuts);
    // section endpoint station names (nearest real station point)
    let mut station_pts_all: HashMap<String, [f64; 2]> = HashMap::new();
    for (a, b) in path_map.keys() {
        for s in [a, b] {
            if let Some(p) = station_pt(s) {
                station_pts_all.insert(s.clone(), [p[1], p[0]]);
            }
        }
    }
    let nearest_station = |pt: [f64; 2]| -> String {
        let mut best: Option<(&String, f64)> = None;
        for (nm, sp) in station_pts_all.iter() {
            let d = hav_km_ll(pt, *sp);
            if d < 5.0 && best.is_none_or(|(bn, bd)| d < bd || (d == bd && nm < bn)) {
                best = Some((nm, d));
            }
        }
        best.map(|(nm, _)| nm.clone()).unwrap_or_default()
    };
    // directed edge -> (section, travelled against the section's stored
    // point order); built here, where sec_idx is known (chains with too
    // few points are skipped, so chain and section indices drift).
    let mut edge_dir_to_sec: HashMap<(i64, i64), (usize, bool)> = HashMap::new();
    let mut sections: Vec<AtlasSection> = Vec::new();
    let mut flows_per_city: Vec<Vec<Vec<usize>>> = vec![Vec::new(); works.len()];
    let mut total_sec_pts = 0usize;
    for (sid, chain) in section_chains.iter() {
        let raw: Vec<[f64; 2]> = chain
            .iter()
            .filter_map(|id| coords.get(id).copied())
            .collect();
        if raw.len() < 2 {
            continue;
        }
        let simp = dp_keep(&raw, 0.00035);
        let simp: Vec<[f64; 2]> = simp.iter().map(|p| round_pt(*p, 4)).collect();
        if simp.len() < 2 {
            continue;
        }
        total_sec_pts += simp.len();
        let sec_idx = sections.len();
        for win in chain.windows(2) {
            edge_dir_to_sec.insert((win[0], win[1]), (sec_idx, false));
            edge_dir_to_sec.insert((win[1], win[0]), (sec_idx, true));
        }
        let a_nm = nearest_station(simp[0]);
        let b_nm = nearest_station(*simp.last().unwrap());
        let a_i = if a_nm.is_empty() {
            -1
        } else {
            intern_station(&mut station_table, &mut station_idx, &a_nm, city_en)
        };
        let b_i = if b_nm.is_empty() {
            -1
        } else {
            intern_station(&mut station_table, &mut station_idx, &b_nm, city_en)
        };
        sections.push(AtlasSection {
            a: a_i,
            b: b_i,
            g: polyline_encode(&simp),
            h: chain_hsr(chain),
        });
        for (ci, n, cls_counts) in sig_list[*sid as usize].iter() {
            flows_per_city[*ci].push(pack_flow_row(sec_idx, *n as usize, cls_counts));
        }
    }
    for f in flows_per_city.iter_mut() {
        f.sort_by(|a, b| b[1].cmp(&a[1]));
    }
    println!("sections: {} points: {}", sections.len(), total_sec_pts);
    // edges per section (row_path's partial re-coverage, national heads)
    let mut sec_edges = vec![0usize; sections.len()];
    for &(s, rev) in edge_dir_to_sec.values() {
        sec_edges[s] += !rev as usize;
    }

    // ---- P3.1 national table over `sections`: every train once ----
    // A train's legs are the union of its outbound rows (from its first
    // selected city on) and inbound rows (from its first stop to a selected
    // city), so it covers its whole run whenever it calls at a selected city.
    // Edges go through the same rule as the per-city counts (one count per
    // edge, outbound near_station grid); a train counts once on a section
    // when it covers any of its edges (flows::national_table).
    let mut nat_legs: std::collections::BTreeMap<usize, TrainLegs> = Default::default();
    let all_legs = works
        .iter()
        .flat_map(|w| w.train_leg_keys.iter())
        .chain(in_works.iter().flat_map(|w| w.train_leg_keys.iter()));
    for (cidx, ti, legs) in all_legs {
        nat_legs
            .entry(*ti)
            .or_insert_with(|| (*cidx, *ti, Vec::new()))
            .2
            .extend(legs.iter().cloned());
    }
    for (_, _, legs) in nat_legs.values_mut() {
        legs.sort();
        legs.dedup();
    }
    let nat_trains = nat_legs.values().map(|(cidx, ti, legs)| {
        let eset = flows::train_edges(legs, seqs_of, coords, |p| near_station(&station_grid, p));
        (*ti, *cidx, eset)
    });
    let (national, nat_u) = flows::national_table(
        nat_trains,
        |e| edge_dir_to_sec.get(e).map(|&(s, _)| s),
        sections.len(),
    );
    println!(
        "national: {} trains; widest section {}; sum over sections {}",
        national.trains,
        national.total.iter().max().copied().unwrap_or(0),
        national.total.iter().map(|&n| n as u64).sum::<u64>()
    );
    println!(
        "national uniformity: {} sections with unequal per-edge counts (max spread {}); {} sections whose distinct trains exceed their busiest edge (max +{})",
        nat_u.nonuniform, nat_u.max_spread, nat_u.union_above_max, nat_u.max_union_gain
    );

    // ---- inbound atomic sections: same machinery, indexed by dest city ----
    let mut in_edge_counts: HashMap<(i64, i64), HashMap<usize, u64>> = HashMap::new();
    let mut in_edge_class_counts: HashMap<(i64, i64), HashMap<usize, [u32; 8]>> = HashMap::new();
    let mut in_edge_trains = chains::EdgeTrains::new();
    for (ci, w) in in_works.iter().enumerate() {
        for (k, (cidx, _, legs)) in w.train_leg_keys.iter().enumerate() {
            let eset =
                flows::train_edges(legs, seqs_of, coords, |p| near_station(&in_station_grid, p));
            let mark = chains::train_mark(ci, k);
            for e in eset {
                let m = in_edge_trains.entry(e).or_insert(0);
                *m = m.wrapping_add(mark);
                *in_edge_counts.entry(e).or_default().entry(ci).or_insert(0) += 1;
                in_edge_class_counts
                    .entry(e)
                    .or_default()
                    .entry(ci)
                    .or_insert([0; 8])[*cidx] += 1;
            }
        }
    }
    println!("union inbound atomic edges: {}", in_edge_counts.len());
    let (in_sig_list, in_edge_sig) = chains::intern_sigs(&in_edge_counts, &in_edge_class_counts);
    let in_cuts = chain_cuts(
        in_works
            .iter()
            .flat_map(|w| w.arrs.iter())
            .map(|a| (&a.leg_keys[..], &a.leg_fwd[..])),
        &walk_geom,
        &in_edge_sig,
    );
    println!("inbound section chain cuts: {}", in_cuts.len());
    let in_section_chains = chains::build_section_chains(&in_edge_sig, &in_edge_trains, &in_cuts);
    let mut in_edge_dir_to_sec: HashMap<(i64, i64), (usize, bool)> = HashMap::new();
    let mut in_sections: Vec<AtlasSection> = Vec::new();
    let mut in_flows_per_city: Vec<Vec<Vec<usize>>> = vec![Vec::new(); in_works.len()];
    let mut in_total_sec_pts = 0usize;
    for (sid, chain) in in_section_chains.iter() {
        let raw: Vec<[f64; 2]> = chain
            .iter()
            .filter_map(|id| coords.get(id).copied())
            .collect();
        if raw.len() < 2 {
            continue;
        }
        let simp = dp_keep(&raw, 0.00035);
        let simp: Vec<[f64; 2]> = simp.iter().map(|p| round_pt(*p, 4)).collect();
        if simp.len() < 2 {
            continue;
        }
        in_total_sec_pts += simp.len();
        let sec_idx = in_sections.len();
        for win in chain.windows(2) {
            in_edge_dir_to_sec.insert((win[0], win[1]), (sec_idx, false));
            in_edge_dir_to_sec.insert((win[1], win[0]), (sec_idx, true));
        }
        let a_nm = nearest_station(simp[0]);
        let b_nm = nearest_station(*simp.last().unwrap());
        let a_i = if a_nm.is_empty() {
            -1
        } else {
            intern_station(&mut station_table, &mut station_idx, &a_nm, city_en)
        };
        let b_i = if b_nm.is_empty() {
            -1
        } else {
            intern_station(&mut station_table, &mut station_idx, &b_nm, city_en)
        };
        in_sections.push(AtlasSection {
            a: a_i,
            b: b_i,
            g: polyline_encode(&simp),
            h: chain_hsr(chain),
        });
        for (ci, n, cls_counts) in in_sig_list[*sid as usize].iter() {
            in_flows_per_city[*ci].push(pack_flow_row(sec_idx, *n as usize, cls_counts));
        }
    }
    for f in in_flows_per_city.iter_mut() {
        f.sort_by(|a, b| b[1].cmp(&a[1]));
    }
    println!(
        "in_sections: {} points: {}",
        in_sections.len(),
        in_total_sec_pts
    );
    let mut in_sec_edges = vec![0usize; in_sections.len()];
    for &(s, rev) in in_edge_dir_to_sec.values() {
        in_sec_edges[s] += !rev as usize;
    }

    // ---- assemble origins ----
    let (mut chord_legs_out, mut chord_legs_in) = (0usize, 0usize);
    // O1: throat pieces shared by both directions; path entries `base + j`
    // with base = that direction's section count
    let mut throats = Throats::default();
    let mut throat_drops = [0u64; 2];
    let geom = |key: &(String, String, String)| {
        leg_seqs(key, &leg_cache, &variant_cache).zip(leg_walks.get(key))
    };
    let mut pair_mismatch = 0u64;
    let mut origins: Vec<AtlasOrigin> = Vec::new();
    for (ci, w) in works.iter().enumerate() {
        // dep_secs: sections in travel order, a section again whenever the
        // train runs back over it (flows dedupe per train separately, above);
        // `!sec` (= -(sec + 1)) marks a section travelled against its
        // stored point order; entries >= sections.len() are throats (O1,
        // see row_path). Positions count every entry; call sec_cnt counts
        // flow sections only (dep_leg_sec_cnt = RowPath::flow_cnt).
        let mut dep_secs: Vec<Vec<i64>> = Vec::with_capacity(w.deps.len());
        let mut dep_leg_sec_cnt: Vec<Vec<usize>> = Vec::with_capacity(w.deps.len());
        let mut dep_chord_legs: Vec<Vec<[usize; 3]>> = Vec::with_capacity(w.deps.len());
        // dep_stop_pos: per dep row, the path position of every stop after
        // boarding (entries before it = full_cnt at its stop, so the stop
        // sits at the start of the departing leg's station throat), station
        // level; times and stations come from schedules[t]
        let mut dep_stop_pos: Vec<Vec<usize>> = Vec::with_capacity(w.deps.len());
        for d in w.deps.iter() {
            let p = row_path(
                &d.leg_keys,
                &d.leg_fwd,
                &d.leg_stop,
                &geom,
                &|u, v| edge_dir_to_sec.get(&(u, v)).copied(),
                &sec_edges,
                &|_, _, p| near_station(&station_grid, p).then_some(None),
                coords,
                &mut throats,
                sections.len(),
                &mut throat_drops,
            );
            let chord_legs = p.chord_legs;
            chord_legs_out += chord_legs.len();
            dep_stop_pos.push(
                ((d.board + 1)..=(d.board + d.stops_after as usize))
                    .map(|j| p.full_cnt[d.leg_stop.partition_point(|&s| s < j)])
                    .collect(),
            );
            dep_secs.push(p.secs);
            dep_leg_sec_cnt.push(p.flow_cnt);
            dep_chord_legs.push(chord_legs);
        }
        let dep_lookup: HashMap<DepKey, usize> = w
            .deps
            .iter()
            .enumerate()
            .map(|(i, d)| ((d.ti, d.from_station.clone(), d.depart.clone()), i))
            .collect();
        let mut dests: Vec<[i64; 8]> = Vec::new();
        let mut calls_out: Vec<CallList> = Vec::new();
        for (zh, st) in w.dests.iter() {
            let dp = match city_pt.get(zh) {
                Some(p) => *p,
                None => continue,
            };
            let idx = intern_city(&mut city_table, &mut city_idx, zh, city_en, &city_pt);
            let mut times = st.times.clone();
            times.sort();
            let fastest = times.first().copied().unwrap_or(-1);
            let median_v = if times.is_empty() {
                -1
            } else {
                times[times.len() / 2]
            };
            // crow-flies km (origin pt -> destination city pt) and rail km
            // (median over direct trains of summed track leg lengths)
            let crow = hav_km_ll(w.home_pt, [dp[1], dp[0]]).round() as i64;
            let mut rail = st.rail.clone();
            rail.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let rail_v = if rail.is_empty() {
                -1
            } else {
                rail[rail.len() / 2].round() as i64
            };
            dests.push([
                idx,
                st.total as i64,
                st.fast as i64,
                st.terminating as i64,
                fastest,
                median_v,
                crow,
                rail_v,
            ]);
            let mut cl: Vec<(usize, String, String, i64, u8, usize)> = Vec::new();
            for c in st.calls.iter() {
                if let Some(di) = dep_lookup.get(&(c.ti, c.from_station.clone(), c.depart.clone()))
                {
                    let sec_cnt = dep_leg_sec_cnt[*di]
                        .get(c.leg_cnt)
                        .copied()
                        .unwrap_or(*dep_leg_sec_cnt[*di].last().unwrap());
                    cl.push((
                        *di,
                        c.arr.clone(),
                        c.dep.clone(),
                        c.off,
                        if c.term { 1 } else { 0 },
                        sec_cnt,
                    ));
                }
            }
            cl.sort_by_key(|r| (r.3, mins(&r.1).unwrap_or(0)));
            if cl.len() as u64 != st.total {
                println!(
                    "CALLS MISMATCH {} -> {}: {} calls vs total {}",
                    w.zh,
                    zh,
                    cl.len(),
                    st.total
                );
            }
            calls_out.push(cl);
        }
        let mut chords: Vec<AtlasChord> = Vec::new();
        for (key, n) in w.legs.iter() {
            let resolved = leg_seqs(key, &leg_cache, &variant_cache).is_some();
            if resolved {
                continue;
            }
            if let (Some(p1), Some(p2)) = (station_pt(&key.0), station_pt(&key.1)) {
                let a_i = intern_station(&mut station_table, &mut station_idx, &key.0, city_en);
                let b_i = intern_station(&mut station_table, &mut station_idx, &key.1, city_en);
                chords.push(AtlasChord {
                    a: a_i,
                    b: b_i,
                    n: *n,
                    g: polyline_encode(&[[p1[1], p1[0]], [p2[1], p2[0]]]),
                });
            }
        }
        let mut deps: Vec<AtlasDep> = Vec::new();
        for d in w.deps.iter() {
            let t_i = intern_train(&mut train_table, &mut train_ti, &mut train_idx, &inp, d.ti);
            let fs_i = intern_station(
                &mut station_table,
                &mut station_idx,
                &d.from_station,
                city_en,
            );
            let ts_i = intern_station(&mut station_table, &mut station_idx, &d.to_station, city_en);
            let tc_i = intern_city(
                &mut city_table,
                &mut city_idx,
                &d.to_city,
                city_en,
                &city_pt,
            );
            deps.push(AtlasDep {
                t: t_i,
                fs: fs_i,
                dep: d.depart.clone(),
                ts: ts_i,
                tc: tc_i,
                arr: d.arrive.clone(),
                dur: d.dur.unwrap_or(-1),
                stops: d.stops_after,
                set: d.set,
                km: if d.km > 0.0 { d.km.round() as i64 } else { -1 },
            });
        }
        // ---- inbound assembly for this city ----
        let iw = &in_works[ci];
        // arr_secs: same encoding as dep_secs (throats >= in_sections.len()),
        // in travel order (train origin -> arrival here). arr_leg_sec_cnt[li]
        // = flow sections from leg li to the arrival, so a call's sec_cnt is
        // the trailing count.
        let mut arr_secs: Vec<Vec<i64>> = Vec::with_capacity(iw.arrs.len());
        let mut arr_leg_sec_cnt: Vec<Vec<usize>> = Vec::with_capacity(iw.arrs.len());
        let mut arr_chord_legs: Vec<Vec<[usize; 3]>> = Vec::with_capacity(iw.arrs.len());
        for a in iw.arrs.iter() {
            let p = row_path(
                &a.leg_keys,
                &a.leg_fwd,
                &a.leg_stop,
                &geom,
                &|u, v| in_edge_dir_to_sec.get(&(u, v)).copied(),
                &in_sec_edges,
                &|_, _, p| near_station(&in_station_grid, p).then_some(None),
                coords,
                &mut throats,
                in_sections.len(),
                &mut throat_drops,
            );
            let total = *p.flow_cnt.last().unwrap();
            chord_legs_in += p.chord_legs.len();
            arr_secs.push(p.secs);
            arr_leg_sec_cnt.push(p.flow_cnt.iter().map(|c| total - c).collect());
            arr_chord_legs.push(p.chord_legs);
        }
        let arr_lookup: HashMap<ArrKey, usize> = iw
            .arrs
            .iter()
            .enumerate()
            .map(|(i, a)| ((a.ti, a.from_station.clone(), a.depart.clone(), a.set), i))
            .collect();
        let mut srcs: Vec<[i64; 8]> = Vec::new();
        let mut in_calls_out: Vec<InCallList> = Vec::new();
        for (zh, st) in iw.sources.iter() {
            let dp = match city_pt.get(zh) {
                Some(p) => *p,
                None => continue,
            };
            let idx = intern_city(&mut city_table, &mut city_idx, zh, city_en, &city_pt);
            let mut times = st.times.clone();
            times.sort();
            let fastest = times.first().copied().unwrap_or(-1);
            let median_v = if times.is_empty() {
                -1
            } else {
                times[times.len() / 2]
            };
            let crow = hav_km_ll(iw.home_pt, [dp[1], dp[0]]).round() as i64;
            let mut rail = st.rail.clone();
            rail.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let rail_v = if rail.is_empty() {
                -1
            } else {
                rail[rail.len() / 2].round() as i64
            };
            srcs.push([
                idx,
                st.total as i64,
                st.fast as i64,
                st.originating as i64,
                fastest,
                median_v,
                crow,
                rail_v,
            ]);
            let mut cl: Vec<(usize, String, String, i64, u8, i64, usize)> = Vec::new();
            for c in st.calls.iter() {
                if let Some(ai) =
                    arr_lookup.get(&(c.ti, c.okey_station.clone(), c.okey_depart.clone(), c.set))
                {
                    let bfs_i = intern_station(
                        &mut station_table,
                        &mut station_idx,
                        &c.from_station,
                        city_en,
                    );
                    let sec_cnt = arr_leg_sec_cnt[*ai]
                        .get(c.leg_start)
                        .copied()
                        .unwrap_or(arr_leg_sec_cnt[*ai][0]);
                    cl.push((
                        *ai,
                        c.depart.clone(),
                        c.arr.clone(),
                        c.off,
                        if c.started { 1 } else { 0 },
                        bfs_i,
                        sec_cnt,
                    ));
                }
            }
            cl.sort_by_key(|r| (r.3, mins(&r.2).unwrap_or(0)));
            if cl.len() as u64 != st.total {
                println!(
                    "IN CALLS MISMATCH {} <- {}: {} calls vs total {}",
                    iw.zh,
                    zh,
                    cl.len(),
                    st.total
                );
            }
            in_calls_out.push(cl);
            // pair identity: srcs[X][P] must equal dests[P][X] when P is selected
            if let Some(pi) = selected.iter().position(|c| c == zh) {
                match works[pi].dests.iter().find(|(dz, _)| dz == &iw.zh) {
                    Some((_, dst)) => {
                        if dst.total != st.total {
                            pair_mismatch += 1;
                            println!(
                                "PAIR IDENTITY MISMATCH {} -> {}: out {} vs in {}",
                                zh, iw.zh, dst.total, st.total
                            );
                        }
                    }
                    None => {
                        pair_mismatch += 1;
                        println!("PAIR IDENTITY MISSING {} -> {}", zh, iw.zh);
                    }
                }
            }
        }
        let mut arrs_out: Vec<AtlasArr> = Vec::new();
        for a in iw.arrs.iter() {
            let t_i = intern_train(&mut train_table, &mut train_ti, &mut train_idx, &inp, a.ti);
            let fs_i = intern_station(
                &mut station_table,
                &mut station_idx,
                &a.from_station,
                city_en,
            );
            let fc_i = intern_city(
                &mut city_table,
                &mut city_idx,
                &a.from_city,
                city_en,
                &city_pt,
            );
            let ts_i = intern_station(
                &mut station_table,
                &mut station_idx,
                &a.arr_station,
                city_en,
            );
            arrs_out.push(AtlasArr {
                t: t_i,
                fs: fs_i,
                fc: fc_i,
                dep: a.depart.clone(),
                ts: ts_i,
                arr: a.arrive.clone(),
                dur: a.dur.unwrap_or(-1),
                stops: a.stops_before,
                set: a.set,
                km: if a.km > 0.0 { a.km.round() as i64 } else { -1 },
            });
        }
        origins.push(AtlasOrigin {
            zh: w.zh.clone(),
            en: en(&w.zh),
            pt: w.home_pt,
            outbound: w.outbound,
            fully_tracked: w.fully_tracked,
            dests,
            calls: calls_out,
            flows: flows_per_city[ci].clone(),
            chords,
            deps,
            dep_secs,
            dep_chord_legs,
            dep_stop_pos,
            inbound: iw.arrivals,
            srcs,
            in_calls: in_calls_out,
            in_flows: in_flows_per_city[ci].clone(),
            arrs: arrs_out,
            arr_secs,
            arr_chord_legs,
        });
    }

    println!("pair identity mismatches: {}", pair_mismatch);
    println!(
        "dep rows with stations lacking a city call: {} ({} trains): home city {}, terminus city {}, intermediate city {}",
        skipped_rows[3],
        skipped_trains.len(),
        skipped_rows[0],
        skipped_rows[1],
        skipped_rows[2]
    );
    println!("  examples (home / terminus / intermediate): {skipped_example:?}");
    println!(
        "chord legs (per-train rows): out {} in {}",
        chord_legs_out, chord_legs_in
    );
    println!(
        "variant legs: {} resolved via override tiling, {} fell back to base pair geometry",
        variant_stats.0, variant_stats.1
    );
    // ---- P2.2 national trains (A): every national train's whole run ----
    // Same train set and legs as the national table (nat_legs: the union of
    // a train's outbound and inbound legs, which is every leg of its run).
    // The whole path is a head over the legs before the train's first
    // selected-city departure, then that city's out-tables row verbatim (a
    // train with no outbound row is all head). The head walks `sections`
    // through the same edge map as the national table, so the sections it
    // touches are exactly the ones that table counts. A section the head
    // covers whole is a flow entry as in the out-tables rows. Sections are
    // cut where per-city counts change, so a head (track no selected city's
    // outbound train runs over) can join one at a junction mid-way: that
    // partial stretch, and track no section carries, become geometry-only
    // pieces interned like throats (a shared throat when the node chain
    // matches one, else a new piece in `extra`); a piece on a partly covered
    // section is listed in `on_sec`, so the train still counts there.
    // ti -> (boarding stop, origin, dep row) of its earliest outbound row
    let mut first_dep: HashMap<usize, (usize, usize, usize)> = HashMap::new();
    for (ci, w) in works.iter().enumerate() {
        for (ri, d) in w.deps.iter().enumerate() {
            let e = first_dep.entry(d.ti).or_insert((d.board, ci, ri));
            if d.board < e.0 {
                *e = (d.board, ci, ri);
            }
        }
    }
    let n_sec = sections.len();
    let is_flow = |v: i64| ((if v >= 0 { v } else { !v }) as usize) < n_sec;
    let mut nat_throats = throats.clone();
    let mut national_trains = NationalTrains::default();
    // trains, with a head, all head, emptied (on no section)
    let mut nt_n = [0usize; 4];
    // seam: dup dropped, flow repeat, reversal
    let mut nt_seam = [0usize; 3];
    // head entries: flow sections, shared throats, extra pieces
    let mut nt_head = [0usize; 3];
    // (throat index, section) of pieces on partly covered sections
    let mut nt_on_sec: std::collections::BTreeMap<usize, usize> = Default::default();
    let mut nt_partial = 0usize;
    let mut nt_rev_examples: Vec<String> = Vec::new();
    for (t, tr) in train_table.iter().enumerate() {
        let ti = train_ti[t];
        let Some((_, _, nat_keys)) = nat_legs.get(&ti) else {
            national_trains.paths.push(Vec::new());
            national_trains.stop_pos.push(Vec::new());
            continue;
        };
        let (names, tt) = (&train_names[ti], &trains[ti]);
        let (mut keys, mut fwd, mut stop) = (Vec::new(), Vec::new(), Vec::new());
        for k in 0..names.len() - 1 {
            let (a, b) = (&names[k], &names[k + 1]);
            if a != b {
                keys.push(leg_key3(override_map, tt, a, b));
                fwd.push(a < b);
                stop.push(k);
            }
        }
        let mut uniq = keys.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(
            &uniq, nat_keys,
            "train {}: whole-run legs differ from the national table's",
            tr.code
        );
        let dep = first_dep.get(&ti).copied();
        let b = dep.map_or(names.len() - 1, |d| d.0);
        let nh = stop.partition_point(|&s| s < b);
        // the head's edges per section: which sections it covers whole
        let mut cover: HashMap<usize, HashSet<(i64, i64)>> = HashMap::new();
        for li in 0..nh {
            if let Some((seqs, walk)) = geom(&keys[li]) {
                walk_edges(seqs, walk, fwd[li], |u, v| {
                    if let Some(&(s, _)) = edge_dir_to_sec.get(&(u, v)) {
                        cover.entry(s).or_default().insert((u.min(v), u.max(v)));
                    }
                });
            }
        }
        let whole_sec = |s: usize| cover.get(&s).is_some_and(|e| e.len() == sec_edges[s]);
        nt_partial += cover.keys().filter(|&&s| !whole_sec(s)).count();
        let h = row_path(
            &keys[..nh],
            &fwd[..nh],
            &stop[..nh],
            &geom,
            &|u, v| {
                edge_dir_to_sec
                    .get(&(u, v))
                    .copied()
                    .filter(|&(s, _)| whole_sec(s))
            },
            &sec_edges,
            &|u, v, _| Some(edge_dir_to_sec.get(&(u, v)).map(|&(s, _)| s)),
            coords,
            &mut nat_throats,
            n_sec,
            &mut [0u64; 2],
        );
        for &(j, s) in h.on_sec.iter() {
            let prev = nt_on_sec.insert(j, s);
            assert!(prev.is_none_or(|p| p == s), "piece {j} on two sections");
        }
        for &v in h.secs.iter() {
            let id = (if v >= 0 { v } else { !v }) as usize;
            nt_head[if id < n_sec {
                0
            } else if id < n_sec + throats.chains.len() {
                1
            } else {
                2
            }] += 1;
        }
        let head = trainpath::PathPart {
            stop_pos: (1..=b)
                .map(|j| h.full_cnt[stop[..nh].partition_point(|&s| s < j)])
                .collect(),
            secs: h.secs,
            chord_legs: h.chord_legs,
        };
        let tail = match dep {
            Some((_, ci, ri)) => trainpath::PathPart {
                secs: origins[ci].dep_secs[ri].clone(),
                stop_pos: origins[ci].dep_stop_pos[ri].clone(),
                chord_legs: origins[ci].dep_chord_legs[ri].clone(),
            },
            None => Default::default(),
        };
        nt_n[0] += 1;
        nt_n[1] += !head.secs.is_empty() as usize;
        nt_n[2] += dep.is_none() as usize;
        let (whole, seam) = trainpath::join(head, &tail, is_flow);
        assert_eq!(whole.stop_pos.len(), names.len() - 1, "train {}", tr.code);
        for (n, hit) in nt_seam
            .iter_mut()
            .zip([seam.dup_dropped, seam.flow_repeat, seam.reversal])
        {
            *n += hit as usize;
        }
        if seam.reversal && nt_rev_examples.len() < 8 {
            nt_rev_examples.push(format!("{} at {}", tr.code, names[b]));
        }
        let counted = |v: i64| {
            let id = (if v >= 0 { v } else { !v }) as usize;
            id < n_sec || nt_on_sec.contains_key(&(id - n_sec))
        };
        if !whole.secs.iter().any(|&v| counted(v)) {
            nt_n[3] += 1;
            national_trains.paths.push(Vec::new());
            national_trains.stop_pos.push(Vec::new());
            continue;
        }
        if !whole.chord_legs.is_empty() {
            national_trains.chords.push((t, whole.chord_legs));
        }
        national_trains.paths.push(whole.secs);
        national_trains.stop_pos.push(whole.stop_pos);
    }
    let nt_trains = national_trains
        .paths
        .iter()
        .filter(|p| !p.is_empty())
        .count();
    assert_eq!(
        nt_trains, national.trains,
        "national trains file and national table disagree on the train count"
    );
    // keep only the extra pieces a path still refers to (row_path drops a
    // throat run again when a flow section repeats right after it), numbered
    // by first use
    let extra_base = n_sec + throats.chains.len();
    let mut extra_chains: Vec<Vec<i64>> = Vec::new();
    let mut extra_new: HashMap<usize, usize> = HashMap::new();
    for v in national_trains.paths.iter_mut().flatten() {
        let (id, rev) = if *v >= 0 {
            (*v as usize, false)
        } else {
            ((!*v) as usize, true)
        };
        if id < extra_base {
            continue;
        }
        let j = *extra_new.entry(id).or_insert_with(|| {
            extra_chains.push(nat_throats.chains[id - n_sec].clone());
            extra_chains.len() - 1
        });
        let nv = (extra_base + j) as i64;
        *v = if rev { !nv } else { nv };
    }
    let n_extra = extra_chains.len();
    // pieces on partly covered sections, in path id space (as renumbered)
    for (j, s) in nt_on_sec.iter() {
        let id = n_sec + j;
        let id = if id < extra_base {
            Some(id)
        } else {
            extra_new.get(&id).map(|&k| extra_base + k)
        };
        if let Some(id) = id {
            national_trains.on_sec.push((id, *s));
        }
    }
    national_trains.on_sec.sort_unstable();
    println!(
        "national trains: {} trains ({} with a head before their first selected-city departure, {} all head, {} on no section left out); seam: {} duplicated pieces dropped, {} flow repeats, {} reversals; head entries: {} sections, {} shared throats, {} extra pieces ({} distinct pieces kept); {} trains with chord legs ({} legs)",
        nt_trains,
        nt_n[1],
        nt_n[2],
        nt_n[3],
        nt_seam[0],
        nt_seam[1],
        nt_seam[2],
        nt_head[0],
        nt_head[1],
        nt_head[2],
        n_extra,
        national_trains.chords.len(),
        national_trains.chords.iter().map(|c| c.1.len()).sum::<usize>()
    );
    println!("  seam reversal examples: {nt_rev_examples:?}");
    println!(
        "national trains: {nt_partial} (train, section) pairs where a head covers only part of a section, on {} pieces",
        national_trains.on_sec.len()
    );

    // ---- per-train schedules, indexed by train_table t, from data/raw ----
    // Names are clean()ed before interning, so every stop resolves into
    // station_table (appended after the atlas's own stations).
    // A train export's stop lists are its schedules; otherwise the 12306
    // stop-list dumps, keyed (dataset, train_no).
    let mut raw_stops: HashMap<(u8, String), Vec<RawStop>> = HashMap::new();
    if inp.calendar.is_none() {
        for (set, file) in [(0u8, "raw/stops.jsonl"), (1, "raw/stops_cs.jsonl")] {
            for line in fs::read_to_string(data_dir.join(file)).unwrap().lines() {
                let r: RawTrain = serde_json::from_str(line).unwrap();
                raw_stops.insert((set, r.train_no), r.stops);
            }
        }
    }
    let mut schedules: Vec<Vec<ScheduleRow>> = Vec::with_capacity(train_table.len());
    let (mut sched_name_mismatch, mut sched_km_unknown) = (0usize, 0usize);
    for &ti in &train_ti {
        let t = &trains[ti];
        let set = if ti < d1_len { 0u8 } else { 1 };
        let own: Vec<RawStop>;
        let stops = if inp.calendar.is_some() {
            own = t
                .stops
                .iter()
                .map(|s| RawStop {
                    station_name: s.name.clone(),
                    arrive_time: s.arrive.clone(),
                    start_time: s.depart.clone(),
                })
                .collect();
            &own
        } else {
            &raw_stops[&(set, t.train_no.clone())]
        };
        let names: Vec<String> = stops.iter().map(|s| clean(&s.station_name)).collect();
        if names != train_names[ti] {
            sched_name_mismatch += 1;
        }
        // day offsets: advance a clock from the origin departure whenever
        // a stop time wraps past midnight (as travel_time does)
        let mut clock: Option<i64> = None;
        let mut advance = |tod: i64| -> i64 {
            let c = match clock {
                None => tod,
                Some(c) => c + (tod - c).rem_euclid(1440),
            };
            clock = Some(c);
            c / 1440
        };
        let mut rows: Vec<ScheduleRow> = Vec::with_capacity(stops.len());
        for (j, s) in stops.iter().enumerate() {
            let arr = mins(&s.arrive_time);
            let dep = mins(&s.start_time);
            let day = arr.map(&mut advance);
            let day_dep = dep.map(&mut advance);
            let km = if j == 0 || names[j - 1] == names[j] {
                0.0
            } else {
                match leg_km(override_map, &pair_len, t, &names[j - 1], &names[j]) {
                    Some(l) => (l * 10.0).round() / 10.0,
                    None => {
                        sched_km_unknown += 1;
                        -1.0
                    }
                }
            };
            let st = intern_station(&mut station_table, &mut station_idx, &names[j], city_en);
            rows.push((
                st,
                arr.unwrap_or(-1),
                dep.unwrap_or(-1),
                day.or(day_dep).unwrap_or(0),
                km,
            ));
        }
        schedules.push(rows);
    }
    println!(
        "schedules: {} trains, {} name mismatches vs timetables, {} legs without km",
        schedules.len(),
        sched_name_mismatch,
        sched_km_unknown
    );

    // ---- network backdrop (shared, polyline-encoded) ----
    let mut network: Vec<String> = Vec::new();
    {
        let mut seen: HashSet<(String, String)> = HashSet::new();
        let mut keys: Vec<&(String, String)> = path_map.keys().collect();
        keys.sort();
        for key in keys {
            let segs = &path_map[key].1;
            if !seen.insert(key.clone()) {
                continue;
            }
            for s in segs {
                let c = seg_coords(s);
                if c.len() >= 2 {
                    let simp = dp_keep(&c, 0.008);
                    let simp: Vec<[f64; 2]> = simp.iter().map(|p| round_pt(*p, 3)).collect();
                    if simp.len() >= 2 {
                        network.push(polyline_encode(&simp));
                    }
                }
            }
        }
    }
    println!("network polylines: {}", network.len());

    // ---- O1 throat geometry, simplified like the sections ----
    let mut throat_pts = 0usize;
    let throat_geo: Vec<String> = throats
        .chains
        .iter()
        .map(|chain| {
            let raw: Vec<[f64; 2]> = chain.iter().map(|id| coords[id]).collect();
            let simp: Vec<[f64; 2]> = dp_keep(&raw, 0.00035)
                .iter()
                .map(|p| round_pt(*p, 4))
                .collect();
            throat_pts += simp.len();
            polyline_encode(&simp)
        })
        .collect();
    let mut extra_km = 0.0f64;
    let extra_geo: Vec<String> = extra_chains
        .iter()
        .map(|chain| {
            let raw: Vec<[f64; 2]> = chain.iter().map(|id| coords[id]).collect();
            extra_km += raw.windows(2).map(|w| hav_km_ll(w[0], w[1])).sum::<f64>();
            let simp: Vec<[f64; 2]> = dp_keep(&raw, 0.00035)
                .iter()
                .map(|p| round_pt(*p, 4))
                .collect();
            polyline_encode(&simp)
        })
        .collect();
    println!(
        "national trains extra pieces: {} ({extra_km:.1} km of head track the shared sections and throats do not draw)",
        extra_geo.len()
    );
    national_trains.extra = extra_geo;
    let throat_refs = |rows: &dyn Fn(&AtlasOrigin) -> &Vec<Vec<i64>>, base: usize| -> usize {
        origins
            .iter()
            .flat_map(|o| rows(o).iter().flatten())
            .filter(|&&v| (if v < 0 { !v } else { v }) as usize >= base)
            .count()
    };
    println!(
        "throats: {} pieces, {} points; row refs out {} in {}; flow repeats that dropped throats {} ({} across a leg boundary)",
        throat_geo.len(),
        throat_pts,
        throat_refs(&|o| &o.dep_secs, sections.len()),
        throat_refs(&|o| &o.arr_secs, in_sections.len()),
        throat_drops[0],
        throat_drops[1]
    );

    let mut stats: std::collections::BTreeMap<String, i64> = Default::default();
    stats.insert("origins".into(), origins.len() as i64);
    stats.insert("sections".into(), sections.len() as i64);
    stats.insert("in_sections".into(), in_sections.len() as i64);
    stats.insert("section_points".into(), total_sec_pts as i64);
    stats.insert("city_table".into(), city_table.len() as i64);
    stats.insert("station_table".into(), station_table.len() as i64);
    stats.insert("train_table".into(), train_table.len() as i64);
    stats.insert("network_polylines".into(), network.len() as i64);
    stats.insert("throats".into(), throat_geo.len() as i64);
    let mut about = "China Rail Flow Atlas - Minard-style outbound flow maps for China's top 100 rail cities. Shared national track-section atlas (each section = a stretch of track with constant per-city train counts); every origin city is a sparse index (section, trains/day) into it, plus destination stats and departures. Track geometry: OpenStreetMap. Timetables: 12306 timetables Wed 2026-10-21 (5,043 trains, trunk) and Wed 2026-10-28 (2,210 intercity C/S trains). Flow width = trains/day summed over each shared track section. Dashed chords = legs with no track routing. Geometry strings are Google-polyline-encoded at 1e5 precision, [lat, lon] order.".to_string();
    let calendar = inp.calendar.as_ref().map(|(_, window)| window.clone());
    if let Some(w) = &calendar {
        about = about.replace(
            "Timetables: 12306 timetables Wed 2026-10-21 (5,043 trains, trunk) and Wed 2026-10-28 (2,210 intercity C/S trains). Flow width = trains/day",
            &format!(
                "Timetables: train export, every train that runs on any date of {} .. {} counted once ({} trains). Flow width = trains",
                w.first().map_or("?", |d| d.as_str()),
                w.last().map_or("?", |d| d.as_str()),
                trains.len()
            ),
        );
    }
    // ---- per-city national counts (dep/arr), the origins' counting rules ----
    // Interned after every other city so existing city_table indices keep
    // their values; a city with no coordinates is not drawable and left out.
    let mut national = national;
    // over the pack's trains (train_table), the same set as the sections
    let counts = flows::city_counts(train_ti.iter().map(|&ti| {
        (
            class_idx(&trains[ti].train_class),
            train_cities[ti].as_slice(),
        )
    }));
    let mut rows: Vec<(i64, [u32; 8], [u32; 8])> = Vec::new();
    let mut no_pt = 0usize;
    for (zh, (d, a)) in counts.iter() {
        if !city_pt.contains_key(zh) {
            no_pt += 1;
            continue;
        }
        let i = intern_city(&mut city_table, &mut city_idx, zh, city_en, &city_pt);
        rows.push((i, *d, *a));
    }
    rows.sort_by_key(|r| r.0);
    let nc = &mut national.cities;
    nc.dep_by_class = vec![Vec::new(); 8];
    nc.arr_by_class = vec![Vec::new(); 8];
    for (i, d, a) in rows {
        nc.idx.push(i);
        nc.dep.push(d.iter().sum());
        nc.arr.push(a.iter().sum());
        for c in 0..8 {
            nc.dep_by_class[c].push(d[c]);
            nc.arr_by_class[c].push(a[c]);
        }
    }
    // parity: every origin's outbound/inbound is its city's dep/arr
    for o in origins.iter() {
        let k = city_idx
            .get(&o.zh)
            .and_then(|i| nc.idx.binary_search(i).ok())
            .unwrap_or_else(|| panic!("origin {} has no national city row", o.zh));
        assert_eq!(
            (nc.dep[k] as u64, nc.arr[k] as u64),
            (o.outbound, o.inbound),
            "national city counts differ from origin {}",
            o.zh
        );
    }
    println!(
        "national cities: {} with trains ({} without coordinates left out); {} origins agree with their dep/arr",
        nc.idx.len(),
        no_pt,
        origins.len()
    );
    stats.insert("city_table".into(), city_table.len() as i64);
    // ---- per-train national index (see flows::NationalIndex) ----
    let secs_of: HashMap<usize, &Vec<usize>> =
        national.train_secs.iter().map(|(ti, v)| (*ti, v)).collect();
    let mut national_index = flows::NationalIndex::default();
    for &ti in train_ti.iter() {
        let (tr, names, cities) = (&trains[ti], &train_names[ti], &train_cities[ti]);
        let last = tr.stops.len() - 1;
        national_index
            .hour
            .push(flows::hour_bin(&tr.stops[0].depart));
        national_index
            .dur
            .push(flows::dur_bin(travel_time(&tr.stops, 0, last)));
        let (mut km, mut ok) = (0f64, true);
        for k in 0..last {
            if names[k] != names[k + 1] {
                match leg_km(override_map, &pair_len, tr, &names[k], &names[k + 1]) {
                    Some(l) => km += l,
                    None => ok = false,
                }
            }
        }
        let km = if ok && km > 0.0 {
            km.round()
        } else {
            match (city_pt.get(&cities[0]), city_pt.get(&cities[last])) {
                (Some(a), Some(b)) => hav_km_ll([a[1], a[0]], [b[1], b[0]]),
                _ => -1.0,
            }
        };
        let (dk, dm) = flows::dist_bins(km);
        national_index.dist_km.push(dk);
        national_index.dist_mi.push(dm);
        national_index.secs.push(
            secs_of
                .get(&ti)
                .map_or(Vec::new(), |v| v.iter().map(|&s| s as u32).collect()),
        );
        let ids = |f: &dyn Fn(&[String], &str) -> Option<usize>| -> Vec<i64> {
            let mut v: Vec<i64> = cities
                .iter()
                .filter(|c| f(cities, c).is_some())
                .filter_map(|c| city_idx.get(c).copied())
                .filter(|i| nc.idx.binary_search(i).is_ok())
                .collect();
            v.sort_unstable();
            v.dedup();
            v
        };
        national_index.dep.push(ids(&flows::departs_from));
        national_index.arr.push(ids(&flows::arrives_at));
    }
    let out = AtlasOut {
        build: provenance::build_block(&inp),
        about,
        origins,
        sections,
        in_sections,
        throats: throat_geo,
        city_table,
        station_table,
        train_table,
        network,
        stats,
        schedules,
        national,
        national_trains,
        national_index,
        calendar,
    };
    let txt = serde_json::to_string(&out).unwrap();
    fs::write(&out_path, &txt).unwrap();
    println!(
        "wrote {} ({:.2} MB)",
        out_path.display(),
        txt.len() as f64 / 1e6
    );
}

fn intern_city(
    table: &mut Vec<AtlasCity>,
    idx: &mut HashMap<String, i64>,
    zh: &str,
    city_en: &HashMap<String, String>,
    city_pt: &HashMap<String, [f64; 2]>,
) -> i64 {
    if let Some(i) = idx.get(zh) {
        return *i;
    }
    let pt = city_pt.get(zh).map(|p| [p[1], p[0]]).unwrap_or([0.0, 0.0]);
    let i = table.len() as i64;
    table.push(AtlasCity {
        zh: zh.to_string(),
        en: city_en.get(zh).cloned().unwrap_or_else(|| zh.to_string()),
        pt,
    });
    idx.insert(zh.to_string(), i);
    i
}

fn intern_station(
    table: &mut Vec<AtlasStation>,
    idx: &mut HashMap<String, i64>,
    zh: &str,
    city_en: &HashMap<String, String>,
) -> i64 {
    if let Some(i) = idx.get(zh) {
        return *i;
    }
    let i = table.len() as i64;
    table.push(AtlasStation {
        zh: zh.to_string(),
        en: station_en(zh, city_en),
    });
    idx.insert(zh.to_string(), i);
    i
}

/// The train_table row of train `ti` (an index into `inp.trains`): one row
/// per train, so two trains sharing a code stay apart.
fn intern_train(
    table: &mut Vec<AtlasTrainRef>,
    table_ti: &mut Vec<usize>,
    idx: &mut HashMap<usize, usize>,
    inp: &inputs::Inputs,
    ti: usize,
) -> usize {
    if let Some(i) = idx.get(&ti) {
        return *i;
    }
    let i = table.len();
    let t = &inp.trains[ti];
    let cal = inp.calendar.as_ref().map(|(c, _)| &c[ti]);
    table.push(AtlasTrainRef {
        code: t.code.clone(),
        class: t.train_class.clone(),
        days: cal.map(|c| c.days.clone()),
        pattern: cal.and_then(|c| c.pattern.clone()),
        suspended: cal.and_then(|c| c.listed_suspended.then_some(true)),
    });
    table_ti.push(ti);
    idx.insert(ti, i);
    i
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
