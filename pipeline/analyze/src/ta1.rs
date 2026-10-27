//! TA1, the typed-array sidecar for the per-train tables (THIN_CLIENT.md
//! §2.2): the same content as `atlas-v2-out-tables.json` /
//! `atlas-v2-in-tables.json`, as little-endian integer columns the client
//! reads with `new Int16Array(buf, offset, length)` (no parse, no per-row
//! objects in the heap).
//!
//! Bytes: `b"TA1\0"`, `u32` header length, the JSON header, zero padding to
//! a multiple of 8, then the body. The header is
//! `{fmt, pack, meta, columns: [{name, type, width, length, offset}]}`:
//! `type` is `i16` | `i32` | `u32`, `length` counts values (rows × `width`),
//! `offset` is the byte offset from the body start (each column 8-aligned).
//! Value columns take the narrowest of i16 / i32 that holds every value;
//! offset columns are u32.
//!
//! Columns (`<rows>` = `deps` / `arrs`, `<mark>` = `dep_off` / `arr_len`,
//! `<lists>` = `calls` / `in_calls`, all as in the JSON file):
//! - `path_off` (n_trains + 1) and `paths`: `paths[t]` is
//!   `paths[path_off[t]..path_off[t + 1]]`. Same for `stop_off` /
//!   `stop_pos` (out-tables only).
//! - `row_off` (n_origins + 1): origin `o`'s rows are `row_off[o]..row_off[o + 1]`.
//! - `<rows>` (width 9) and `<mark>` (width 1): one entry per row.
//! - `list_off` (n_origins + 1) into the lists, `call_off` (n_lists + 1)
//!   into the call rows, `<lists>` (width 6 out / 7 in): origin `o`'s
//!   `<lists>[i]` is list `list_off[o] + i`.
//!
//! `meta.chords` is the JSON `chords` verbatim (a handful of trains).
//! [`decode_tables`] rebuilds the JSON value exactly; `audit` checks it.

use serde_json::{json, Value};

const MAGIC: &[u8; 4] = b"TA1\0";

/// Per-direction keys of a tables file.
struct Keys {
    rows: &'static str,
    mark: &'static str,
    lists: &'static str,
    stop_pos: bool,
}

fn keys(pack: &str) -> Keys {
    match pack {
        "out-tables" => Keys {
            rows: "deps",
            mark: "dep_off",
            lists: "calls",
            stop_pos: true,
        },
        "in-tables" => Keys {
            rows: "arrs",
            mark: "arr_len",
            lists: "in_calls",
            stop_pos: false,
        },
        _ => panic!("ta1: unknown pack {pack}"),
    }
}

fn arr(v: &Value) -> &Vec<Value> {
    v.as_array().expect("ta1: expected an array")
}

fn int(v: &Value) -> i64 {
    v.as_i64().expect("ta1: expected an integer")
}

struct Col {
    name: String,
    ty: &'static str,
    width: usize,
    vals: Vec<i64>,
}

fn values(name: &str, width: usize, vals: Vec<i64>) -> Col {
    let fits = |lo: i64, hi: i64| vals.iter().all(|&v| v >= lo && v <= hi);
    let ty = if fits(i16::MIN as i64, i16::MAX as i64) {
        "i16"
    } else if fits(i32::MIN as i64, i32::MAX as i64) {
        "i32"
    } else {
        panic!("ta1: column {name} does not fit i32")
    };
    Col {
        name: name.into(),
        ty,
        width,
        vals,
    }
}

fn offsets(name: &str, vals: Vec<i64>) -> Col {
    assert!(vals.iter().all(|&v| (0..=u32::MAX as i64).contains(&v)));
    Col {
        name: name.into(),
        ty: "u32",
        width: 1,
        vals,
    }
}

/// Lists of equal-width rows, flattened; returns (offsets, values).
fn flatten<'a>(
    lists: impl Iterator<Item = &'a Value>,
    width: Option<usize>,
) -> (Vec<i64>, Vec<i64>) {
    let mut off = vec![0];
    let mut out = Vec::new();
    for l in lists {
        for x in arr(l) {
            match (width, x.as_array()) {
                (Some(w), Some(row)) => {
                    assert_eq!(row.len(), w, "ta1: row width");
                    out.extend(row.iter().map(int));
                }
                (None, None) => out.push(int(x)),
                _ => panic!("ta1: unexpected row shape"),
            }
        }
        off.push(out.len() as i64 / width.unwrap_or(1) as i64);
    }
    (off, out)
}

