//! Leg geometry: pair paths, per-leg router paths, per-train overrides, and
//! the resolution of a (train, from, to) leg into track segments.
//! Shared by `atlas` (builder) and `audit` (independent recount).

use crate::geo::*;
use crate::timetable::*;
use serde::Deserialize;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Station-pair key used throughout the pipeline.
pub type PairKey = (String, String);

/// Routed track paths per station pair: (path id, vertex-id segments).
pub type PathMap = HashMap<PairKey, (String, Vec<Vec<i64>>)>;

pub type CorridorAdj = HashMap<String, Vec<(String, Option<(String, String)>, f64)>>;

#[derive(Deserialize)]
pub struct PPFile {
    pub pairs: Vec<PPPair>,
}

#[derive(Deserialize)]
pub struct PPPair {
    pub from: String,
    pub to: String,
    pub status: String,
    pub segments: Vec<Vec<i64>>,
}

/// Dijkstra over the corridor graph; returns the chain of pair keys and
/// their total drawn length. Virtual (None) edges move the search between
/// same-city stations but contribute no pair and no drawn length.
pub fn dijkstra_chain(
    adj: &CorridorAdj,
    a: &str,
    b: &str,
    pair_len: &HashMap<(String, String), f64>,
) -> Option<(Vec<(String, String)>, f64)> {
    let mut dist: HashMap<String, f64> = HashMap::from([(a.to_string(), 0.0)]);
    let mut prev: HashMap<String, (String, Option<(String, String)>)> = HashMap::new();
    let mut visited: HashSet<String> = HashSet::new();
    // min-heap on (cost bits, name): exact-cost ties pop in name order
    let mut heap: BinaryHeap<Reverse<(u64, String)>> =
        BinaryHeap::from([Reverse((0f64.to_bits(), a.to_string()))]);
    loop {
        let Reverse((dbits, u)) = heap.pop()?;
        if visited.contains(&u) {
            continue;
        }
        let du = f64::from_bits(dbits);
        if u == b {
            break;
        }
        visited.insert(u.clone());
        if let Some(edges) = adj.get(&u) {
            for (v, pk, w) in edges {
                let nd = du + w;
                if nd < *dist.get(v).unwrap_or(&f64::INFINITY) {
                    dist.insert(v.clone(), nd);
                    prev.insert(v.clone(), (u.clone(), pk.clone()));
                    heap.push(Reverse((nd.to_bits(), v.clone())));
                }
            }
        }
    }
    if !dist.contains_key(b) {
        return None;
    }
    let mut pair_chain: Vec<(String, String)> = Vec::new();
    let mut cur = b.to_string();
    while cur != a {
        let (p, pk) = prev.get(&cur)?;
        if let Some(k) = pk {
            pair_chain.push(k.clone());
        }
        cur = p.clone();
    }
    if pair_chain.is_empty() || pair_chain.len() > 40 {
        return None;
    }
    pair_chain.reverse();
    let drawn_total: f64 = pair_chain
        .iter()
        .map(|k| pair_len.get(k).copied().unwrap_or(0.0))
        .sum();
    Some((pair_chain, drawn_total))
}

