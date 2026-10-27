//! The per-train tables as integer columns in a safetensors file
//! (https://huggingface.co/docs/safetensors): the same content as
//! `atlas-v2-out-tables.json` / `atlas-v2-in-tables.json`, laid out so the
//! client reads each column with `new Int16Array(buf, offset, length)` (no
//! parse, no per-row objects in the heap). Column meanings, with a worked
//! example: `docs/PACK_FORMAT.md`.
//!
//! safetensors: a `u64` header length, the JSON header, then the tensors
//! back to back (no gaps). The header maps each tensor name to
//! `{dtype, shape, data_offsets: [begin, end]}` (byte offsets from the end
//! of the header) plus `__metadata__` (string values only). Written here by
//! hand, not with the `safetensors` crate, so the bytes are deterministic
//! (key order, padding); the tests read our files with that crate.
//!
//! Alignment: the header is padded with spaces to a multiple of 8, and the
//! 4-byte tensors come before the 2-byte ones, so every tensor starts at a
//! multiple of its element size and the client's typed views are valid.
//! Value tensors take the narrowest of I16 / I32 that holds them; offset
//! tensors are U32. Shape is `[n]`, or `[rows, width]` for row tables.

use serde_json::{json, Map, Value};

/// What `__metadata__.format` names: this layout, so a reader can refuse others.
pub const FORMAT: &str = "crfm-tables-1";

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
        _ => panic!("columns: unknown pack {pack}"),
    }
}

fn arr(v: &Value) -> &Vec<Value> {
    v.as_array().expect("columns: expected an array")
}

fn int(v: &Value) -> i64 {
    v.as_i64().expect("columns: expected an integer")
}

struct Col {
    name: String,
    dtype: &'static str,
    width: usize,
    vals: Vec<i64>,
}

fn values(name: &str, width: usize, vals: Vec<i64>) -> Col {
    let fits = |lo: i64, hi: i64| vals.iter().all(|&v| v >= lo && v <= hi);
    let dtype = if fits(i16::MIN as i64, i16::MAX as i64) {
        "I16"
    } else if fits(i32::MIN as i64, i32::MAX as i64) {
        "I32"
    } else {
        panic!("columns: {name} does not fit i32")
    };
    Col {
        name: name.into(),
        dtype,
        width,
        vals,
    }
}

fn offsets(name: &str, vals: Vec<i64>) -> Col {
    assert!(vals.iter().all(|&v| (0..=u32::MAX as i64).contains(&v)));
    Col {
        name: name.into(),
        dtype: "U32",
        width: 1,
        vals,
    }
}

fn size(dtype: &str) -> usize {
    if dtype == "I16" {
        2
    } else {
        4
    }
}

/// Lists of equal-width rows (or of plain integers when `width` is None),
/// flattened; returns (offsets in rows, values).
fn flatten<'a>(
    lists: impl Iterator<Item = &'a Value>,
    width: Option<usize>,
) -> (Vec<i64>, Vec<i64>) {
    let w = width.unwrap_or(1);
    let mut off = vec![0];
    let mut out = Vec::new();
    for l in lists {
        for x in arr(l) {
            match (width, x.as_array()) {
                (Some(w), Some(row)) => {
                    assert_eq!(row.len(), w, "columns: row width");
                    out.extend(row.iter().map(int));
                }
                (None, None) => out.push(int(x)),
                _ => panic!("columns: unexpected row shape"),
            }
        }
        off.push((out.len() / w) as i64);
    }
    (off, out)
}

