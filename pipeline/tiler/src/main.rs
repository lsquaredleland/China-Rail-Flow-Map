use osmpbf::{Element, ElementReader};
use pmtiles::{Compression, PmTilesWriter, TileCoord, TileType};
use rustc_hash::FxHashMap;
use std::fs::File;
use std::time::Instant;

const INPUT: &str = "data/osm/china-latest.osm.pbf";
const OUTPUT: &str = "data/osm/china-rail.pmtiles";
const MIN_ZOOM: u8 = 2;
const MAX_ZOOM: u8 = 9; // grid stops at 9: clients use 512px tiles (tileSize: 512), so map zoom 10+ is served from this grid
const EXTENT: f64 = 4096.0;
const EARTH_CIRC: f64 = 40_075_016.68;

// railway category -> mvt value string
const CATS: [&str; 10] = [
    "rail",
    "subway",
    "light_rail",
    "tram",
    "monorail",
    "narrow_gauge",
    "disused",
    "construction",
    "other",
    "miniature",
];

struct Way {
    cat: u8,
    name: Option<String>,
    refs: Vec<i64>,
}

fn rail_cat_and_name(
    tags: impl Iterator<Item = (impl AsRef<str>, impl AsRef<str>)>,
) -> Option<(u8, Option<String>)> {
    let mut rv: Option<String> = None;
    let mut name: Option<String> = None;
    let mut name_zh: Option<String> = None;
    for (k, v) in tags {
        match k.as_ref() {
            "railway" => rv = Some(v.as_ref().to_string()),
            "name" => {
                if name.is_none() {
                    name = Some(v.as_ref().to_string())
                }
            }
            "name:zh" if name_zh.is_none() => name_zh = Some(v.as_ref().to_string()),
            _ => {}
        }
    }
    let rv = rv?;
    let cat = match rv.as_str() {
        "rail" => 0,
        "subway" => 1,
        "light_rail" => 2,
        "tram" => 3,
        "monorail" => 4,
        "narrow_gauge" => 5,
        "miniature" => 9,
        "disused" | "abandoned" | "razed" | "dismantled" => 6,
        "construction" | "proposed" => 7,
        "platform" => return None, // station areas, not network lines
        _ => 8,
    };
    Some((cat, name.or(name_zh)))
}

// ---- WebMercator (meters) ----
fn project(lon: f64, lat: f64) -> (f64, f64) {
    let x = (lon + 180.0) / 360.0 * EARTH_CIRC;
    let s = (lat.to_radians().tan() + 1.0 / lat.to_radians().cos()).ln();
    let y = (1.0 - s / std::f64::consts::PI) / 2.0 * EARTH_CIRC;
    (x, y)
}

// ---- Ramer-Douglas-Peucker (iterative) ----
#[allow(clippy::needless_range_loop)]
fn rdp(points: &[(f64, f64)], tol: f64) -> Vec<(f64, f64)> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let tol2 = tol * tol;
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0usize, points.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        let (ax, ay) = points[a];
        let (bx, by) = points[b];
        let dx = bx - ax;
        let dy = by - ay;
        let len2 = dx * dx + dy * dy;
        let mut max_d2 = 0.0;
        let mut idx = 0;
        for i in (a + 1)..b {
            let (px, py) = points[i];
            let d2 = if len2 == 0.0 {
                (px - ax) * (px - ax) + (py - ay) * (py - ay)
            } else {
                let t = ((px - ax) * dx + (py - ay) * dy) / len2;
                let t = t.clamp(0.0, 1.0);
                let cx = ax + t * dx - px;
                let cy = ay + t * dy - py;
                cx * cx + cy * cy
            };
            if d2 > max_d2 {
                max_d2 = d2;
                idx = i;
            }
        }
        if max_d2 > tol2 {
            keep[idx] = true;
            stack.push((a, idx));
            stack.push((idx, b));
        }
    }
    points
        .iter()
        .zip(keep.iter())
        .filter(|(_, k)| **k)
        .map(|(p, _)| *p)
        .collect()
}

// ---- minimal protobuf writer ----
fn varint(buf: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        buf.push((v as u8) | 0x80);
        v >>= 7;
    }
    buf.push(v as u8);
}
fn tag(buf: &mut Vec<u8>, field: u32, wire: u32) {
    varint(buf, ((field << 3) | wire) as u64);
}
fn len_field(buf: &mut Vec<u8>, field: u32, payload: &[u8]) {
    tag(buf, field, 2);
    varint(buf, payload.len() as u64);
    buf.extend_from_slice(payload);
}
fn zigzag(n: i32) -> u32 {
    ((n << 1) ^ (n >> 31)) as u32
}

