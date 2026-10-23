use flate2::read::GzDecoder;
use pmtiles::{TileCoord, TileId};
use std::collections::BTreeMap;
use std::io::Read;

fn read_varint(buf: &[u8], pos: &mut usize) -> u64 {
    let mut result: u64 = 0;
    let mut shift = 0;
    loop {
        let b = buf[*pos];
        *pos += 1;
        result |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    result
}

struct Stats {
    // z -> (count, total_bytes, max_bytes, max_tile_id)
    per_zoom: BTreeMap<u8, (u64, u64, u32, u64)>,
    total_tiles: u64,
    total_bytes: u64,
}

fn walk(data: &[u8], dir_offset: usize, dir_len: usize, stats: &mut Stats) {
    let end = dir_offset + dir_len;
    let mut dec = GzDecoder::new(&data[dir_offset..end]);
    let mut raw = Vec::new();
    dec.read_to_end(&mut raw).unwrap();
    let mut pos = 0;
    let n = read_varint(&raw, &mut pos) as usize;
    let mut tile_ids = Vec::with_capacity(n);
    let mut next_id: u64 = 0;
    for _ in 0..n {
        next_id += read_varint(&raw, &mut pos);
        tile_ids.push(next_id);
    }
    let mut run_lengths = Vec::with_capacity(n);
    for _ in 0..n {
        run_lengths.push(read_varint(&raw, &mut pos) as u32);
    }
    let mut lengths = Vec::with_capacity(n);
    for _ in 0..n {
        lengths.push(read_varint(&raw, &mut pos) as u32);
    }
    let mut offsets = Vec::with_capacity(n);
    let mut last_off: u64 = 0;
    let mut last_len: u64 = 0;
    for len in &lengths {
        let o = read_varint(&raw, &mut pos);
        let abs = if o == 0 { last_off + last_len } else { o - 1 };
        offsets.push(abs);
        last_off = abs;
        last_len = *len as u64;
    }
    for i in 0..n {
        if run_lengths[i] == 0 {
            // leaf directory
            walk(data, offsets[i] as usize, lengths[i] as usize, stats);
        } else {
            for k in 0..run_lengths[i] {
                let tid = tile_ids[i] + k as u64;
                let len = lengths[i] as u64;
                if len == 0 {
                    continue;
                }
                let t: TileCoord = TileId::new(tid).unwrap().into();
                let z = t.z();
                let e = stats.per_zoom.entry(z).or_insert((0, 0, 0, 0));
                e.0 += 1;
                e.1 += len;
                if lengths[i] > e.2 {
                    e.2 = lengths[i];
                    e.3 = tid;
                }
                stats.total_tiles += 1;
                stats.total_bytes += len;
            }
        }
    }
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: stats <file.pmtiles>");
    let data = std::fs::read(&path).unwrap();
    assert_eq!(&data[0..7], b"PMTiles");
    assert_eq!(data[7], 3);
    let root_off = u64::from_le_bytes(data[8..16].try_into().unwrap()) as usize;
    let root_len = u64::from_le_bytes(data[16..24].try_into().unwrap()) as usize;
    let mut stats = Stats {
        per_zoom: BTreeMap::new(),
        total_tiles: 0,
        total_bytes: 0,
    };
    walk(&data, root_off, root_len, &mut stats);
    println!(
        "total tiles: {}, total tile bytes: {:.1} MB",
        stats.total_tiles,
        stats.total_bytes as f64 / 1e6
    );
    println!(
        "{:>4} {:>8} {:>12} {:>12}  largest tile",
        "z", "tiles", "total MB", "avg KB"
    );
    let mut largest: Vec<(u32, u8, u64)> = Vec::new();
    for (z, (count, bytes, max_b, max_tid)) in &stats.per_zoom {
        let t: TileCoord = TileId::new(*max_tid).unwrap().into();
        println!(
            "{:>4} {:>8} {:>12.2} {:>12.1}  z{}/{}/{} {} KB",
            z,
            count,
            *bytes as f64 / 1e6,
            *bytes as f64 / *count as f64 / 1e3,
            t.z(),
            t.x(),
            t.y(),
            *max_b as f64 / 1e3
        );
        largest.push((*max_b, *z, *max_tid));
    }
    largest.sort_by_key(|a| std::cmp::Reverse(a.0));
    println!("top 8 largest tiles:");
    for (b, z, tid) in largest.iter().take(8) {
        let t: TileCoord = TileId::new(*tid).unwrap().into();
        println!("  z{}/{}/{}: {:.0} KB", z, t.x(), t.y(), *b as f64 / 1e3);
    }
}
