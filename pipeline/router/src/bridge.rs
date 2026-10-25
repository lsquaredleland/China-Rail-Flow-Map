//! Smallest-gap bridging across unmapped track.
use crate::config::BridgeConfig;
use crate::graph::{self, hav, Graph, Snap};
use crate::legs::PairInfo;
use crate::model::Cand;
use std::collections::HashMap;

/// The bridge to draw among `(gap, total, a-node, b-node)` candidates: the
/// smallest gap, or any within 50 m of it; those compete on total length,
/// then node ids. Depends on the set only, never on its order.
pub fn pick_bridge(found: Vec<(f64, f64, u32, u32)>) -> Option<(u32, u32)> {
    let gmin = found.iter().map(|c| c.0).fold(f64::INFINITY, f64::min);
    found
        .into_iter()
        .filter(|c| c.0 <= gmin + 0.05)
        .min_by(|a, b| a.1.total_cmp(&b.1).then(a.2.cmp(&b.2)).then(a.3.cmp(&b.3)))
        .map(|c| (c.2, c.3))
}

/// Smallest-gap bridge between the two stations' track networks: the
/// connection must start at a dangling track end on one side, and the
/// bridged length must pass production's audits. Among plausible
/// connections the smallest gap wins; connections within 50 m of that gap
/// compete on total length, then on node ids, so the winner depends on the
/// candidate set only, never on iteration order.
pub fn min_gap_bridge(
    g: &Graph,
    p: &PairInfo,
    sa: &Snap,
    sb: &Snap,
    cfg: &BridgeConfig,
) -> Option<Cand> {
    let radius = (p.chord * 1.2 + 15.0).min(130.0);
    let ta = graph::reach(g, sa, radius);
    let tb = graph::reach(g, sb, radius);
    let grid_of = |t: &HashMap<u32, (f64, u32)>| {
        let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for &v in t.keys() {
            let c = g.coords[v as usize];
            grid.entry(((c[0] * 20.0) as i32, (c[1] * 20.0) as i32))
                .or_default()
                .push(v);
        }
        grid
    };
    let (ga, gb) = (grid_of(&ta), grid_of(&tb));
    let speed_ok = |total: f64| match p.min_minutes {
        Some(m) if m > 0.0 => total / (m / 60.0) <= cfg.max_kmh,
        _ => true,
    };
    // (gap, total, a-node, b-node) of every plausible connection
    let mut found: Vec<(f64, f64, u32, u32)> = Vec::new();
    let scan = |from: &HashMap<u32, (f64, u32)>,
                other: &HashMap<u32, (f64, u32)>,
                grid: &HashMap<(i32, i32), Vec<u32>>,
                a_side: bool,
                dangling_only: bool,
                found: &mut Vec<(f64, f64, u32, u32)>| {
        for (&u, &(du, _)) in from {
            if dangling_only && g.degree[u as usize] != 1 {
                continue;
            }
            if !dangling_only && du > 4.0 {
                continue;
            }
            let cu = g.coords[u as usize];
            let (cx, cy) = ((cu[0] * 20.0) as i32, (cu[1] * 20.0) as i32);
            for dx in -2..=2 {
                for dy in -2..=2 {
                    for &v in grid.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                        let gap = hav(cu, g.coords[v as usize]);
                        if gap > cfg.max_gap_km || gap < 0.001 {
                            continue;
                        }
                        let total = du + gap + other[&v].0;
                        let ratio = total / p.chord;
                        if ratio < cfg.ratio_min || ratio > cfg.ratio_max || !speed_ok(total) {
                            continue;
                        }
                        found.push(if a_side {
                            (gap, total, u, v)
                        } else {
                            (gap, total, v, u)
                        });
                    }
                }
            }
        }
    };
    scan(&ta, &tb, &gb, true, true, &mut found);
    scan(&tb, &ta, &ga, false, true, &mut found);
    if found.is_empty() {
        scan(&ta, &tb, &gb, true, false, &mut found);
        scan(&tb, &ta, &ga, false, false, &mut found);
    }
    let (u, v) = pick_bridge(found)?;
    let mut nodes = graph::reach_path(&ta, u);
    let mut tail = graph::reach_path(&tb, v);
    tail.reverse();
    nodes.extend(tail);
    Some(Cand::measure(g, nodes, "min-gap-bridge"))
}

#[cfg(test)]
mod tests {
    use super::pick_bridge;

    #[test]
    fn bridge_choice_ignores_candidate_order() {
        // gaps 0.010 / 0.040 / 0.045 are within 50 m of the smallest; 0.2 is not
        let c = vec![
            (0.040, 31.0, 7, 9),
            (0.010, 30.0, 5, 8),
            (0.045, 29.0, 4, 6),
            (0.200, 10.0, 1, 2),
            (0.045, 29.0, 3, 6),
        ];
        let want = Some((3, 6)); // shortest total in the 50 m band, then lowest node ids
        let mut rev = c.clone();
        rev.reverse();
        assert_eq!(pick_bridge(c), want);
        assert_eq!(pick_bridge(rev), want);
        assert_eq!(pick_bridge(Vec::new()), None);
    }
}