/// The width of the first row (1 when there are none).
fn width_of<'a>(mut rows: impl Iterator<Item = &'a Value>) -> usize {
    rows.next().map_or(1, |r| arr(r).len().max(1))
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
    // chords: [[t, [[stop, s0, s1], ...]], ...]
    let chords = arr(&v["chords"]);
    cols.push(values(
        "chord_train",
        1,
        chords.iter().map(|c| int(&c[0])).collect(),
    ));
    let (cho, chv) = flatten(chords.iter().map(|c| &c[1]), Some(3));
    cols.push(offsets("chord_off", cho));
    cols.push(values("chord_legs", 3, chv));
    let rw = width_of(origins.iter().flat_map(|o| arr(&o[k.rows])));
    let (ro, rv) = flatten(origins.iter().map(|o| &o[k.rows]), Some(rw));
    let (_, mv) = flatten(origins.iter().map(|o| &o[k.mark]), None);
    assert_eq!(
        mv.len() as i64,
        *ro.last().unwrap(),
        "columns: {} per row",
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

    // 4-byte tensors first (stable within each size), so all stay aligned.
    cols.sort_by_key(|c| std::cmp::Reverse(size(c.dtype)));
    let mut header = Map::new();
    header.insert(
        "__metadata__".into(),
        json!({
            "format": FORMAT,
            "pack": pack,
            "fmt": v["fmt"].to_string(),
            "doc": "docs/PACK_FORMAT.md",
        }),
    );
    let mut body = Vec::new();
    for c in &cols {
        let begin = body.len();
        for &x in &c.vals {
            match c.dtype {
                "I16" => body.extend((x as i16).to_le_bytes()),
                "I32" => body.extend((x as i32).to_le_bytes()),
                _ => body.extend((x as u32).to_le_bytes()),
            }
        }
        let shape = if c.width == 1 {
            json!([c.vals.len()])
        } else {
            json!([c.vals.len() / c.width, c.width])
        };
        header.insert(
            c.name.clone(),
            json!({ "dtype": c.dtype, "shape": shape, "data_offsets": [begin, body.len()] }),
        );
    }
    let mut h = serde_json::to_vec(&Value::Object(header)).unwrap();
    while !(8 + h.len()).is_multiple_of(8) {
        h.push(b' ');
    }
    let mut out = Vec::with_capacity(8 + h.len() + body.len());
    out.extend((h.len() as u64).to_le_bytes());
    out.extend(&h);
    out.extend(body);
    out
}

/// A decoded file: its metadata and tensors widened to i64 (with width).
pub struct Columns {
    pub metadata: Value,
    cols: Vec<(String, usize, Vec<i64>)>,
}

impl Columns {
    pub fn col(&self, name: &str) -> (usize, &[i64]) {
        let (_, w, v) = self
            .cols
            .iter()
            .find(|c| c.0 == name)
            .unwrap_or_else(|| panic!("columns: no tensor {name}"));
        (*w, v)
    }
}

pub fn read(bytes: &[u8]) -> Result<Columns, String> {
    let hl = u64::from_le_bytes(bytes.get(..8).ok_or("too short")?.try_into().unwrap()) as usize;
    let header: Value = serde_json::from_slice(bytes.get(8..8 + hl).ok_or("truncated header")?)
        .map_err(|e| e.to_string())?;
    let body = 8 + hl;
    let mut cols = Vec::new();
    for (name, t) in header.as_object().ok_or("header is not an object")? {
        if name == "__metadata__" {
            continue;
        }
        let dtype = t["dtype"].as_str().unwrap_or("");
        let sz = match dtype {
            "I16" => 2,
            "I32" | "U32" => 4,
            _ => return Err(format!("{name}: unsupported dtype {dtype}")),
        };
        let o = t["data_offsets"].as_array().ok_or("no data_offsets")?;
        let (b, e) = (
            body + o[0].as_u64().unwrap_or(0) as usize,
            body + o[1].as_u64().unwrap_or(0) as usize,
        );
        let raw = bytes.get(b..e).ok_or("truncated tensor")?;
        let vals = raw
            .chunks_exact(sz)
            .map(|x| match dtype {
                "I16" => i16::from_le_bytes([x[0], x[1]]) as i64,
                "I32" => i32::from_le_bytes(x.try_into().unwrap()) as i64,
                _ => u32::from_le_bytes(x.try_into().unwrap()) as i64,
            })
            .collect();
        let width = t["shape"].get(1).and_then(Value::as_u64).unwrap_or(1) as usize;
        cols.push((name.clone(), width, vals));
    }
    let metadata = header["__metadata__"].clone();
    if metadata["format"] != FORMAT {
        return Err(format!("not a {FORMAT} file"));
    }
    Ok(Columns { metadata, cols })
}

/// Rebuild the tables JSON value a file was encoded from.
pub fn decode_tables(bytes: &[u8]) -> Result<Value, String> {
    let t = read(bytes)?;
    let pack = t.metadata["pack"].as_str().ok_or("no pack")?.to_string();
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
    let fmt: i64 = t.metadata["fmt"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or("no fmt")?;
    let mut out = json!({ "fmt": fmt, "paths": lists_of(po, 1, pv) });
    if k.stop_pos {
        let (_, so) = t.col("stop_off");
        let (_, sv) = t.col("stop_pos");
        out["stop_pos"] = Value::Array(lists_of(so, 1, sv));
    }
    let (_, ct) = t.col("chord_train");
    let (_, cho) = t.col("chord_off");
    let (_, chv) = t.col("chord_legs");
    let legs = lists_of(cho, 3, chv);
    out["chords"] = Value::Array(ct.iter().zip(legs).map(|(t, l)| json!([t, l])).collect());
    out["origins"] = Value::Array(origins);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use safetensors::SafeTensors;

    fn out_tables() -> Value {
        json!({
            "fmt": 6,
            "paths": [[3, -4, 20053], [], [1]],
            "stop_pos": [[1, 3], [], [1]],
            "chords": [[0, [[1, 1, 2]]], [2, [[0, 0, 0], [3, 1, 1]]]],
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
        assert_eq!(decode_tables(&encode_tables(&v, "out-tables")).unwrap(), v);
    }

    #[test]
    fn in_tables_round_trip() {
        let v = json!({
            "fmt": 6, "paths": [[5, 6], [7]], "chords": [],
            "origins": [{ "arrs": [[1, 0, 0, 0, 0, 0, 0, 0, 0]], "in_calls": [[[0, 1, 2, 0, 1, 3, 4]]], "arr_len": [1] }]
        });
        assert_eq!(decode_tables(&encode_tables(&v, "in-tables")).unwrap(), v);
    }

    #[test]
    fn empty_tables_encode() {
        let v = json!({ "fmt": 6, "paths": [], "chords": [], "origins": [] });
        assert_eq!(decode_tables(&encode_tables(&v, "in-tables")).unwrap(), v);
    }

    /// The reference reader accepts the file and sees the same tensors, and
    /// every tensor starts at a multiple of its element size.
    fn check_with_reference(b: &[u8]) {
        let st = SafeTensors::deserialize(b).expect("safetensors crate rejects the file");
        let ours = read(b).unwrap();
        let hl = u64::from_le_bytes(b[..8].try_into().unwrap()) as usize;
        assert_eq!((8 + hl) % 8, 0);
        for (name, view) in st.tensors() {
            let (_, vals) = ours.col(&name);
            let sz = view.dtype().bitsize() / 8;
            assert_eq!(view.data().len(), vals.len() * sz, "{name}");
            assert_eq!(
                (view.data().as_ptr() as usize - b.as_ptr() as usize) % sz,
                0,
                "{name} unaligned"
            );
        }
        let (_, md) = SafeTensors::read_metadata(b).unwrap();
        assert_eq!(md.metadata().as_ref().unwrap()["format"], FORMAT);
    }

    #[test]
    fn reference_reader_accepts_our_files() {
        check_with_reference(&encode_tables(&out_tables(), "out-tables"));
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/public/assets");
        for name in [
            "atlas-v2-out-tables.safetensors",
            "atlas-v2-in-tables.safetensors",
        ] {
            if crate::pack::exists(&dir, name) {
                check_with_reference(&crate::pack::read_bytes(&dir, name));
            }
        }
    }

    #[test]
    fn rejects_other_bytes() {
        assert!(read(b"{\"fmt\":6}").is_err());
    }
}