// geometry: single linestring -> packed command integers
fn encode_geom(pts: &[(i32, i32)]) -> Vec<u8> {
    let mut cmds: Vec<u32> = Vec::with_capacity(pts.len() * 2 + 1);
    cmds.push(9); // MoveTo, count 1
    let (mut cx, mut cy) = (0i32, 0i32);
    for (i, &(x, y)) in pts.iter().enumerate() {
        if i == 1 {
            cmds.push(((pts.len() - 1) as u32) << 3 | 2); // LineTo, count n-1
        }
        cmds.push(zigzag(x - cx));
        cmds.push(zigzag(y - cy));
        cx = x;
        cy = y;
    }
    let mut packed = Vec::new();
    for c in cmds {
        varint(&mut packed, c as u64);
    }
    let mut buf = Vec::new();
    tag(&mut buf, 4, 2); // geometry, packed
    varint(&mut buf, packed.len() as u64);
    buf.extend_from_slice(&packed);
    buf
}

fn encode_value_string(s: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    len_field(&mut buf, 1, s.as_bytes());
    buf
}

// Build one MVT tile from features: (cat, name, pts in tile coords)
/// One tile feature: (category, name, points in tile coordinates).
type Feature<'a> = (u8, Option<&'a str>, Vec<(i32, i32)>);

