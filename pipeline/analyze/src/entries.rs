//! National entry minutes (P3.3, A+B): for every national train and every
//! section it counts on, the minute of day at which its animated dot first
//! reaches the section, so the national flows can build up through the day
//! while the client only counts (binary search + sums).
//!
//! The times follow the client animation exactly, so a section lights up
//! when the dot arrives:
//! - Distance space: the client's `prepTrainPath` (web/src/lib/timeline.ts)
//!   over the pack's geometry as the client decodes it (1e4 polylines into a
//!   `Float32Array`, so coordinates are rounded to f32 here too), haversine
//!   lengths, chord legs as straight virtual gaps at the widest join, stop
//!   distances by the `virt` / `virtStop` rule.
//! - Times: `buildNational` (web/src/lib/national.ts) puts a train's stops in
//!   its boarding day's frame (absolute minutes from the first stop's day);
//!   `natState` moves the dot at constant speed along each leg between stops
//!   (a leg shorter than a minute stretched to one) and holds it at a stop
//!   between arrival and departure. [`Motion::time_at`] is the exact inverse
//!   of [`Motion::dist_at`] (the port of `natState`).
//! - Wrap (D7): the shipped minute is the absolute minute mod 1440, since the
//!   client shows a train at display minute m when m + 1440k lies in its run.
//!   Each train counts once per section, at its first entry, so the counts at
//!   24:00 are the national table's exactly.
//!
//! No presentation function is involved (no easing), but the dwell rule,
//! the day frame and the short-leg stretch must match the client's
//! `natState` / `buildNational`; the oracle compares them.

use serde_json::Value;

use crate::cn::class_idx;
use crate::polyline::decode_poly4;

/// The client's `haversineKm` (lib/geo.ts), same operation order.
pub fn haversine_km(a: [f64; 2], b: [f64; 2]) -> f64 {
    let rad = std::f64::consts::PI / 180.0;
    let d_lat = (b[1] - a[1]) * rad;
    let d_lon = (b[0] - a[0]) * rad;
    let s = (d_lat / 2.0).sin() * (d_lat / 2.0).sin()
        + (a[1] * rad).cos() * (b[1] * rad).cos() * (d_lon / 2.0).sin() * (d_lon / 2.0).sin();
    2.0 * 6371.0 * s.sqrt().min(1.0).asin()
}

/// Path pieces (sections, then throats, then extra pieces) as the client
/// decodes them: their track length and end points.
#[derive(Debug, Clone, Default)]
pub struct Pieces {
    pub len: Vec<f64>,
    pub first: Vec<[f64; 2]>,
    pub last: Vec<[f64; 2]>,
}

impl Pieces {
    /// From 1e4 polylines in id order.
    pub fn from_polylines<'a>(polys: impl IntoIterator<Item = &'a str>) -> Self {
        let mut p = Pieces::default();
        for s in polys {
            let pts: Vec<[f64; 2]> = decode_poly4(s)
                .into_iter()
                .map(|q| [q[0] as f32 as f64, q[1] as f32 as f64])
                .collect();
            assert!(!pts.is_empty(), "empty path piece");
            p.len
                .push(pts.windows(2).map(|w| haversine_km(w[0], w[1])).sum());
            p.first.push(pts[0]);
            p.last.push(*pts.last().unwrap());
        }
        p
    }

    /// End point of signed path entry `v` in travel order (`at_end`: where
    /// the train leaves it).
    fn end_pt(&self, v: i64, at_end: bool) -> [f64; 2] {
        let id = (if v < 0 { !v } else { v }) as usize;
        if at_end != (v < 0) {
            self.last[id]
        } else {
            self.first[id]
        }
    }
}

/// A train's distance space (the client's `prepTrainPath`).
#[derive(Debug, Clone, PartialEq)]
pub struct TrainPath {
    pub total: f64,
    /// Where each path entry's own track starts.
    pub starts: Vec<f64>,
    /// Route distance of each stop after the first.
    pub stop_dist: Vec<f64>,
}

