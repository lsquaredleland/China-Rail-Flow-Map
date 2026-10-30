//! Reading the v2 pack files (`atlas-v2-*.json`) from a directory, either
//! Brotli-compressed (`.json.br`, what ships in `web/public/assets`) or plain.

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;

/// Decompress a Brotli stream.
pub fn brotli_decode(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    brotli::Decompressor::new(bytes, 1 << 16)
        .read_to_end(&mut out)
        .expect("brotli decode");
    out
}

/// The text of pack file `name` (e.g. `atlas-v2-shared.json`) in `dir`:
/// `<name>.br` when present (the shipped form), else `<name>`.
pub fn read_text(dir: &Path, name: &str) -> String {
    let br = dir.join(format!("{name}.br"));
    if br.exists() {
        let raw = fs::read(&br).unwrap_or_else(|e| panic!("read {}: {e}", br.display()));
        String::from_utf8(brotli_decode(&raw))
            .unwrap_or_else(|e| panic!("{} is not UTF-8: {e}", br.display()))
    } else {
        let p = dir.join(name);
        fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
    }
}

/// The bytes of pack file `name` in `dir`, brotli-decoded when it is
/// `<name>.br` (as [`read_text`]).
pub fn read_bytes(dir: &Path, name: &str) -> Vec<u8> {
    let br = dir.join(format!("{name}.br"));
    if br.exists() {
        brotli_decode(&fs::read(&br).unwrap_or_else(|e| panic!("read {}: {e}", br.display())))
    } else {
        let p = dir.join(name);
        fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
    }
}

/// Is pack file `name` in `dir`, as `<name>.br` or `<name>`?
pub fn exists(dir: &Path, name: &str) -> bool {
    dir.join(format!("{name}.br")).exists() || dir.join(name).exists()
}

/// [`read_text`] parsed as JSON.
pub fn read_json(dir: &Path, name: &str) -> Value {
    serde_json::from_str(&read_text(dir, name))
        .unwrap_or_else(|e| panic!("parse {name} in {}: {e}", dir.display()))
}

/// One entry of a fmt-6 per-train path: entry `id` (a flow section when
/// `id < n`, else throat `id - n`), walked against its stored point order
/// when `rev`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: usize,
    pub rev: bool,
}

impl Entry {
    /// Decode a signed path value (`!id` = reversed).
    pub fn decode(v: i64) -> Entry {
        if v >= 0 {
            Entry {
                id: v as usize,
                rev: false,
            }
        } else {
            Entry {
                id: (!v) as usize,
                rev: true,
            }
        }
    }

    /// Is this a flow section of a direction with `n` sections (not a throat)?
    pub fn is_flow(self, n: usize) -> bool {
        self.id < n
    }
}

/// Flow sections among a path's signed entries (throats excluded).
pub fn flow_count(path: &[i64], n: usize) -> usize {
    path.iter()
        .filter(|&&v| Entry::decode(v).is_flow(n))
        .count()
}

fn ints(v: &Value) -> Vec<i64> {
    v.as_array()
        .map(|a| a.iter().map(|x| x.as_i64().unwrap()).collect())
        .unwrap_or_default()
}

/// A tables file's `chords` list (`[[train, rows]]`) as train -> rows.
pub fn chord_map(v: &Value) -> HashMap<usize, Vec<Vec<i64>>> {
    v.as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let legs = c[1].as_array().into_iter().flatten().map(ints).collect();
            (c[0].as_u64().unwrap() as usize, legs)
        })
        .collect()
}

