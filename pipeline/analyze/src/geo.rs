//! Small planar-geometry and statistics helpers.

pub fn median(v: &[f64]) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = s.len();
    if n % 2 == 1 {
        s[n / 2]
    } else {
        (s[n / 2 - 1] + s[n / 2]) / 2.0
    }
}

pub fn hav_km_ll(p: [f64; 2], q: [f64; 2]) -> f64 {
    let dx = (p[0] - q[0]) * 96.0;
    let dy = (p[1] - q[1]) * 111.0;
    (dx * dx + dy * dy).sqrt()
}

pub fn round_pt(p: [f64; 2], dp: i32) -> [f64; 2] {
    let f = 10f64.powi(dp);
    [(p[0] * f).round() / f, (p[1] * f).round() / f]
}

#[allow(clippy::needless_range_loop)]
pub fn dp_keep(pts: &[[f64; 2]], tol: f64) -> Vec<[f64; 2]> {
    // Douglas-Peucker in raw degrees (tol ~ degrees). Endpoints always kept.
    let n = pts.len();
    if n <= 2 {
        return pts.to_vec();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack: Vec<(usize, usize)> = vec![(0, n - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (ax, ay) = (pts[a][0], pts[a][1]);
        let (bx, by) = (pts[b][0], pts[b][1]);
        let dx = bx - ax;
        let dy = by - ay;
        let len2 = dx * dx + dy * dy;
        let mut worst = 0.0f64;
        let mut worst_i = a;
        for i in (a + 1)..b {
            let (px, py) = (pts[i][0], pts[i][1]);
            let d = if len2 == 0.0 {
                ((px - ax).powi(2) + (py - ay).powi(2)).sqrt()
            } else {
                let t = (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0);
                let cx = ax + t * dx;
                let cy = ay + t * dy;
                ((px - cx).powi(2) + (py - cy).powi(2)).sqrt()
            };
            if d > worst {
                worst = d;
                worst_i = i;
            }
        }
        if worst > tol {
            keep[worst_i] = true;
            stack.push((a, worst_i));
            stack.push((worst_i, b));
        }
    }
    pts.iter()
        .zip(keep.iter())
        .filter(|(_, k)| **k)
        .map(|(p, _)| *p)
        .collect()
}