/// Port of `prepTrainPath(path, stopPos, chordLegs, atlas, firstStopJ)`.
pub fn train_path(
    path: &[i64],
    stop_pos: &[usize],
    chord_legs: &[[usize; 3]],
    pieces: &Pieces,
    first_stop_j: usize,
) -> TrainPath {
    let n = path.len();
    let mut virt = vec![0.0f64; n + 1];
    let mut virt_stop = vec![usize::MAX; n + 1];
    for leg in chord_legs {
        let (mut best_j, mut best_gap) = (0usize, 0.0f64);
        let hi = leg[2].min(n.saturating_sub(1));
        for j in leg[1].max(1)..=hi {
            let gap = haversine_km(
                pieces.end_pt(path[j - 1], true),
                pieces.end_pt(path[j], false),
            );
            if gap > best_gap {
                best_gap = gap;
                best_j = j;
            }
        }
        if best_j > 0 {
            virt[best_j] = best_gap;
            virt_stop[best_j] = leg[0];
        }
    }
    let mut total = 0.0f64;
    let mut starts = Vec::with_capacity(n);
    for (i, &v) in path.iter().enumerate() {
        total += virt[i];
        starts.push(total);
        total += pieces.len[(if v < 0 { !v } else { v }) as usize];
    }
    let mut stop_dist = Vec::with_capacity(stop_pos.len());
    let mut prev = 0.0f64;
    for (i, &k) in stop_pos.iter().enumerate() {
        let d = if i + 1 == stop_pos.len() {
            total
        } else if k >= n {
            prev.max(total)
        } else if virt[k] > 0.0 && virt_stop[k] == first_stop_j + i {
            prev.max(starts[k] - virt[k])
        } else {
            prev.max(starts[k])
        };
        prev = d;
        stop_dist.push(d);
    }
    TrainPath {
        total,
        starts,
        stop_dist,
    }
}

/// One stop after boarding, in absolute minutes of the boarding day's frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stop {
    pub dist: f64,
    pub arr: f64,
    /// -1: no departure (terminus or untimed), as in the client.
    pub dep: f64,
}

/// A train's motion (the client's `NationalTimeline` row for it).
#[derive(Debug, Clone, PartialEq)]
pub struct Motion {
    pub start: f64,
    pub end: f64,
    pub total: f64,
    pub stops: Vec<Stop>,
}

impl Motion {
    /// From schedule rows `[station, arr, dep, day, km]` (boarding = row 0;
    /// one row per stop distance after it), as `buildNational` does.
    pub fn new(sched: &[[i64; 4]], tp: &TrainPath) -> Self {
        let n = tp.stop_dist.len();
        assert_eq!(sched.len(), n + 1, "one schedule row per stop");
        let rb = sched[0];
        let start =
            (rb[3] * 1440 + rb[2] + if rb[1] >= 0 && rb[2] < rb[1] { 1440 } else { 0 }) as f64;
        let stops: Vec<Stop> = (0..n)
            .map(|i| {
                let r = sched[i + 1];
                let dep = if i + 1 == n || r[2] < 0 {
                    -1.0
                } else {
                    ((r[3] + (r[2] < r[1]) as i64) * 1440 + r[2]) as f64
                };
                Stop {
                    dist: tp.stop_dist[i],
                    arr: (r[3] * 1440 + r[1]) as f64,
                    dep,
                }
            })
            .collect();
        let end = stops.last().map_or(start, |s| s.arr);
        Motion {
            start,
            end,
            total: tp.total,
            stops,
        }
    }

    /// Distance along the path at absolute minute `a` (port of `natState`).
    pub fn dist_at(&self, a: f64) -> f64 {
        for s in &self.stops {
            if s.dep >= 0.0 && s.dep > s.arr && a >= s.arr && a <= s.dep {
                return s.dist;
            }
        }
        let (mut d0, mut t0, mut d1, mut t1) = (0.0, self.start, self.total, self.end);
        for s in &self.stops {
            if a < s.arr {
                d1 = s.dist;
                t1 = s.arr;
                break;
            }
            d0 = s.dist;
            t0 = if s.dep >= 0.0 { s.dep } else { s.arr };
        }
        let dur = (t1 - t0).max(1.0);
        let tau = ((a - t0) / dur).clamp(0.0, 1.0);
        d0 + tau * (d1 - d0)
    }

    /// First absolute minute at which the dot has reached distance `d`: the
    /// first leg ending at or beyond `d`, inverted linearly. A leg
    /// shorter than a minute is stretched to one by the client, so its dot
    /// jumps to the stop at the arrival time: the result is capped there.
    pub fn time_at(&self, d: f64) -> f64 {
        let (mut d0, mut t0) = (0.0, self.start);
        for s in &self.stops {
            if d <= s.dist {
                return leg_time(d, d0, t0, s.dist, s.arr);
            }
            d0 = s.dist;
            t0 = if s.dep >= 0.0 { s.dep } else { s.arr };
        }
        leg_time(d, d0, t0, self.total, self.end)
    }
}