/// Expand a fmt-5 tables file (per-train `paths` / `stop_pos` / `chords` plus
/// per-origin `dep_off` / `arr_len`) back to per-row `dep_secs` /
/// `dep_chord_legs` / `dep_stop_pos` (out) or `arr_secs` / `arr_chord_legs`
/// (in), the shape audit's checks read. Independent of atlaspack's packer.
/// Panics on a malformed file (audit runs it only after the format checks).
pub fn expand_tables(t: &mut Value, out: bool) {
    let ints = |v: &Value| -> Vec<i64> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_i64().unwrap())
            .collect()
    };
    let paths: Vec<Vec<i64>> = t["paths"].as_array().unwrap().iter().map(ints).collect();
    let stop_pos: Vec<Vec<i64>> = if out {
        t["stop_pos"].as_array().unwrap().iter().map(ints).collect()
    } else {
        Vec::new()
    };
    let chords = chord_map(&t["chords"]);
    let (rows_key, mark_key) = if out {
        ("deps", "dep_off")
    } else {
        ("arrs", "arr_len")
    };
    for o in t["origins"].as_array_mut().unwrap() {
        let (mut secs, mut legs_all, mut sp_all) = (Vec::new(), Vec::new(), Vec::new());
        let marks = ints(&o[mark_key]);
        for (row, &m) in o[rows_key].as_array().unwrap().iter().zip(&marks) {
            let tr = row[0].as_u64().unwrap() as usize;
            let full = &paths[tr];
            let (lo, hi) = if out {
                (m as usize, full.len())
            } else {
                (0, m as usize)
            };
            secs.push(serde_json::json!(full[lo..hi]));
            let legs: Vec<Vec<i64>> = chords
                .get(&tr)
                .into_iter()
                .flatten()
                .filter(|l| if out { l[1] >= m } else { l[2] <= m })
                .map(|l| {
                    if out {
                        vec![l[0], l[1] - m, l[2] - m]
                    } else {
                        l.clone()
                    }
                })
                .collect();
            legs_all.push(serde_json::json!(legs));
            if out {
                let n = row[7].as_u64().unwrap() as usize;
                let sp = &stop_pos[tr];
                let v: Vec<i64> = sp[sp.len() - n..].iter().map(|x| x - m).collect();
                sp_all.push(serde_json::json!(v));
            }
        }
        let (sk, ck) = if out {
            ("dep_secs", "dep_chord_legs")
        } else {
            ("arr_secs", "arr_chord_legs")
        };
        o[sk] = Value::Array(secs);
        o[ck] = Value::Array(legs_all);
        if out {
            o["dep_stop_pos"] = Value::Array(sp_all);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pack-test-{tag}-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn br(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut w = brotli::CompressorWriter::new(&mut out, 4096, 5, 22);
            w.write_all(bytes).unwrap();
        }
        out
    }

    #[test]
    fn reads_brotli_and_plain() {
        let d = tmp("rw");
        fs::write(d.join("a.json.br"), br(br#"{"x":1}"#)).unwrap();
        fs::write(d.join("b.json"), r#"{"y":2}"#).unwrap();
        assert_eq!(read_json(&d, "a.json")["x"], 1);
        assert_eq!(read_json(&d, "b.json")["y"], 2);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn prefers_the_shipped_brotli_form() {
        let d = tmp("pref");
        fs::write(d.join("c.json"), r#"{"v":"plain"}"#).unwrap();
        fs::write(d.join("c.json.br"), br(br#"{"v":"br"}"#)).unwrap();
        assert_eq!(read_json(&d, "c.json")["v"], "br");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn entry_decode() {
        assert_eq!(Entry::decode(0), Entry { id: 0, rev: false });
        assert_eq!(Entry::decode(5), Entry { id: 5, rev: false });
        assert_eq!(Entry::decode(-1), Entry { id: 0, rev: true });
        assert_eq!(Entry::decode(!7), Entry { id: 7, rev: true });
    }

    #[test]
    fn entry_is_flow_boundary() {
        let n = 10;
        assert!(Entry { id: 9, rev: false }.is_flow(n));
        assert!(Entry { id: 9, rev: true }.is_flow(n));
        assert!(!Entry { id: 10, rev: false }.is_flow(n));
        assert!(!Entry { id: 10, rev: true }.is_flow(n));
        assert!(!Entry { id: 11, rev: false }.is_flow(n));
    }

    #[test]
    fn flow_count_mixed_path() {
        let path = [0, !1, 3, 4, !4, 5];
        assert_eq!(flow_count(&path, 4), 3);
    }

    #[test]
    fn chord_map_parses_json() {
        let v = serde_json::json!([[0, [[1, 2, 5]]], [3, [[0, 1, 3], [2, 4, 6]]]]);
        let m = chord_map(&v);
        assert_eq!(m.len(), 2);
        assert_eq!(m[&0], vec![vec![1, 2, 5]]);
        assert_eq!(m[&3], vec![vec![0, 1, 3], vec![2, 4, 6]]);
    }

    #[test]
    fn expand_tables_out_and_in() {
        let mut out_table = serde_json::json!({
            "paths": [
                [10, 11, 12, 13],
                [20, 21, 22]
            ],
            "stop_pos": [
                [1, 3],
                [0, 2]
            ],
            "chords": [
                [0, [[1, 1, 3]]],
                [1, [[2, 0, 2]]]
            ],
            "origins": [{
                "dep_off": [1, 0],
                "deps": [
                    [0, 0, 0, 0, 0, 0, 0, 2],
                    [1, 0, 0, 0, 0, 0, 0, 1]
                ]
            }]
        });
        expand_tables(&mut out_table, true);
        let orig = &out_table["origins"][0];
        assert_eq!(
            orig["dep_secs"],
            serde_json::json!([[11, 12, 13], [20, 21, 22]])
        );
        assert_eq!(
            orig["dep_chord_legs"],
            serde_json::json!([[[1, 0, 2]], [[2, 0, 2]]])
        );
        assert_eq!(orig["dep_stop_pos"], serde_json::json!([[0, 2], [2]]));

        let mut in_table = serde_json::json!({
            "paths": [
                [10, 11, 12, 13],
                [20, 21, 22]
            ],
            "chords": [
                [0, [[1, 0, 2]]],
                [1, [[2, 0, 2]]]
            ],
            "origins": [{
                "arr_len": [2, 3],
                "arrs": [
                    [0],
                    [1]
                ]
            }]
        });
        expand_tables(&mut in_table, false);
        let in_orig = &in_table["origins"][0];
        assert_eq!(
            in_orig["arr_secs"],
            serde_json::json!([[10, 11], [20, 21, 22]])
        );
        assert_eq!(
            in_orig["arr_chord_legs"],
            serde_json::json!([[[1, 0, 2]], [[2, 0, 2]]])
        );
    }
}
