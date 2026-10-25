//! From trains to the routing problem: every train leg between
//! consecutive stops, grouped by unordered station pair, and each pair
//! placed on the map (station points, chord, classes, fastest schedule).
use crate::baseline::Baseline;
use crate::classes::{class_index, NCLASS};
use crate::graph::hav;
use crate::schedule::{travel_time, Train};
use crate::stations::{pick_points, Stations};
use std::collections::HashMap;

/// Unordered station-name pair, smaller name first.
pub type Key = (String, String);

/// The unordered key of `a`-`b`, and whether `a`->`b` runs key.0 -> key.1.
pub fn pair_key(a: &str, b: &str) -> (Key, bool) {
    if a < b {
        ((a.to_string(), b.to_string()), true)
    } else {
        ((b.to_string(), a.to_string()), false)
    }
}

/// A train's leg between consecutive stops `j` -> `j + 1`.
pub struct Leg {
    pub train: usize,
    pub j: usize,
    pub key: Key,
    pub forward: bool,
    pub class: usize,
    pub minutes: Option<f64>,
}

/// One unordered station pair to route.
pub struct PairInfo {
    pub key: Key,
    pub pa: [f64; 2],
    pub pb: [f64; 2],
    pub chord: f64,
    pub prod_status: String,
    pub prod_gap: Option<f64>,
    pub prod_track: Option<f64>,
    pub class_mask: u32,
    pub dominant: usize,
    pub min_minutes: Option<f64>,
}

/// Every leg of every train, in train then stop order.
pub fn legs_of(trains: &[Train]) -> Vec<Leg> {
    let mut legs: Vec<Leg> = Vec::new();
    for (ti, t) in trains.iter().enumerate() {
        let c = class_index(&t.class);
        for j in 0..t.stops.len().saturating_sub(1) {
            let (a, b) = (&t.stops[j].name, &t.stops[j + 1].name);
            if a == b {
                continue;
            }
            let (key, forward) = pair_key(a, b);
            legs.push(Leg {
                train: ti,
                j,
                key,
                forward,
                class: c,
                minutes: travel_time(&t.stops, j, j + 1)
                    .filter(|m| *m > 0)
                    .map(|m| m as f64),
            });
        }
    }
    legs
}

/// Leg indices per pair.
pub fn by_pair(legs: &[Leg]) -> HashMap<Key, Vec<usize>> {
    let mut pair_legs: HashMap<Key, Vec<usize>> = HashMap::new();
    for (i, l) in legs.iter().enumerate() {
        pair_legs.entry(l.key.clone()).or_default().push(i);
    }
    pair_legs
}

/// The pairs to route, sorted; optionally only `only`, then the first
/// `limit`.
pub fn route_keys(
    pair_legs: &HashMap<Key, Vec<usize>>,
    only: Option<&Key>,
    limit: Option<usize>,
) -> Vec<Key> {
    let mut keys: Vec<Key> = pair_legs.keys().cloned().collect();
    keys.sort();
    if let Some(k) = only {
        keys.retain(|x| x == k);
    }
    if let Some(n) = limit {
        keys.truncate(n);
    }
    keys
}

/// Place each pair on the map. Pairs whose baseline records disagree on
/// the chord (the names denote two different station pairs) are left
/// out and counted; so are pairs with an unknown station.
pub fn pair_infos(
    keys: &[Key],
    pair_legs: &HashMap<Key, Vec<usize>>,
    legs: &[Leg],
    baseline: &Baseline,
    stations: &Stations,
    snaps_ok: &dyn Fn([f64; 2]) -> bool,
) -> (Vec<PairInfo>, usize) {
    let mut dup_pairs = 0usize;
    let mut pairs: Vec<PairInfo> = Vec::new();
    for key in keys {
        let recs = baseline.pairs.get(key);
        let chords: Vec<f64> = recs
            .map(|r| r.iter().map(|x| x.chord).collect())
            .unwrap_or_default();
        if chords.iter().any(|c| (c - chords[0]).abs() > 1.0) {
            dup_pairs += 1; // the names denote two different station pairs
            continue;
        }
        let (Some(pa), Some(pb)) = (stations.get(&key.0), stations.get(&key.1)) else {
            continue;
        };
        let Some((pa, pb)) = pick_points(pa, pb, chords.first().copied(), snaps_ok) else {
            continue;
        };
        let mut mask = 0u32;
        let mut count = [0usize; NCLASS];
        let mut min_m: Option<f64> = None;
        for &li in &pair_legs[key] {
            mask |= 1 << legs[li].class;
            count[legs[li].class] += 1;
            if let Some(m) = legs[li].minutes {
                min_m = Some(min_m.map_or(m, |x: f64| x.min(m)));
            }
        }
        let dominant = (0..NCLASS).max_by_key(|&c| count[c]).unwrap();
        let rec = recs.and_then(|r| r.first());
        pairs.push(PairInfo {
            key: key.clone(),
            pa,
            pb,
            chord: hav(pa, pb).max(0.5),
            prod_status: rec.map(|r| r.status.clone()).unwrap_or_default(),
            prod_gap: rec.and_then(|r| r.gap),
            prod_track: rec.and_then(|r| r.track),
            class_mask: mask,
            dominant,
            min_minutes: min_m,
        });
    }
    (pairs, dup_pairs)
}
