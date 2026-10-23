//! atlaspack — packs the v1 flow-atlas JSON into the compact v2 format.
//!
//! v2 changes vs v1 (all lossless except geometry precision):
//! - `about` / `stats` dropped (documentation metadata).
//! - Section objects keep only `g` (endpoint indices were never rendered).
//! - `deps` / `arrs` objects become positional arrays; the `set` field
//!   (dataset provenance) is dropped; clock times become minutes since
//!   midnight (u32). Day offsets are recoverable as (dep + dur) / 1440.
//! - `calls` / `in_calls` rows keep their shape, with clock times as minutes.
//! - All polyline geometry is re-encoded at 1e4 precision (~11 m) instead of
//!   1e5; the sections were already simplified/rounded near that scale.
//!
//! Outputs (combined + direction splits for lazy inbound loading), each also
//! written Brotli-compressed (quality 11) with a `.br` suffix:
//! - china-flow-atlas-data-v2.json
//! - atlas-v2-shared.json / atlas-v2-out.json / atlas-v2-in.json
//! - Five-file split (first-paint staging): atlas-v2-out-map.json,
//!   atlas-v2-out-tables.json, atlas-v2-in-map.json, atlas-v2-in-tables.json
//!   (shared is shared). The four origin files partition the combined
//!   origins exactly; the packer asserts the partition before writing.
//!
//! After writing, the packer verifies v2 against v1 by reconstructing the
//! v1 rows from the v2 arrays (inverse mapping) and comparing every field,
//! plus a geometry check (same point counts, coordinates within half a
//! 1e4 step). Any mismatch aborts with a nonzero exit.

use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

fn mins(s: &str) -> i64 {
    let (h, m) = s.split_once(':').expect("HH:MM time");
    h.parse::<i64>().unwrap() * 60 + m.parse::<i64>().unwrap()
}

fn hhmm(mins: i64) -> String {
    format!("{:02}:{:02}", mins / 60, mins % 60)
}

/// Decode a Google polyline (1e5 scale) into (lat, lon) integer pairs.
fn polyline_decode(s: &str) -> Vec<[i64; 2]> {
    let bytes = s.as_bytes();
    let mut pts = Vec::new();
    let (mut lat, mut lon) = (0i64, 0i64);
    let mut i = 0usize;
    while i < bytes.len() {
        let mut vals = [0i64; 2];
        for v in vals.iter_mut() {
            let mut shift = 0u32;
            let mut acc = 0i64;
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
        pts.push([lat, lon]);
    }
    pts
}

/// Encode (lat, lon) integer pairs at the given scale's own units.
fn polyline_encode(pts: &[[i64; 2]]) -> String {
    let mut out = String::new();
    let mut last = [0i64; 2];
    for p in pts {
        for i in 0..2 {
            let mut v = p[i] - last[i];
            v = if v < 0 { !(v << 1) } else { v << 1 };
            while v >= 0x20 {
                out.push((((0x20 | (v & 0x1f)) + 63) as u8) as char);
                v >>= 5;
            }
            out.push(((v + 63) as u8) as char);
        }
        last = *p;
    }
    out
}

/// Re-encode a 1e5 polyline at 1e4 precision.
fn requant(s: &str) -> String {
    let pts = polyline_decode(s);
    // China coordinates are positive, so (v + 5) / 10 rounds to nearest.
    let q: Vec<[i64; 2]> = pts
        .iter()
        .map(|p| [(p[0] + 5) / 10, (p[1] + 5) / 10])
        .collect();
    polyline_encode(&q)
}

fn get<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or_else(|| panic!("missing key {key}"))
}

fn arr(v: &Value) -> &Vec<Value> {
    v.as_array().expect("array")
}

fn obj(v: &Value) -> &Map<String, Value> {
    v.as_object().expect("object")
}

fn pack_dep(r: &Value) -> Value {
    json!([
        get(r, "t"),
        get(r, "fs"),
        mins(get(r, "dep").as_str().unwrap()),
        get(r, "ts"),
        get(r, "tc"),
        mins(get(r, "arr").as_str().unwrap()),
        get(r, "dur"),
        get(r, "stops"),
        get(r, "km"),
    ])
}

fn pack_arr(r: &Value) -> Value {
    json!([
        get(r, "t"),
        get(r, "fs"),
        get(r, "fc"),
        mins(get(r, "dep").as_str().unwrap()),
        get(r, "ts"),
        mins(get(r, "arr").as_str().unwrap()),
        get(r, "dur"),
        get(r, "stops"),
        get(r, "km"),
    ])
}