/// Resolve one leg to track node sequences: direct pair geometry, else a
/// corridor chain (cached). None = honest chord.
#[allow(clippy::too_many_arguments)]
pub fn resolve_leg(
    key: &(String, String),
    path_map: &PathMap,
    adj_pure: &CorridorAdj,
    adj: &CorridorAdj,
    pair_len: &HashMap<(String, String), f64>,
    station_pt: &dyn Fn(&str) -> Option<[f64; 2]>,
    cache: &mut HashMap<(String, String), Option<Vec<Vec<i64>>>>,
) -> Option<Vec<Vec<i64>>> {
    if let Some(v) = cache.get(key) {
        return v.clone();
    }
    let result = (|| {
        if let Some((_, segs)) = path_map.get(key) {
            if segs.iter().any(|s| s.len() >= 2) {
                return Some(segs.clone());
            }
        }
        let (a, b) = (&key.0, &key.1);
        let chord_km = match (station_pt(a), station_pt(b)) {
            (Some(p), Some(q)) => hav_km_ll([p[1], p[0]], [q[1], q[0]]),
            _ => return None,
        };
        for adj_ref in [adj_pure, adj] {
            if let Some((pair_chain, drawn_total)) = dijkstra_chain(adj_ref, a, b, pair_len) {
                if drawn_total > chord_km * 1.6 + 20.0 {
                    continue;
                }
                let mut seqs: Vec<Vec<i64>> = Vec::new();
                for k in pair_chain.iter() {
                    if let Some((_, ss)) = path_map.get(k) {
                        for s in ss {
                            if s.len() >= 2 {
                                seqs.push(s.clone());
                            }
                        }
                    }
                }
                if !seqs.is_empty() {
                    return Some(seqs);
                }
            }
        }
        None
    })();
    cache.insert(key.clone(), result.clone());
    result
}

/// One corridor-classification override from legclass: this train's
/// nonstop leg from->to is drawn via the given waypoint chain instead
/// of the pair's default geometry (see legclass.rs for the rule).
#[derive(Deserialize)]
pub struct LegOverride {
    #[serde(default)]
    pub train_no: String,
    pub code: String,
    pub from: String,
    pub to: String,
    pub via: Vec<String>,
}

/// Override lookup keyed (identity, from, to); identity is the train's
/// internal train_no when the record carries one, else its code — both
/// keys are inserted so lookup succeeds with whichever the train has.
pub type OverrideMap = HashMap<(String, String, String), Vec<String>>;

pub fn load_overrides(path: &PathBuf) -> OverrideMap {
    let mut map: OverrideMap = HashMap::new();
    if let Ok(txt) = fs::read_to_string(path) {
        if let Ok(recs) = serde_json::from_str::<Vec<LegOverride>>(&txt) {
            println!(
                "leg overrides loaded: {} from {}",
                recs.len(),
                path.display()
            );
            for r in recs {
                if !r.train_no.is_empty() {
                    map.insert(
                        (r.train_no.clone(), r.from.clone(), r.to.clone()),
                        r.via.clone(),
                    );
                }
                map.insert((r.code.clone(), r.from, r.to), r.via);
            }
        }
    }
    map
}

/// Per-train leg paths from the staging corridor router (env
/// ATLAS_LEG_PATHS): each record names one train's directed leg and a
/// track-path id ("#..."). The id becomes that leg's via token, and its
/// segments and km are served from LEG_PATHS. Unset: no effect at all.
#[derive(Deserialize)]
pub struct LegPath {
    #[serde(default)]
    pub train_no: String,
    pub code: String,
    pub from: String,
    pub to: String,
    pub id: String,
    pub km: f64,
    pub segments: Vec<Vec<i64>>,
}

pub type LegPathMap = HashMap<String, (Vec<Vec<i64>>, f64)>;

pub static LEG_PATHS: std::sync::OnceLock<LegPathMap> = std::sync::OnceLock::new();

/// The router leg-path file: `ATLAS_LEG_PATHS`, else the default corridor-v3 one.
pub fn leg_paths_file(data_dir: &Path) -> PathBuf {
    env::var("ATLAS_LEG_PATHS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir.join("derived/corridor-v3/leg_paths.json"))
}

/// Load ATLAS_LEG_PATHS (or default corridor-v3 leg_paths) into the override map and LEG_PATHS.
/// Keyed by train_no; by public code only when train_no is absent
/// (codes are reused across physical trains).
pub fn load_leg_paths(map: &mut OverrideMap, data_dir: &Path) {
    let mut paths: LegPathMap = HashMap::new();
    let p_path = leg_paths_file(data_dir);
    if p_path.exists() {
        let recs: Vec<LegPath> =
            serde_json::from_str(&fs::read_to_string(&p_path).unwrap()).unwrap();
        println!("leg paths loaded: {} from {}", recs.len(), p_path.display());
        for r in recs {
            let key_id = if r.train_no.is_empty() {
                r.code
            } else {
                r.train_no
            };
            map.insert((key_id, r.from, r.to), vec![r.id.clone()]);
            paths.entry(r.id).or_insert((r.segments, r.km));
        }
    }
    LEG_PATHS.set(paths).ok();
}

/// The router path behind a via token, if it is one.
pub fn leg_path(via: &str) -> Option<&'static (Vec<Vec<i64>>, f64)> {
    if via.starts_with('#') {
        LEG_PATHS.get()?.get(via)
    } else {
        None
    }
}

