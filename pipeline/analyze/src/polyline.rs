//! Google-style polyline codec (1e5 precision) for the v1 atlas JSON, plus the 1e4 decoder for v2 packs.

/// Google polyline encoding (1e5 precision); pts are [lon, lat].
pub fn polyline_encode(pts: &[[f64; 2]]) -> String {
    let mut out = String::new();
    let mut last = [0i64; 2];
    for p in pts {
        let cur = [(p[1] * 1e5).round() as i64, (p[0] * 1e5).round() as i64];
        for i in 0..2 {
            let mut v = cur[i] - last[i];
            v = if v < 0 { !(v << 1) } else { v << 1 };
            while v >= 0x20 {
                out.push((((0x20 | (v & 0x1f)) + 63) as u8) as char);
                v >>= 5;
            }
            out.push(((v + 63) as u8) as char);
        }
        last = cur;
    }
    out
}

/// Decode a v2-pack polyline (1e4 precision) into [lon, lat] degrees.
pub fn decode_poly4(s: &str) -> Vec<[f64; 2]> {
    let bytes = s.as_bytes();
    let (mut i, mut lat, mut lon) = (0usize, 0i64, 0i64);
    let mut pts = Vec::new();
    while i < bytes.len() {
        let mut vals = [0i64; 2];
        for v in vals.iter_mut() {
            let (mut shift, mut acc) = (0u32, 0i64);
            loop {
                let b = (bytes[i] - 63) as i64;
                i += 1;
                acc |= (b & 0x1f) << shift;
                shift += 5;
                if b < 0x20 {
                    break;
                }
            }
            *v = if acc & 1 != 0 { !(acc >> 1) } else { acc >> 1 };
        }
        lat += vals[0];
        lon += vals[1];
        pts.push([lon as f64 / 1e4, lat as f64 / 1e4]);
    }
    pts
}