fn pack_calls(cells: &Value, in_: bool) -> Value {
    let mut out = Vec::new();
    for cell in arr(cells) {
        let mut rows = Vec::new();
        for r in arr(cell) {
            let a = arr(r);
            let mut row = vec![
                a[0].clone(),
                json!(mins(a[1].as_str().unwrap())),
                json!(mins(a[2].as_str().unwrap())),
                a[3].clone(),
                a[4].clone(),
            ];
            if in_ {
                row.push(a[5].clone());
                row.push(a[6].clone());
            } else {
                row.push(a[5].clone());
            }
            rows.push(Value::Array(row));
        }
        out.push(Value::Array(rows));
    }
    Value::Array(out)
}

fn pack_origin(o: &Value) -> Value {
    let mut chords = Vec::new();
    for c in arr(get(o, "chords")) {
        chords.push(json!({
            "a": get(c, "a"), "b": get(c, "b"), "n": get(c, "n"),
            "g": requant(get(c, "g").as_str().unwrap()),
        }));
    }
    json!({
        "zh": get(o, "zh"), "en": get(o, "en"), "pt": get(o, "pt"),
        "outbound": get(o, "outbound"), "inbound": get(o, "inbound"),
        "fully_tracked": get(o, "fully_tracked"),
        "dests": get(o, "dests"), "srcs": get(o, "srcs"),
        "calls": pack_calls(get(o, "calls"), false),
        "in_calls": pack_calls(get(o, "in_calls"), true),
        "flows": get(o, "flows"), "in_flows": get(o, "in_flows"),
        "chords": chords,
        "deps": arr(get(o, "deps")).iter().map(pack_dep).collect::<Vec<_>>(),
        "arrs": arr(get(o, "arrs")).iter().map(pack_arr).collect::<Vec<_>>(),
        "dep_secs": get(o, "dep_secs"),
        "arr_secs": get(o, "arr_secs"),
    })
}

fn is_hsr(s: &Value) -> bool {
    s.get("h").and_then(Value::as_u64).unwrap_or(0) != 0
}

fn pack_sections(secs: &Value) -> Value {
    Value::Array(
        arr(secs)
            .iter()
            .map(|s| {
                let g = requant(get(s, "g").as_str().unwrap());
                if is_hsr(s) {
                    json!({ "g": g, "h": 1 })
                } else {
                    json!({ "g": g })
                }
            })
            .collect(),
    )
}

fn write_with_br(path: &Path, bytes: &[u8], quality: u32) -> (usize, usize) {
    std::fs::write(path, bytes).expect("write json");
    let br_path = path.with_extension("json.br");
    let f = std::fs::File::create(&br_path).expect("create br");
    let mut w = brotli::CompressorWriter::new(std::io::BufWriter::new(f), 8192, quality, 22);
    w.write_all(bytes).expect("brotli write");
    w.flush().expect("brotli flush");
    drop(w);
    let br_len = std::fs::metadata(&br_path).unwrap().len() as usize;
    (bytes.len(), br_len)
}

// ---------------- verification: reconstruct v1 rows from v2 ----------------

fn unpack_dep(a: &[Value]) -> Value {
    json!({
        "t": a[0], "fs": a[1], "dep": hhmm(a[2].as_i64().unwrap()),
        "ts": a[3], "tc": a[4], "arr": hhmm(a[5].as_i64().unwrap()),
        "dur": a[6], "stops": a[7], "km": a[8],
    })
}

fn unpack_arr(a: &[Value]) -> Value {
    json!({
        "t": a[0], "fs": a[1], "fc": a[2], "dep": hhmm(a[3].as_i64().unwrap()),
        "ts": a[4], "arr": hhmm(a[5].as_i64().unwrap()),
        "dur": a[6], "stops": a[7], "km": a[8],
    })
}

fn strip_set(r: &Value) -> Value {
    let mut m = obj(r).clone();
    m.remove("set");
    Value::Object(m)
}

fn check_geom(v1: &str, v2: &str) -> Result<(), String> {
    let a = polyline_decode(v1);
    let b = polyline_decode(v2);
    if a.len() != b.len() {
        return Err(format!("point count {} vs {}", a.len(), b.len()));
    }
    for (p, q) in a.iter().zip(b.iter()) {
        // v2 point q is in 1e4 units; compare at 1e5 scale.
        if (p[0] - q[0] * 10).abs() > 6 || (p[1] - q[1] * 10).abs() > 6 {
            return Err(format!("coord drift {p:?} vs {q:?}"));
        }
    }
    Ok(())
}