/// The via chain for train t's directed leg a->b, if an override exists.
pub fn override_via<'m>(map: &'m OverrideMap, t: &Train, a: &str, b: &str) -> Option<&'m [String]> {
    if !t.train_no.is_empty() {
        if let Some(v) = map.get(&(t.train_no.clone(), a.to_string(), b.to_string())) {
            return Some(v.as_slice());
        }
    }
    map.get(&(t.code.clone(), a.to_string(), b.to_string()))
        .map(|v| v.as_slice())
}

/// Leg key: unordered station pair plus the via chain (in key.0 -> key.1
/// direction, ">"-joined; empty = the pair's default geometry).
pub fn leg_key3(map: &OverrideMap, t: &Train, a: &str, b: &str) -> (String, String, String) {
    let via = override_via(map, t, a, b);
    if a < b {
        (
            a.to_string(),
            b.to_string(),
            via.map(|v| v.join(">")).unwrap_or_default(),
        )
    } else {
        let mut rev: Vec<String> = via.map(|v| v.to_vec()).unwrap_or_default();
        rev.reverse();
        (b.to_string(), a.to_string(), rev.join(">"))
    }
}

/// Track km for train t's directed leg a->b: the via tiling's summed
/// pair lengths when overridden, else the pair's own length.
pub fn leg_km(
    map: &OverrideMap,
    pair_len: &HashMap<(String, String), f64>,
    t: &Train,
    a: &str,
    b: &str,
) -> Option<f64> {
    let base = |x: &str, y: &str| -> Option<f64> {
        let key = if x < y {
            (x.to_string(), y.to_string())
        } else {
            (y.to_string(), x.to_string())
        };
        pair_len.get(&key).copied()
    };
    if let Some([one]) = override_via(map, t, a, b) {
        if let Some((_, km)) = leg_path(one) {
            return Some(*km);
        }
    }
    match override_via(map, t, a, b) {
        Some(via) if !via.is_empty() => {
            let mut pts: Vec<&str> = vec![a];
            pts.extend(via.iter().map(|s| s.as_str()));
            pts.push(b);
            let mut total = 0.0;
            for w in pts.windows(2) {
                total += base(w[0], w[1])?;
            }
            Some(total)
        }
        _ => base(a, b),
    }
}

pub type PairCache = HashMap<(String, String), Option<Vec<Vec<i64>>>>;

pub type VariantCache = HashMap<(String, String, String), Option<Vec<Vec<i64>>>>;