/// The row width of the first row anywhere in `lists` (rows of lists).
fn width_of<'a>(mut rows: impl Iterator<Item = &'a Value>) -> usize {
    rows.next().map_or(0, |r| arr(r).len())
}

/// Encode a tables JSON value (`pack` = "out-tables" | "in-tables").
pub fn encode_tables(v: &Value, pack: &str) -> Vec<u8> {
    let k = keys(pack);
    let origins = arr(&v["origins"]);
    let mut cols = Vec::new();
    let (po, pv) = flatten(arr(&v["paths"]).iter(), None);
    cols.push(offsets("path_off", po));
    cols.push(values("paths", 1, pv));
    if k.stop_pos {
        let (so, sv) = flatten(arr(&v["stop_pos"]).iter(), None);
        cols.push(offsets("stop_off", so));
        cols.push(values("stop_pos", 1, sv));
    }
    let rw = width_of(origins.iter().flat_map(|o| arr(&o[k.rows])));
    let (ro, rv) = flatten(origins.iter().map(|o| &o[k.rows]), Some(rw));
    let (_, mv) = flatten(origins.iter().map(|o| &o[k.mark]), None);
    assert_eq!(
        mv.len() as i64,
        *ro.last().unwrap(),
        "ta1: {} per row",
        k.mark
    );
    cols.push(offsets("row_off", ro));
    cols.push(values(k.rows, rw, rv));
    cols.push(values(k.mark, 1, mv));
    let mut lo = vec![0];
    for o in origins {
        lo.push(lo.last().unwrap() + arr(&o[k.lists]).len() as i64);
    }
    let all_lists: Vec<&Value> = origins.iter().flat_map(|o| arr(&o[k.lists])).collect();
    let cw = width_of(all_lists.iter().flat_map(|l| arr(l)));
    let (co, cv) = flatten(all_lists.into_iter(), Some(cw));
    cols.push(offsets("list_off", lo));
    cols.push(offsets("call_off", co));
    cols.push(values(k.lists, cw, cv));

    let mut body = Vec::new();
    let mut heads = Vec::new();
    for c in &cols {
        while body.len() % 8 != 0 {
            body.push(0);
        }
        heads.push(json!({
            "name": c.name, "type": c.ty, "width": c.width,
            "length": c.vals.len(), "offset": body.len(),
        }));
        for &x in &c.vals {
            match c.ty {
                "i16" => body.extend((x as i16).to_le_bytes()),
                "i32" => body.extend((x as i32).to_le_bytes()),
                _ => body.extend((x as u32).to_le_bytes()),
            }
        }
    }
    let header = json!({
        "fmt": v["fmt"], "pack": pack,
        "meta": { "chords": v["chords"] },
        "columns": heads,
    });
    let h = serde_json::to_vec(&header).unwrap();
    let mut out = Vec::with_capacity(16 + h.len() + body.len());
    out.extend(MAGIC);
    out.extend((h.len() as u32).to_le_bytes());
    out.extend(&h);
    while out.len() % 8 != 0 {
        out.push(0);
    }
    out.extend(body);
    out
}

/// A decoded TA1 file: its header and columns widened to i64.
pub struct Ta1 {
    pub header: Value,
    cols: Vec<(String, usize, Vec<i64>)>,
}

impl Ta1 {
    pub fn col(&self, name: &str) -> (usize, &[i64]) {
        let (_, w, v) = self
            .cols
            .iter()
            .find(|c| c.0 == name)
            .unwrap_or_else(|| panic!("ta1: no column {name}"));
        (*w, v)
    }
}

pub fn read(bytes: &[u8]) -> Result<Ta1, String> {
    if bytes.len() < 8 || &bytes[..4] != MAGIC {
        return Err("not a TA1 file".into());
    }
    let hl = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let header: Value = serde_json::from_slice(bytes.get(8..8 + hl).ok_or("truncated header")?)
        .map_err(|e| e.to_string())?;
    let body = (8 + hl).div_ceil(8) * 8;
    let mut cols = Vec::new();
    for c in header["columns"].as_array().ok_or("no columns")? {
        let (ty, n, at) = (
            c["type"].as_str().unwrap_or(""),
            c["length"].as_u64().unwrap_or(0) as usize,
            body + c["offset"].as_u64().unwrap_or(0) as usize,
        );
        let size = match ty {
            "i16" => 2,
            "i32" | "u32" => 4,
            _ => return Err(format!("bad column type {ty}")),
        };
        let raw = bytes.get(at..at + n * size).ok_or("truncated column")?;
        let vals = raw
            .chunks_exact(size)
            .map(|b| match ty {
                "i16" => i16::from_le_bytes([b[0], b[1]]) as i64,
                "i32" => i32::from_le_bytes(b.try_into().unwrap()) as i64,
                _ => u32::from_le_bytes(b.try_into().unwrap()) as i64,
            })
            .collect();
        let name = c["name"].as_str().unwrap_or("").to_string();
        cols.push((name, c["width"].as_u64().unwrap_or(1) as usize, vals));
    }
    Ok(Ta1 { header, cols })
}