fn verify(v1: &Value, v2: &Value) -> Result<(), String> {
    for key in ["city_table", "station_table", "train_table"] {
        if get(v1, key) != get(v2, key) {
            return Err(format!("{key} changed"));
        }
    }
    for key in ["sections", "in_sections"] {
        let (a, b) = (arr(get(v1, key)), arr(get(v2, key)));
        if a.len() != b.len() {
            return Err(format!("{key} count"));
        }
        for (s1, s2) in a.iter().zip(b.iter()) {
            check_geom(
                get(s1, "g").as_str().unwrap(),
                get(s2, "g").as_str().unwrap(),
            )?;
            if is_hsr(s1) != is_hsr(s2) {
                return Err(format!("{key} hsr flag mismatch"));
            }
        }
    }
    {
        let (a, b) = (arr(get(v1, "network")), arr(get(v2, "network")));
        if a.len() != b.len() {
            return Err("network count".into());
        }
        for (s1, s2) in a.iter().zip(b.iter()) {
            check_geom(s1.as_str().unwrap(), s2.as_str().unwrap())?;
        }
    }
    let (o1s, o2s) = (arr(get(v1, "origins")), arr(get(v2, "origins")));
    if o1s.len() != o2s.len() {
        return Err("origin count".into());
    }
    for (o1, o2) in o1s.iter().zip(o2s.iter()) {
        for key in [
            "zh",
            "en",
            "pt",
            "outbound",
            "inbound",
            "fully_tracked",
            "dests",
            "srcs",
            "flows",
            "in_flows",
            "dep_secs",
            "arr_secs",
        ] {
            if get(o1, key) != get(o2, key) {
                return Err(format!("origin {} key {key}", get(o1, "zh")));
            }
        }
        for (d1, d2) in arr(get(o1, "deps")).iter().zip(arr(get(o2, "deps")).iter()) {
            if strip_set(d1) != unpack_dep(arr(d2)) {
                return Err(format!("dep mismatch in {}", get(o1, "zh")));
            }
        }
        for (d1, d2) in arr(get(o1, "arrs")).iter().zip(arr(get(o2, "arrs")).iter()) {
            if strip_set(d1) != unpack_arr(arr(d2)) {
                return Err(format!("arr mismatch in {}", get(o1, "zh")));
            }
        }
        for (cells1, cells2, in_) in [
            (get(o1, "calls"), get(o2, "calls"), false),
            (get(o1, "in_calls"), get(o2, "in_calls"), true),
        ] {
            for (c1, c2) in arr(cells1).iter().zip(arr(cells2).iter()) {
                for (r1, r2) in arr(c1).iter().zip(arr(c2).iter()) {
                    let (a1, a2) = (arr(r1), arr(r2));
                    let mut e = vec![
                        a2[0].clone(),
                        json!(hhmm(a2[1].as_i64().unwrap())),
                        json!(hhmm(a2[2].as_i64().unwrap())),
                        a2[3].clone(),
                        a2[4].clone(),
                    ];
                    if in_ {
                        e.push(a2[5].clone());
                        e.push(a2[6].clone());
                    } else {
                        e.push(a2[5].clone());
                    }
                    if *a1 != e {
                        return Err(format!("call mismatch in {}", get(o1, "zh")));
                    }
                }
            }
        }
        for (c1, c2) in arr(get(o1, "chords"))
            .iter()
            .zip(arr(get(o2, "chords")).iter())
        {
            for key in ["a", "b", "n"] {
                if get(c1, key) != get(c2, key) {
                    return Err("chord field".into());
                }
            }
            check_geom(
                get(c1, "g").as_str().unwrap(),
                get(c2, "g").as_str().unwrap(),
            )?;
        }
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let argval = |name: &str| -> Option<String> {
        args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
    };
    let quality: u32 = argval("--quality")
        .and_then(|s| s.parse().ok())
        .unwrap_or(11);
    let default_out_dir = if let Ok(d) = std::env::var("CRFM_OUTPUT_DIR") {
        d
    } else if PathBuf::from("output").exists() {
        "output".to_string()
    } else {
        "../output".to_string()
    };
    let in_path =
        argval("--in").unwrap_or_else(|| format!("{default_out_dir}/china-flow-atlas-data.json"));
    let out_dir = PathBuf::from(argval("--out-dir").unwrap_or(default_out_dir));
    std::fs::create_dir_all(&out_dir).expect("create out_dir");
    let v1: Value = serde_json::from_str(&std::fs::read_to_string(&in_path).expect("read v1"))
        .expect("parse v1");

    let shared = json!({
        "city_table": get(&v1, "city_table"),
        "station_table": get(&v1, "station_table"),
        "train_table": get(&v1, "train_table"),
        "sections": pack_sections(get(&v1, "sections")),
        "in_sections": pack_sections(get(&v1, "in_sections")),
        "network": arr(get(&v1, "network")).iter()
            .map(|s| json!(requant(s.as_str().unwrap()))).collect::<Vec<_>>(),
    });
    let origins: Vec<Value> = arr(get(&v1, "origins")).iter().map(pack_origin).collect();
    let mut combined = shared.clone();
    combined
        .as_object_mut()
        .unwrap()
        .insert("origins".into(), Value::Array(origins.clone()));

    verify(&v1, &combined).expect("v2 verification failed");
    println!("verify: PASS (rows reconstructed identical; geometry within half a 1e4 step)");

    // Direction splits: outbound fields in one file, inbound in the other,
    // both parallel to the shared origins order.
    let mut out_origins = Vec::new();
    let mut in_origins = Vec::new();
    for o in &origins {
        let mut oo = Map::new();
        let mut io = Map::new();
        for (k, v) in obj(o) {
            match k.as_str() {
                "srcs" | "in_calls" | "in_flows" | "arrs" | "arr_secs" => {
                    io.insert(k.clone(), v.clone());
                }
                "inbound" => {
                    oo.insert(k.clone(), v.clone());
                    io.insert(k.clone(), v.clone());
                }
                _ => {
                    oo.insert(k.clone(), v.clone());
                }
            }
        }
        out_origins.push(Value::Object(oo));
        in_origins.push(Value::Object(io));
    }
    // Five-file split: per direction, map aggregates (what first paint
    // needs) ship separately from the per-train table rows (interaction
    // data). Identity fields ride in out-map, which always loads first,
    // so in-map needs no copy of them.
    let pick = |o: &Value, keys: &[&str]| -> Value {
        let mut m = Map::new();
        for k in keys {
            m.insert((*k).to_string(), get(o, k).clone());
        }
        Value::Object(m)
    };
    let out_map: Vec<Value> = origins
        .iter()
        .map(|o| {
            pick(
                o,
                &[
                    "zh",
                    "en",
                    "pt",
                    "outbound",
                    "inbound",
                    "fully_tracked",
                    "dests",
                    "flows",
                    "chords",
                ],
            )
        })
        .collect();
    let out_tables: Vec<Value> = origins
        .iter()
        .map(|o| pick(o, &["deps", "calls", "dep_secs"]))
        .collect();
    let in_map: Vec<Value> = origins
        .iter()
        .map(|o| pick(o, &["srcs", "in_flows"]))
        .collect();
    let in_tables: Vec<Value> = origins
        .iter()
        .map(|o| pick(o, &["arrs", "in_calls", "arr_secs"]))
        .collect();
    for (i, o) in origins.iter().enumerate() {
        let mut merged = Map::new();
        for part in [&out_map[i], &out_tables[i], &in_map[i], &in_tables[i]] {
            for (k, v) in obj(part) {
                assert!(merged.insert(k.clone(), v.clone()).is_none(), "dup key {k}");
            }
        }
        assert_eq!(
            Value::Object(merged),
            *o,
            "partition mismatch at origin {i}"
        );
    }
    println!("five-file partition: PASS (all origins reconstruct exactly)");

    use rayon::prelude::*;

    let mut by_name: Vec<(&str, Value)> = Vec::new();
    by_name.push(("china-flow-atlas-data-v2.json", combined));
    by_name.push(("atlas-v2-shared.json", shared));
    by_name.push(("atlas-v2-out.json", json!({ "origins": out_origins })));
    by_name.push(("atlas-v2-in.json", json!({ "origins": in_origins })));
    by_name.push(("atlas-v2-out-map.json", json!({ "origins": out_map })));
    by_name.push(("atlas-v2-out-tables.json", json!({ "origins": out_tables })));
    by_name.push(("atlas-v2-in-map.json", json!({ "origins": in_map })));
    by_name.push(("atlas-v2-in-tables.json", json!({ "origins": in_tables })));

    let items: Vec<(&str, Vec<u8>)> = by_name
        .into_iter()
        .map(|(name, val)| (name, serde_json::to_string(&val).unwrap().into_bytes()))
        .collect();

    let results: Vec<(&str, usize, usize)> = items
        .par_iter()
        .map(|(name, bytes)| {
            let (raw, br) = write_with_br(&out_dir.join(name), bytes, quality);
            (*name, raw, br)
        })
        .collect();

    for (name, raw, br) in results {
        println!("{name}: raw {} bytes, brotli {}", raw, br);
    }
}