/// Resolve a leg key (pair + optional via chain) to track segments: a
/// variant leg is the concatenation of its sub-pairs' resolved segment
/// lists. If any sub-pair fails to resolve (e.g. its track geometry is
/// absent from the extract — some are chord pairs even in the base
/// build), the variant falls back to the base pair's own resolution,
/// so an override can never make a leg less resolved than it was
/// without overrides. `stats` counts (variant-resolved, fallback).
#[allow(clippy::too_many_arguments)]
pub fn resolve_leg3(
    key: &(String, String, String),
    path_map: &PathMap,
    adj_pure: &CorridorAdj,
    adj: &CorridorAdj,
    pair_len: &HashMap<(String, String), f64>,
    station_pt: &dyn Fn(&str) -> Option<[f64; 2]>,
    cache: &mut PairCache,
    vcache: &mut VariantCache,
    stats: &mut (u64, u64),
) -> Option<Vec<Vec<i64>>> {
    if let Some((segs, _)) = leg_path(&key.2) {
        return Some(segs.clone());
    }
    if key.2.is_empty() {
        return resolve_leg(
            &(key.0.clone(), key.1.clone()),
            path_map,
            adj_pure,
            adj,
            pair_len,
            station_pt,
            cache,
        );
    }
    if let Some(v) = vcache.get(key) {
        return v.clone();
    }
    let stitched = (|| {
        let mut pts: Vec<&str> = vec![key.0.as_str()];
        pts.extend(key.2.split('>').filter(|s| !s.is_empty()));
        pts.push(key.1.as_str());
        let mut seqs: Vec<Vec<i64>> = Vec::new();
        for w in pts.windows(2) {
            let sub = (w[0].to_string(), w[1].to_string());
            let r = resolve_leg(&sub, path_map, adj_pure, adj, pair_len, station_pt, cache)?;
            seqs.extend(r);
        }
        Some(seqs)
    })();
    let result = match stitched {
        Some(s) => {
            stats.0 += 1;
            Some(s)
        }
        None => {
            stats.1 += 1;
            resolve_leg(
                &(key.0.clone(), key.1.clone()),
                path_map,
                adj_pure,
                adj,
                pair_len,
                station_pt,
                cache,
            )
        }
    };
    vcache.insert(key.clone(), result.clone());
    result
}

/// Geometry lookup for the section/chord passes: pair keys read the
/// pair cache, variant keys the variant cache (populated by the outbound
/// resolution loop and the inbound pass after it).
pub fn leg_seqs<'c>(
    key: &(String, String, String),
    cache: &'c PairCache,
    vcache: &'c VariantCache,
) -> Option<&'c Vec<Vec<i64>>> {
    if let Some((segs, _)) = leg_path(&key.2) {
        return Some(segs);
    }
    if key.2.is_empty() {
        cache
            .get(&(key.0.clone(), key.1.clone()))
            .and_then(|o| o.as_ref())
    } else {
        vcache.get(key).and_then(|o| o.as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn train(no: &str, code: &str) -> Train {
        Train {
            train_no: no.to_string(),
            code: code.to_string(),
            train_class: "G".to_string(),
            stops: Vec::new(),
        }
    }

    fn via(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    fn key(a: &str, b: &str, v: &str) -> (String, String, String) {
        (a.into(), b.into(), v.into())
    }

    #[test]
    fn leg_key3_orders_the_pair_and_has_no_via_by_default() {
        let m = OverrideMap::new();
        let t = train("N1", "G1");
        assert_eq!(leg_key3(&m, &t, "A", "B"), key("A", "B", ""));
        assert_eq!(leg_key3(&m, &t, "B", "A"), key("A", "B", ""));
    }

    #[test]
    fn leg_key3_reverses_the_via_chain_with_the_pair() {
        let mut m = OverrideMap::new();
        m.insert(("N1".into(), "B".into(), "A".into()), via(&["X", "Y"]));
        let t = train("N1", "G1");
        // stored for B->A; the key is in A->B direction, so the chain runs Y>X
        assert_eq!(leg_key3(&m, &t, "B", "A"), key("A", "B", "Y>X"));
        // not stored for A->B
        assert_eq!(leg_key3(&m, &t, "A", "B").2, "");
    }

    #[test]
    fn leg_key3_prefers_train_no_over_code() {
        let mut m = OverrideMap::new();
        m.insert(("G1".into(), "A".into(), "B".into()), via(&["C"]));
        m.insert(("N1".into(), "A".into(), "B".into()), via(&["D"]));
        assert_eq!(leg_key3(&m, &train("N1", "G1"), "A", "B").2, "D");
        // another physical train with the same code and no override of its own
        assert_eq!(leg_key3(&m, &train("N2", "G1"), "A", "B").2, "C");
        // no train_no at all: code only
        assert_eq!(leg_key3(&m, &train("", "G1"), "A", "B").2, "C");
    }
}