/// Rebuild the tables JSON value a TA1 file was encoded from.
pub fn decode_tables(bytes: &[u8]) -> Result<Value, String> {
    let t = read(bytes)?;
    let pack = t.header["pack"].as_str().ok_or("no pack")?.to_string();
    let k = keys(&pack);
    let lists_of = |off: &[i64], w: usize, v: &[i64]| -> Vec<Value> {
        off.windows(2)
            .map(|r| {
                let s = &v[r[0] as usize * w..r[1] as usize * w];
                if w == 1 {
                    json!(s)
                } else {
                    Value::Array(s.chunks(w).map(|row| json!(row)).collect())
                }
            })
            .collect()
    };
    let (_, po) = t.col("path_off");
    let (_, pv) = t.col("paths");
    let (_, ro) = t.col("row_off");
    let (rw, rv) = t.col(k.rows);
    let (_, mv) = t.col(k.mark);
    let (_, lo) = t.col("list_off");
    let (_, co) = t.col("call_off");
    let (cw, cv) = t.col(k.lists);
    let rows = lists_of(ro, rw, rv);
    let marks = lists_of(ro, 1, mv);
    let lists = lists_of(co, cw, cv);
    let origins: Vec<Value> = (0..ro.len() - 1)
        .map(|o| {
            let ls = &lists[lo[o] as usize..lo[o + 1] as usize];
            json!({ k.rows: rows[o], k.lists: ls, k.mark: marks[o] })
        })
        .collect();
    let mut out = json!({ "fmt": t.header["fmt"], "paths": lists_of(po, 1, pv) });
    if k.stop_pos {
        let (_, so) = t.col("stop_off");
        let (_, sv) = t.col("stop_pos");
        out["stop_pos"] = Value::Array(lists_of(so, 1, sv));
    }
    out["chords"] = t.header["meta"]["chords"].clone();
    out["origins"] = Value::Array(origins);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out_tables() -> Value {
        json!({
            "fmt": 6,
            "paths": [[3, -4, 20053], [], [1]],
            "stop_pos": [[1, 3], [], [1]],
            "chords": [[0, [[1, 1, 2]]]],
            "origins": [
                { "deps": [[0, 1, 2, 3, 4, 5, 6, 2, -1], [2, 1, 2, 3, 4, 5, 6, 1, 99999]],
                  "calls": [[[0, 1, 2, 0, 1, 3]], [], [[1, 5, 6, 0, 0, 1], [0, 7, 8, 1, 1, 2]]],
                  "dep_off": [1, 0] },
                { "deps": [], "calls": [], "dep_off": [] }
            ]
        })
    }

    #[test]
    fn out_tables_round_trip() {
        let v = out_tables();
        let b = encode_tables(&v, "out-tables");
        assert_eq!(&b[..4], MAGIC);
        assert_eq!(decode_tables(&b).unwrap(), v);
        let t = read(&b).unwrap();
        // 99999 does not fit i16: the rows column widens, paths stay i16.
        let ty = |n: &str| {
            t.header["columns"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["name"] == n)
                .unwrap()["type"]
                .clone()
        };
        assert_eq!(ty("deps"), "i32");
        assert_eq!(ty("paths"), "i16");
        for c in t.header["columns"].as_array().unwrap() {
            assert_eq!(c["offset"].as_u64().unwrap() % 8, 0);
        }
    }

    #[test]
    fn in_tables_round_trip() {
        let v = json!({
            "fmt": 6, "paths": [[5, 6], [7]], "chords": [],
            "origins": [{ "arrs": [[1, 0, 0, 0, 0, 0, 0, 0, 0]], "in_calls": [[[0, 1, 2, 0, 1, 3, 4]]], "arr_len": [1] }]
        });
        let b = encode_tables(&v, "in-tables");
        assert_eq!(decode_tables(&b).unwrap(), v);
    }

    #[test]
    fn rejects_other_bytes() {
        assert!(read(b"{\"fmt\":6}").is_err());
    }
}
