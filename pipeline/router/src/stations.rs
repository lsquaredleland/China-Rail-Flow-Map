//! Station-matching seam: station name -> candidate points on the map.
//!
//! A name may own several points (a city's stations, or clusters of OSM
//! station nodes). The router picks, per pair, the two points that best
//! fit the pair (`pick_points`), and per intermediate stop the point best
//! placed between a pair's ends (`Stations::stop_point`). Snapping a
//! point to track nodes is the network's job (`graph::SnapIndex`).
//!
//! `china::load_stations` builds this from osm_stations.json, the
//! analyzer's station_resolution.json files and `--station-fixes`.
use crate::graph::hav;
use std::collections::HashMap;

/// The name key every source must use: whitespace removed.
pub fn normalize_name(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Station name -> candidate [lat, lon] points.
#[derive(Default)]
pub struct Stations {
    points: HashMap<String, Vec<[f64; 2]>>,
}

impl Stations {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set (replace) the points of `name` (normalised by the caller).
    pub fn insert(&mut self, name: String, pts: Vec<[f64; 2]>) {
        self.points.insert(name, pts);
    }

    pub fn get(&self, name: &str) -> Option<&Vec<[f64; 2]>> {
        self.points.get(name)
    }

    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// Every candidate point of every station (any order).
    pub fn all_points(&self) -> impl Iterator<Item = &[f64; 2]> {
        self.points.values().flatten()
    }

    /// The point of `name` best placed between `pa` and `pb`.
    pub fn stop_point(&self, name: &str, pa: [f64; 2], pb: [f64; 2]) -> Option<[f64; 2]> {
        self.points.get(name).and_then(|v| {
            v.iter()
                .copied()
                .min_by(|x, y| (hav(*x, pa) + hav(*x, pb)).total_cmp(&(hav(*y, pa) + hav(*y, pb))))
        })
    }
}

/// Single-linkage clusters of `pts` at `km`, as centroids, in a stable
/// order (as paths.rs does).
pub fn cluster(pts: &[[f64; 2]], km: f64) -> Vec<[f64; 2]> {
    let n = pts.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], mut x: usize) -> usize {
        while p[x] != x {
            p[x] = p[p[x]];
            x = p[x];
        }
        x
    }
    for i in 0..n {
        for j in i + 1..n {
            if hav(pts[i], pts[j]) <= km {
                let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                if a != b {
                    parent[a] = b;
                }
            }
        }
    }
    let mut groups: std::collections::BTreeMap<usize, Vec<[f64; 2]>> = Default::default();
    for (i, p) in pts.iter().enumerate() {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(*p);
    }
    groups
        .values()
        .map(|g| {
            let k = g.len() as f64;
            [
                g.iter().map(|p| p[0]).sum::<f64>() / k,
                g.iter().map(|p| p[1]).sum::<f64>() / k,
            ]
        })
        .collect()
}

/// The two stations' points for a pair: closest to the known chord when
/// there is one (else nearest), preferring points that snap to track.
pub fn pick_points(
    pts_a: &[[f64; 2]],
    pts_b: &[[f64; 2]],
    chord: Option<f64>,
    snaps: &dyn Fn([f64; 2]) -> bool,
) -> Option<([f64; 2], [f64; 2])> {
    let mut best: Option<(f64, [f64; 2], [f64; 2])> = None;
    let mut best_snap: Option<(f64, [f64; 2], [f64; 2])> = None;
    for &a in pts_a {
        for &b in pts_b {
            let err = match chord {
                Some(c) => (hav(a, b) - c).abs(),
                None => hav(a, b),
            };
            if best.is_none_or(|x| err < x.0) {
                best = Some((err, a, b));
            }
            if snaps(a) && snaps(b) && best_snap.is_none_or(|x| err < x.0) {
                best_snap = Some((err, a, b));
            }
        }
    }
    best_snap.or(best).map(|(_, a, b)| (a, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clusters_merge_within_radius() {
        let pts = [[30.0, 120.0], [30.01, 120.0], [31.0, 120.0]];
        let c = cluster(&pts, 3.0);
        assert_eq!(c.len(), 2);
        assert!(c.iter().any(|p| (p[0] - 30.005).abs() < 1e-9));
    }

    #[test]
    fn pick_points_prefers_snapping_pair_nearest_chord() {
        let a = [[30.0, 120.0]];
        let b = [[30.0, 121.0], [30.0, 120.5]];
        let chord = hav(a[0], b[0]);
        assert_eq!(
            pick_points(&a, &b, Some(chord), &|_| true),
            Some((a[0], b[0]))
        );
        let only_second = |p: [f64; 2]| p != b[0];
        assert_eq!(
            pick_points(&a, &b, Some(chord), &only_second),
            Some((a[0], b[1]))
        );
        assert_eq!(normalize_name(" 北京 南\t"), "北京南");
    }
}