fn encode_tile(features: &[Feature<'_>]) -> Vec<u8> {
    let mut layer = Vec::new();
    tag(&mut layer, 15, 0);
    varint(&mut layer, 1); // version
    len_field(&mut layer, 1, b"rail");
    len_field(&mut layer, 3, b"railway"); // keys
    len_field(&mut layer, 3, b"name");

    let mut val_index: FxHashMap<String, u32> = FxHashMap::default();
    let mut values: Vec<Vec<u8>> = Vec::new();
    let mut value_idx = |s: &str| -> u32 {
        if let Some(&i) = val_index.get(s) {
            return i;
        }
        let i = values.len() as u32;
        values.push(encode_value_string(s));
        val_index.insert(s.to_string(), i);
        i
    };

    for (cat, name, pts) in features {
        let mut feat = Vec::new();
        tag(&mut feat, 2, 2); // tags, packed
        let mut tp = Vec::new();
        varint(&mut tp, 0); // key 0 = railway
        varint(&mut tp, value_idx(CATS[*cat as usize]) as u64);
        if let Some(nm) = name
            && !nm.is_empty()
        {
            varint(&mut tp, 1); // key 1 = name
            varint(&mut tp, value_idx(nm) as u64);
        }
        varint(&mut feat, tp.len() as u64);
        feat.extend_from_slice(&tp);
        tag(&mut feat, 3, 0);
        varint(&mut feat, 2); // LINESTRING
        feat.extend_from_slice(&encode_geom(pts));
        len_field(&mut layer, 2, &feat);
    }
    for v in &values {
        len_field(&mut layer, 4, v);
    }
    tag(&mut layer, 5, 0);
    varint(&mut layer, EXTENT as u64);

    let mut tile = Vec::new();
    len_field(&mut tile, 3, &layer);
    tile
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let t0 = Instant::now();

    // ---- pass A: railway ways ----
    let mut ways: Vec<Way> = Vec::new();
    let mut node_ids: Vec<i64> = Vec::new();
    let reader = ElementReader::from_path(INPUT)?;
    reader.for_each(|el| {
        if let Element::Way(w) = el
            && let Some((cat, name)) = rail_cat_and_name(w.tags())
        {
            node_ids.extend(w.refs());
            ways.push(Way {
                cat,
                name,
                refs: w.refs().collect(),
            });
        }
    })?;
    println!(
        "passA: {} railway ways, {} node refs ({:.1}s)",
        ways.len(),
        node_ids.len(),
        t0.elapsed().as_secs_f64()
    );

    node_ids.sort_unstable();
    node_ids.dedup();

    // ---- pass B: node coords (dense nodes arrive in id order -> already sorted) ----
    let t1 = Instant::now();
    let mut coords: Vec<(i64, f32, f32)> = Vec::with_capacity(node_ids.len());
    let reader = ElementReader::from_path(INPUT)?;
    reader.for_each(|el| match el {
        Element::DenseNode(n) => {
            if node_ids.binary_search(&n.id()).is_ok() {
                coords.push((n.id(), n.lat() as f32, n.lon() as f32));
            }
        }
        Element::Node(n) if node_ids.binary_search(&n.id()).is_ok() => {
            coords.push((n.id(), n.lat() as f32, n.lon() as f32));
        }
        _ => {}
    })?;
    drop(node_ids);
    println!(
        "passB: {} node coords ({:.1}s)",
        coords.len(),
        t1.elapsed().as_secs_f64()
    );

    let coord_of = |id: i64| -> Option<(f64, f64)> {
        coords
            .binary_search_by_key(&id, |(i, _, _)| *i)
            .ok()
            .map(|i| (coords[i].2 as f64, coords[i].1 as f64)) // (lon, lat)
    };

    // ---- PMTiles writer ----
    let t2 = Instant::now();
    let out = File::create(OUTPUT)?;
    let mut writer = PmTilesWriter::new(TileType::Mvt)
        .tile_compression(Compression::Gzip)
        .min_zoom(MIN_ZOOM)
        .max_zoom(MAX_ZOOM)
        .bounds(73.0, 18.0, 136.0, 54.0)
        .center_zoom(4)
        .center(104.0, 35.0)
        .metadata(r#"{"name":"China Rail Network","description":"Rail infrastructure extracted from OpenStreetMap"}"#)
        .create(std::io::BufWriter::new(out))?;

    let mut total_tiles = 0u64;
    for z in MIN_ZOOM..=MAX_ZOOM {
        let tz = Instant::now();
        let n = 1u32 << z;
        // Simplify one zoom finer than the grid: each tile covers 4x the area of a
        // 256px tile, so it carries the detail of the next zoom level. Clients
        // render with tileSize 512, getting z10-grade geometry from the z9 grid.
        let tol = EARTH_CIRC / (256.0 * (1u32 << (z + 1)) as f64) * 1.5; // ~1.5px in meters, one zoom finer
        let mut tile_feats: FxHashMap<(u32, u32), Vec<Feature>> = FxHashMap::default();

        for way in &ways {
            let mut pts: Vec<(f64, f64)> = Vec::with_capacity(way.refs.len());
            let mut ok = true;
            for r in &way.refs {
                match coord_of(*r) {
                    Some((lon, lat)) => pts.push(project(lon, lat)),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok || pts.len() < 2 {
                continue;
            }
            let simp = rdp(&pts, tol);
            if simp.len() < 2 {
                continue;
            }
            // Drop sub-visible ways: a feature shorter than ~2 display pixels
            // at this grid zoom is invisible, yet costs the same to fetch,
            // parse and draw as a visible one. Grid tiles render at 512px
            // (tileSize 512), so px = EARTH_CIRC / (512 * 2^z) meters.
            let mut len_m = 0.0;
            for w in simp.windows(2) {
                let dx = w[1].0 - w[0].0;
                let dy = w[1].1 - w[0].1;
                len_m += (dx * dx + dy * dy).sqrt();
            }
            if len_m < 2.0 * EARTH_CIRC / (512.0 * n as f64) {
                continue;
            }
            let (mut minx, mut maxx, mut miny, mut maxy) = (
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
            );
            for &(x, y) in &simp {
                let tx = x / EARTH_CIRC * n as f64;
                let ty = y / EARTH_CIRC * n as f64;
                minx = minx.min(tx);
                maxx = maxx.max(tx);
                miny = miny.min(ty);
                maxy = maxy.max(ty);
            }
            let clamp = |v: f64| (v.floor() as i64).max(0).min(n as i64 - 1) as u32;
            let (x0, x1, y0, y1) = (clamp(minx), clamp(maxx), clamp(miny), clamp(maxy));
            for ty in y0..=y1 {
                for tx in x0..=x1 {
                    let local: Vec<(i32, i32)> = simp
                        .iter()
                        .map(|&(x, y)| {
                            let gx = x / EARTH_CIRC * n as f64;
                            let gy = y / EARTH_CIRC * n as f64;
                            (
                                ((gx - tx as f64) * EXTENT).round() as i32,
                                ((gy - ty as f64) * EXTENT).round() as i32,
                            )
                        })
                        .collect();
                    tile_feats.entry((tx, ty)).or_default().push((
                        way.cat,
                        way.name.as_deref(),
                        local,
                    ));
                }
            }
        }

        let mut tile_list: Vec<(TileCoord, Vec<u8>)> = Vec::with_capacity(tile_feats.len());
        for ((tx, ty), feats) in &tile_feats {
            let mvt = encode_tile(feats);
            tile_list.push((TileCoord::new(z, *tx, *ty)?, mvt));
        }
        // sort by PMTiles tile id (Hilbert order) for better clustering
        tile_list.sort_by_key(|(c, _)| pmtiles::TileId::from(*c).value());
        let mut tiles_this_zoom = 0u64;
        for (coord, mvt) in &tile_list {
            writer.add_tile(*coord, mvt)?;
            tiles_this_zoom += 1;
        }
        total_tiles += tiles_this_zoom;
        println!(
            "zoom {}: {} tiles, tol {:.0}m ({:.1}s)",
            z,
            tiles_this_zoom,
            tol,
            tz.elapsed().as_secs_f64()
        );
    }
    writer.finalize()?;
    println!(
        "PMTiles done: {} tiles total, TOTAL {:.1}s",
        total_tiles,
        t0.elapsed().as_secs_f64()
    );
    let _ = t2;
    Ok(())
}
