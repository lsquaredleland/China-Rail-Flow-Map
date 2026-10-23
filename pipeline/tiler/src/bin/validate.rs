use pmtiles::{AsyncPmTilesReader, NoCache, TileCoord};
use std::io::Read;

// quick validation: read a tile over Shanghai at z10, gunzip, parse MVT minimally
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let reader =
        AsyncPmTilesReader::new_with_cached_path(NoCache, "data/osm/china-rail.pmtiles").await?;
    let header = reader.get_header();
    println!(
        "header: minzoom={} maxzoom={} center=({},{}) bounds={:?}",
        header.min_zoom,
        header.max_zoom,
        header.center_longitude,
        header.center_latitude,
        (
            header.min_longitude,
            header.min_latitude,
            header.max_longitude,
            header.max_latitude
        )
    );

    // Shanghai: lon 121.47, lat 31.23
    let z = 10u8;
    let n = 1u32 << z;
    let x = ((121.47 + 180.0) / 360.0 * n as f64).floor() as u32;
    let s = (31.23f64.to_radians().tan() + 1.0 / 31.23f64.to_radians().cos()).ln();
    let y = ((1.0 - s / std::f64::consts::PI) / 2.0 * n as f64).floor() as u32;
    println!("Shanghai tile z{x}/{y}");

    let coord = TileCoord::new(z, x, y)?;
    let tile = reader.get_tile(coord).await?;
    match tile {
        Some(gz) => {
            let mut dec = flate2::read::GzDecoder::new(&gz[..]);
            let mut mvt = Vec::new();
            dec.read_to_end(&mut mvt)?;
            println!("tile bytes: gz={} raw={}", gz.len(), mvt.len());
            println!("first 24 bytes: {:02x?}", &mvt[..24.min(mvt.len())]);
            // walk top-level fields
            let mut i = 0;
            let mut nfields = 0;
            while i < mvt.len() && nfields < 8 {
                let (t, ni) = read_varint(&mvt, i);
                i = ni;
                let f = (t >> 3) as u32;
                let w = (t & 7) as u32;
                if w == 2 {
                    let (len, ni2) = read_varint(&mvt, i);
                    i = ni2;
                    println!("  top field={} wire=2 len={}", f, len);
                    i += len as usize;
                } else {
                    let (v, ni2) = read_varint(&mvt, i);
                    i = ni2;
                    println!("  top field={} wire={} val={}", f, w, v);
                }
                nfields += 1;
            }
            // minimal parse: count features (field 2 in layer) and check extent
            let feats = count_field(&mvt, 3, 2); // tile->layer(3), layer->feature(2)
            println!("features in tile: {}", feats);
            // check geometry command sanity: find first feature geometry
            if feats == 0 {
                println!("WARN: no features in Shanghai tile!");
            }
        }
        None => println!("WARN: no tile at Shanghai z10"),
    }
    // also check a z2 tile exists
    let c2 = TileCoord::new(2, 2, 2)?;
    let t2 = reader.get_tile(c2).await?;
    println!("z2 tile (2,2) present: {}", t2.is_some());
    Ok(())
}

// count occurrences of `field` inside submessage `parent_field` (top-level scan)
fn count_field(buf: &[u8], parent_field: u32, field: u32) -> usize {
    // find all top-level fields == parent_field, then count field inside each
    let mut count = 0;
    let mut i = 0;
    while i < buf.len() {
        let (tag, ni) = read_varint(buf, i);
        i = ni;
        let f = (tag >> 3) as u32;
        let w = (tag & 7) as u32;
        if w == 2 {
            let (len, ni2) = read_varint(buf, i);
            i = ni2;
            if f == parent_field {
                count += count_top_level(&buf[i..i + len as usize], field);
            }
            i += len as usize;
        } else if w == 0 {
            let (_, ni2) = read_varint(buf, i);
            i = ni2;
        } else {
            break;
        }
    }
    count
}

fn count_top_level(buf: &[u8], field: u32) -> usize {
    let mut count = 0;
    let mut i = 0;
    while i < buf.len() {
        let (tag, ni) = read_varint(buf, i);
        i = ni;
        let f = (tag >> 3) as u32;
        let w = (tag & 7) as u32;
        if f == field {
            count += 1;
        }
        if w == 2 {
            let (len, ni2) = read_varint(buf, i);
            i = ni2 + len as usize;
        } else if w == 0 {
            let (_, ni2) = read_varint(buf, i);
            i = ni2;
        } else {
            break;
        }
    }
    count
}

fn read_varint(buf: &[u8], mut i: usize) -> (u64, usize) {
    let mut v = 0u64;
    let mut s = 0;
    loop {
        let b = buf[i];
        i += 1;
        v |= ((b & 0x7f) as u64) << s;
        s += 7;
        if b & 0x80 == 0 {
            break;
        }
    }
    (v, i)
}