fn leg_time(d: f64, d0: f64, t0: f64, d1: f64, t1: f64) -> f64 {
    if d <= d0 {
        return t0;
    }
    let dur = (t1 - t0).max(1.0);
    // the leg end itself is the arrival exactly
    let tau = ((d - d0) / (d1 - d0)).min(1.0);
    let a = t0 + tau * dur;
    if t1 >= t0 {
        a.min(t1)
    } else {
        a
    }
}

/// Minute of day of absolute minute `a`, in ticks of `1 / ticks_per_min`
/// minute, rounded up (a section never lights before the dot reaches it)
/// and wrapped into `[0, 1440 * ticks_per_min)`.
pub fn day_tick(a: f64, ticks_per_min: u32) -> u32 {
    let day = 1440 * ticks_per_min;
    let t = (a.rem_euclid(1440.0) * ticks_per_min as f64 - 1e-6)
        .ceil()
        .max(0.0) as u32;
    t % day
}

/// Each section a train counts on (flow section ids, and `on_sec` pieces'
/// sections) once, in path order, with the path index of its first entry.
/// `on_sec[id - n_sec]` = the section a geometry-only piece lies on.
pub fn first_entries(path: &[i64], n_sec: usize, on_sec: &[Option<usize>]) -> Vec<(usize, usize)> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (i, &v) in path.iter().enumerate() {
        let id = (if v < 0 { !v } else { v }) as usize;
        let s = if id < n_sec {
            Some(id)
        } else {
            on_sec.get(id - n_sec).copied().flatten()
        };
        if let Some(s) = s {
            if seen.insert(s) {
                out.push((s, i));
            }
        }
    }
    out
}

/// One national train's entries: class bucket, `(section, path index,
/// absolute minute)` per section it counts on (first entry, path order),
/// and its motion (for checks).
#[derive(Debug, Clone)]
pub struct TrainEntries {
    pub t: usize,
    pub cls: usize,
    pub entries: Vec<(usize, usize, f64)>,
    pub motion: Motion,
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn ints(v: &Value) -> Vec<i64> {
    arr(v).iter().map(|x| x.as_i64().unwrap()).collect()
}

/// The national trains file's whole paths, read against the shared file
/// and the schedules (`atlas-v2-shared`, `-national-trains` as packed, and
/// the `schedules` array): every train with a path, in train order.
pub fn from_pack(shared: &Value, nt: &Value, schedules: &Value) -> Vec<TrainEntries> {
    let secs = arr(&shared["sections"]);
    let n_sec = secs.len();
    let thr = arr(&shared["throats"]);
    let extra = arr(&nt["extra"]);
    let pieces = Pieces::from_polylines(
        secs.iter()
            .map(|s| s["g"].as_str().unwrap())
            .chain(thr.iter().chain(extra).map(|s| s.as_str().unwrap())),
    );
    let mut on_sec = vec![None; thr.len() + extra.len()];
    for r in arr(&nt["on_sec"]) {
        let r = ints(r);
        on_sec[r[0] as usize - n_sec] = Some(r[1] as usize);
    }
    let chords: std::collections::HashMap<usize, Vec<[usize; 3]>> = arr(&nt["chords"])
        .iter()
        .map(|c| {
            let legs = arr(&c[1])
                .iter()
                .map(|l| {
                    let l = ints(l);
                    [l[0] as usize, l[1] as usize, l[2] as usize]
                })
                .collect();
            (c[0].as_u64().unwrap() as usize, legs)
        })
        .collect();
    let train_table = arr(&shared["train_table"]);
    let sched = arr(schedules);
    let stop_pos = arr(&nt["stop_pos"]);
    let mut out = Vec::new();
    for (t, p) in arr(&nt["paths"]).iter().enumerate() {
        let path = ints(p);
        if path.is_empty() {
            continue;
        }
        let sp: Vec<usize> = ints(&stop_pos[t]).iter().map(|&k| k as usize).collect();
        let rows: Vec<[i64; 4]> = arr(&sched[t])
            .iter()
            .map(|r| std::array::from_fn(|k| r[k].as_i64().unwrap()))
            .collect();
        let legs = chords.get(&t).map_or(&[][..], Vec::as_slice);
        let tp = train_path(&path, &sp, legs, &pieces, 1);
        let motion = Motion::new(&rows, &tp);
        let entries = first_entries(&path, n_sec, &on_sec)
            .into_iter()
            .map(|(s, i)| (s, i, motion.time_at(tp.starts[i])))
            .collect();
        out.push(TrainEntries {
            t,
            cls: class_idx(train_table[t]["class"].as_str().unwrap_or("")),
            entries,
            motion,
        });
    }
    out
}

/// Per class bucket and section, the sorted entry ticks of day
/// (`by_class[c][s]`, see [`day_tick`]).
pub fn by_class(trains: &[TrainEntries], n_sec: usize, ticks_per_min: u32) -> Vec<Vec<Vec<u32>>> {
    let mut out = vec![vec![Vec::new(); n_sec]; 8];
    for tr in trains {
        for &(s, _, a) in &tr.entries {
            out[tr.cls][s].push(day_tick(a, ticks_per_min));
        }
    }
    for c in out.iter_mut() {
        for s in c.iter_mut() {
            s.sort_unstable();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pieces of 10, 20 and 5 km (lengths set directly); piece 1 runs from
    /// [0, 0] to [1, 0], piece 2 sits at [1, 0].
    fn pieces() -> Pieces {
        Pieces {
            len: vec![10.0, 20.0, 5.0],
            first: vec![[0.0, 0.0], [0.0, 0.0], [1.0, 0.0]],
            last: vec![[0.0, 0.0], [1.0, 0.0], [1.0, 0.0]],
        }
    }

    #[test]
    fn path_starts_and_stop_distances() {
        let tp = train_path(&[0, !1, 2], &[1, 3], &[], &pieces(), 1);
        assert_eq!(tp.starts, vec![0.0, 10.0, 30.0]);
        assert_eq!(tp.stop_dist, vec![10.0, 35.0]);
        assert_eq!(tp.total, 35.0);
    }

    #[test]
    fn a_chord_leg_adds_its_gap_at_the_widest_join() {
        // !1 ends at [0,0]; piece 2 starts at [1,0]: a gap of ~111 km
        let tp = train_path(&[!1, 2], &[1, 2], &[[1, 1, 1]], &pieces(), 1);
        let gap = haversine_km([0.0, 0.0], [1.0, 0.0]);
        assert!((tp.starts[1] - (20.0 + gap)).abs() < 1e-9);
        // the stop departing across the gap sits on its near side
        assert!((tp.stop_dist[0] - 20.0).abs() < 1e-9);
    }

    fn motion() -> Motion {
        // dep 600; stop 1 at 10 km arr 610 dep 615; terminus at 35 km arr 640
        let tp = train_path(&[0, !1, 2], &[1, 3], &[], &pieces(), 1);
        Motion::new(&[[0, -1, 600, 0], [1, 610, 615, 0], [2, 640, -1, 0]], &tp)
    }

    #[test]
    fn time_at_inverts_dist_at() {
        let m = motion();
        assert_eq!(m.time_at(0.0), 600.0);
        assert_eq!(m.time_at(10.0), 610.0); // arrives at the stop
        assert_eq!(m.dist_at(612.0), 10.0); // dwell
        assert_eq!(m.time_at(5.0), 605.0); // constant speed along the leg
        assert_eq!(m.time_at(22.5), 627.5);
        for d in [0.5, 3.0, 9.99, 10.01, 22.0, 34.9, 35.0] {
            let a = m.time_at(d);
            assert!((m.dist_at(a) - d).abs() < 1e-6, "d {d} a {a}");
            assert!(m.dist_at(a - 1e-3) < d);
        }
    }

    #[test]
    fn a_sub_minute_leg_jumps_at_the_arrival() {
        let tp = train_path(&[0], &[1], &[], &pieces(), 1);
        // 0.5 min apart is impossible in whole minutes; use 0: dep = arr
        let m = Motion::new(&[[0, -1, 600, 0], [1, 600, -1, 0]], &tp);
        assert_eq!(m.time_at(9.0), 600.0);
    }

    #[test]
    fn overnight_minutes_wrap_and_never_round_down() {
        assert_eq!(day_tick(1500.0, 10), 600);
        assert_eq!(day_tick(1439.97, 10), 0); // 23:59.97 rounds up to 24:00 = 00:00
        assert_eq!(day_tick(600.0000000001, 10), 6000);
        assert_eq!(day_tick(600.01, 10), 6001);
        assert_eq!(day_tick(2.0 * 1440.0 + 5.0, 1), 5);
    }

    #[test]
    fn first_entries_count_on_sec_pieces_once() {
        // n_sec 3; id 3 lies on section 1, id 4 on none
        let on = [Some(1), None];
        let e = first_entries(&[3, 1, !1, 4, 0, !3], 3, &on);
        assert_eq!(e, vec![(1, 0), (0, 4)]);
    }
}
