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
//! Per-train paths (`dep_secs` / `arr_secs` semantics; the five-file split
//! stores them deduplicated as `fmt: 6`, see below). In the combined file:
//! - `dep_secs` / `arr_secs` list each train's sections in TRAVEL order
//!   (outbound: from this origin onward; inbound: from the train's first
//!   stop to its arrival here); a section repeats when the train runs back
//!   over it (consecutive repeats collapsed; flows are counted per train
//!   separately, so they are unaffected). A
//!   value `s >= 0` is section `s` travelled along its stored point order;
//!   `s < 0` is section `-s - 1` (`!s`) travelled against it.
//! - Station throats (O1, fmt 6): an entry whose id (after `!`) is `>= n`,
//!   n = the direction's section count (`sections.len()` in `dep_secs`,
//!   `in_sections.len()` in `arr_secs`), is throat `id - n` of the shared
//!   `throats` list: geometry only (polylines like `network`). A throat is a
//!   maximal run of consecutive track edges inside one leg that
//!   `near_station` (1.3 km around every stop) keeps out of the flow
//!   sections; legs are split at their stops, so a station sits exactly
//!   between the arriving leg's last throat and the departing leg's first.
//!   Throats are deduped globally by node chain (one id per piece, `!` when
//!   walked against its stored order) and simplified like sections. They are
//!   never flows: no map flow row, no call `sec_cnt`, no flow counting.
//!   Removing them from a path leaves exactly the pre-O1 (fmt 5) path.
//! - Positions vs counts: every POSITION below (chord legs, stop positions,
//!   `dep_off` / `arr_len`) indexes the whole path, throats included. The
//!   call `sec_cnt` COUNTS flow sections only:
//! - Outbound call `sec_cnt`: the first `sec_cnt` flow sections of
//!   `dep_secs` run from the origin to that call. Inbound call `sec_cnt`:
//!   the LAST `sec_cnt` flow sections of `arr_secs` run from the boarding
//!   stop to the arrival.
//! - `dep_chord_legs` / `arr_chord_legs`: per train, `[stop, s0, s1]` for
//!   each leg without usable track geometry (unresolved, or a gap > 3 km):
//!   the leg departs the train's stop index `stop` (an index into its
//!   schedule) and owns path entries `s0..s1` (empty when unresolved).
//!   Definition: s0/s1 are POSITIONS in the emitted dep_secs/arr_secs
//!   (not section ids), half-open [s0, s1) = the entries the leg itself
//!   produced; the gap may sit at any join k in s0..=s1 (join k = between
//!   entries k-1 and k), so entry s0-1 and entry s1 are the neighbours on
//!   either side; s0 == s1 means the leg produced no entries and the gap is
//!   the single join s0 (between entries s0-1 and s0).
//! - `dep_stop_pos`: per dep row, one entry per stop after boarding, in
//!   stop order: the number of dep_secs entries (throats included) before
//!   that stop. The stop sits at the start of entry `pos`, which is the
//!   departing leg's first entry: its throat at the station when it has one,
//!   so dwells sit at the station itself; the terminus has pos == path length
//!   (the end of the arriving leg's last throat).
//!   Station level, unlike the city calls (first station per city only).
//!   The stops are `schedules[t][len - stops ..]` (`stops` = the dep row's
//!   stop count), which give their stations and times.
//!
//! Five-file split, `fmt: 6` (O15 + O6 = fmt 5, plus O1's throats; every file
//! carries `fmt: 6` and the client refuses anything else, so ids can never
//! be mixed across formats):
//! - O15 section renumbering. Per direction the sections are renumbered
//!   "long paths first": the longest path of each train (trains in first-seen
//!   order, stable-sorted by descending length) lists its not-yet-seen
//!   sections in path order, then every remaining section keeps its old
//!   relative order. Throat ids are not renumbered. `sections` / `in_sections` in the shared file, the map
//!   flows and all path ids use the new numbering (out and in independently).
//!   Map flow rows (`flows`, `in_flows`) are sorted by section id and
//!   delta-encoded: column 0 is the difference to the previous row's section
//!   id (the first row is relative to 0); the other columns are unchanged.
//! - O6 per-train paths. Every table file carries `paths[t]`, the longest
//!   `dep_secs` (out) / `arr_secs` (in) row of train `t`, in raw signed ids
//!   (no deltas: they would break the repeats brotli exploits). Every row of
//!   `t` is a clean slice of it, hard-asserted at pack time: an out row is
//!   the suffix `paths[t][dep_off[i]..]` (`dep_off` per origin), an in row
//!   the prefix `paths[t][..arr_len[i]]` (`arr_len` per origin).
//!   `dep_off` / `arr_len` are explicit because 37 outbound / 31 inbound
//!   trains revisit sections (the slice start is not derivable from ids).
//!   Out-tables also carry `stop_pos[t]`, the longest row's `dep_stop_pos`
//!   in full-path coordinates; a row with `n = stops` takes the last `n`
//!   entries minus `dep_off`. `chords` is `[[t, legs]]` for trains whose
//!   longest row has chord legs, legs in full-path positions; an out row
//!   keeps the legs with `s0 >= dep_off` (positions minus `dep_off`), an in
//!   row the legs with `s1 <= arr_len`. All of it is asserted to rebuild
//!   today's per-row `dep_secs` / `dep_chord_legs` / `dep_stop_pos` /
//!   `arr_secs` / `arr_chord_legs` exactly. Per-train chords and stop
//!   positions measured smaller than per-row copies (stop_pos 180 KB -> 53 KB
//!   brotli, chords 1.1 KB -> 0.3 KB).
//! - `atlas-v2-out.json` / `atlas-v2-in.json` are no longer written (unused,
//!   and their ids would not match the renumbered shared file); the combined
//!   `china-flow-atlas-data-v2.json` keeps the original numbering.
//!
//! Schedules (`atlas-v2-schedules.json`, generated, not hand-committed):
//! `schedules[t]` (t = train_table index) is the train's full stop list,
//! rows `[station_table idx, arr mins, dep mins, day offset, leg km]`
//! (-1 = no time / unknown km). `extra_stations` stays empty (kept for
//! the client's type); every stop resolves into station_table.
//!
//! Outputs, each also written Brotli-compressed (quality 11) with a `.br`
//! suffix:
//! - china-flow-atlas-data-v2.json (original section numbering)
//! - atlas-v2-shared.json
//! - Five-file split (first-paint staging): atlas-v2-out-map.json,
//!   atlas-v2-out-tables.json, atlas-v2-in-map.json, atlas-v2-in-tables.json
//!   (shared is shared). The four origin files partition the combined
//!   origins exactly; the packer asserts the partition before writing.
//! - atlas-v2-schedules.json
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
        "dep_chord_legs": get(o, "dep_chord_legs"),
        "dep_stop_pos": get(o, "dep_stop_pos"),
        "arr_secs": get(o, "arr_secs"),
        "arr_chord_legs": get(o, "arr_chord_legs"),
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
    for key in ["network", "throats"] {
        let (a, b) = (arr(get(v1, key)), arr(get(v2, key)));
        if a.len() != b.len() {
            return Err(format!("{key} count"));
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
            "dep_chord_legs",
            "dep_stop_pos",
            "arr_secs",
            "arr_chord_legs",
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

// ------- fmt 6: renumbering (O15) + path dedupe (O6) + throats (O1) -------

const FMT: i64 = 6;

/// Which per-direction fields to pack.
struct Dir {
    out: bool,
    rows: &'static str,
    secs: &'static str,
    chords: &'static str,
}

const OUT: Dir = Dir {
    out: true,
    rows: "deps",
    secs: "dep_secs",
    chords: "dep_chord_legs",
};
const IN: Dir = Dir {
    out: false,
    rows: "arrs",
    secs: "arr_secs",
    chords: "arr_chord_legs",
};

fn ints(v: &Value) -> Vec<i64> {
    arr(v).iter().map(|x| x.as_i64().unwrap()).collect()
}

/// Section ids go through `perm`; throat entries (`>= perm.len()`, O1) keep
/// their id.
fn remap(v: i64, perm: &[usize]) -> i64 {
    if (if v >= 0 { v } else { !v }) as usize >= perm.len() {
        v
    } else if v >= 0 {
        perm[v as usize] as i64
    } else {
        !(perm[(!v) as usize] as i64)
    }
}

/// Old section id -> new id, "long paths first" (see the header).
fn renumber(origins: &[Value], d: &Dir, secs: &[Value]) -> Vec<usize> {
    let n_secs = secs.len();
    let mut best: Vec<(i64, Vec<i64>)> = Vec::new(); // first-seen train order
    let mut at: std::collections::HashMap<i64, usize> = std::collections::HashMap::new();
    for o in origins {
        for (row, path) in arr(get(o, d.rows)).iter().zip(arr(get(o, d.secs))) {
            let (t, path) = (arr(row)[0].as_i64().unwrap(), ints(path));
            match at.get(&t) {
                None => {
                    at.insert(t, best.len());
                    best.push((t, path));
                }
                Some(&i) if path.len() > best[i].1.len() => best[i].1 = path,
                _ => {}
            }
        }
    }
    best.sort_by_key(|(_, p)| std::cmp::Reverse(p.len())); // stable
    let mut seen = vec![false; n_secs];
    let mut order = Vec::with_capacity(n_secs);
    for (_, p) in &best {
        for &v in p {
            let s = if v >= 0 { v } else { !v } as usize;
            if s < n_secs && !seen[s] {
                seen[s] = true;
                order.push(s);
            }
        }
    }
    // sections on no path (none expected): by polyline, so the order never
    // depends on the build's section numbering
    let mut rest: Vec<usize> = (0..n_secs).filter(|&s| !seen[s]).collect();
    rest.sort_by(|&x, &y| (get(&secs[x], "g").as_str(), x).cmp(&(get(&secs[y], "g").as_str(), y)));
    order.extend(rest);
    let mut perm = vec![0usize; n_secs];
    for (new, &old) in order.iter().enumerate() {
        perm[old] = new;
    }
    perm
}

/// Sort map flow rows by (new) section id and delta-encode column 0.
fn pack_flows(rows: &Value, perm: &[usize]) -> Value {
    let mut r: Vec<Vec<Value>> = arr(rows)
        .iter()
        .map(|f| {
            let mut f = arr(f).clone();
            f[0] = json!(perm[f[0].as_u64().unwrap() as usize]);
            f
        })
        .collect();
    r.sort_by_key(|f| f[0].as_u64().unwrap());
    let mut prev = 0u64;
    for f in r.iter_mut() {
        let id = f[0].as_u64().unwrap();
        f[0] = json!(id - prev);
        prev = id;
    }
    Value::Array(r.into_iter().map(Value::Array).collect())
}

/// Rebuild one row's chord legs from the train's full-path legs.
fn row_legs(full: &[Vec<i64>], d: &Dir, off: i64, len: i64) -> Vec<Vec<i64>> {
    full.iter()
        .filter(|l| if d.out { l[1] >= off } else { l[2] <= len })
        .map(|l| {
            if d.out {
                vec![l[0], l[1] - off, l[2] - off]
            } else {
                l.clone()
            }
        })
        .collect()
}

/// A train's full path, stop positions and chord legs (raw old ids).
type FullPath = (Vec<i64>, Vec<i64>, Vec<Vec<i64>>);

/// Dedupe one direction's per-row paths into per-train tables. Returns
/// (paths, stop_pos (out only), chords, per-origin offsets/lengths); ids are
/// remapped through `perm`. Every row is asserted to be the exact slice.
fn pack_paths(
    origins: &[Value],
    d: &Dir,
    n_trains: usize,
    perm: &[usize],
) -> (Vec<Value>, Vec<Value>, Vec<Value>, Vec<Value>) {
    // The longest row per train is its full path.
    let mut full: Vec<Option<(usize, usize)>> = vec![None; n_trains];
    for (oi, o) in origins.iter().enumerate() {
        for (ri, (row, path)) in arr(get(o, d.rows))
            .iter()
            .zip(arr(get(o, d.secs)))
            .enumerate()
        {
            let t = arr(row)[0].as_u64().unwrap() as usize;
            let l = arr(path).len();
            if full[t].is_none_or(|(fo, fr)| l > arr(&get(&origins[fo], d.secs)[fr]).len()) {
                full[t] = Some((oi, ri));
            }
        }
    }
    let at = |(oi, ri): (usize, usize), key: &str| get(&origins[oi], key)[ri].clone();
    let mut paths = Vec::new();
    let mut stop_pos = Vec::new();
    let mut chords = Vec::new();
    let mut fulls: Vec<FullPath> = Vec::new();
    for (t, f) in full.iter().enumerate() {
        let Some(f) = *f else {
            fulls.push(Default::default());
            paths.push(json!([]));
            stop_pos.push(json!([]));
            continue;
        };
        let p = ints(&at(f, d.secs));
        let sp = if d.out {
            ints(&at(f, "dep_stop_pos"))
        } else {
            vec![]
        };
        let ch: Vec<Vec<i64>> = arr(&at(f, d.chords)).iter().map(ints).collect();
        paths.push(json!(p.iter().map(|&v| remap(v, perm)).collect::<Vec<_>>()));
        stop_pos.push(json!(sp));
        if !ch.is_empty() {
            chords.push(json!([t, ch]));
        }
        fulls.push((p, sp, ch));
    }
    let mut per_origin = Vec::new();
    for (oi, o) in origins.iter().enumerate() {
        let mut marks = Vec::new();
        for (ri, row) in arr(get(o, d.rows)).iter().enumerate() {
            let t = arr(row)[0].as_u64().unwrap() as usize;
            let (fp, fsp, fch) = &fulls[t];
            let p = ints(&get(o, d.secs)[ri]);
            let (off, len) = if d.out {
                ((fp.len() - p.len()) as i64, p.len() as i64)
            } else {
                (0, p.len() as i64)
            };
            let slice = if d.out {
                &fp[off as usize..]
            } else {
                &fp[..p.len()]
            };
            assert!(
                slice == &p[..],
                "{} row {oi}/{ri}: path is not a clean slice of train {t}'s full path",
                d.rows
            );
            let legs: Vec<Vec<i64>> = arr(&get(o, d.chords)[ri]).iter().map(ints).collect();
            assert_eq!(
                row_legs(fch, d, off, len),
                legs,
                "{} row {oi}/{ri}: chord legs",
                d.rows
            );
            if d.out {
                let n = arr(row)[7].as_u64().unwrap() as usize;
                let want = ints(&get(o, "dep_stop_pos")[ri]);
                let got: Vec<i64> = fsp[fsp.len() - n..].iter().map(|x| x - off).collect();
                assert_eq!(got, want, "dep row {oi}/{ri}: stop positions");
                marks.push(json!(off));
            } else {
                marks.push(json!(len));
            }
        }
        per_origin.push(Value::Array(marks));
    }
    (paths, stop_pos, chords, per_origin)
}

fn with_fmt(mut m: Map<String, Value>) -> Value {
    m.insert("fmt".into(), json!(FMT));
    Value::Object(m)
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
        "throats": arr(get(&v1, "throats")).iter()
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
        .map(|o| {
            pick(
                o,
                &[
                    "deps",
                    "calls",
                    "dep_secs",
                    "dep_chord_legs",
                    "dep_stop_pos",
                ],
            )
        })
        .collect();
    let in_map: Vec<Value> = origins
        .iter()
        .map(|o| pick(o, &["srcs", "in_flows"]))
        .collect();
    let in_tables: Vec<Value> = origins
        .iter()
        .map(|o| pick(o, &["arrs", "in_calls", "arr_secs", "arr_chord_legs"]))
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

    // fmt 6: renumber sections per direction, dedupe the per-row paths into
    // per-train tables, sort + delta-encode the map flows.
    let n_trains = arr(get(&v1, "train_table")).len();
    let perm_out = renumber(&origins, &OUT, arr(get(&shared, "sections")));
    let perm_in = renumber(&origins, &IN, arr(get(&shared, "in_sections")));
    let reorder = |secs: &Value, perm: &[usize]| -> Value {
        let mut v = vec![Value::Null; perm.len()];
        for (old, s) in arr(secs).iter().enumerate() {
            v[perm[old]] = s.clone();
        }
        Value::Array(v)
    };
    let mut shared5 = obj(&shared).clone();
    shared5.insert(
        "sections".into(),
        reorder(get(&shared, "sections"), &perm_out),
    );
    shared5.insert(
        "in_sections".into(),
        reorder(get(&shared, "in_sections"), &perm_in),
    );
    let mut shared5 = with_fmt(shared5);
    // Provenance rides along in shared (the client ignores it); v1 files
    // from before the block have none.
    if let Some(b) = v1.get("build") {
        shared5
            .as_object_mut()
            .unwrap()
            .insert("build".into(), b.clone());
    }
    let (op, osp, och, ooff) = pack_paths(&origins, &OUT, n_trains, &perm_out);
    let (ip, _, ich, ilen) = pack_paths(&origins, &IN, n_trains, &perm_in);
    let map5 = |maps: &[Value], key: &str, perm: &[usize]| -> Vec<Value> {
        maps.iter()
            .map(|m| {
                let mut m = obj(m).clone();
                if let Some(f) = m.get_mut(key) {
                    *f = pack_flows(f, perm);
                }
                Value::Object(m)
            })
            .collect()
    };
    let out_map5 = map5(&out_map, "flows", &perm_out);
    let in_map5 = map5(&in_map, "in_flows", &perm_in);
    let tables5 = |tables: &[Value], drop: &[&str], mark: &str, marks: Vec<Value>| -> Vec<Value> {
        tables
            .iter()
            .zip(marks)
            .map(|(t, m)| {
                let mut t = obj(t).clone();
                for k in drop {
                    t.remove(*k);
                }
                t.insert(mark.into(), m);
                Value::Object(t)
            })
            .collect()
    };
    let out_tables5 = tables5(
        &out_tables,
        &["dep_secs", "dep_chord_legs", "dep_stop_pos"],
        "dep_off",
        ooff,
    );
    let in_tables5 = tables5(&in_tables, &["arr_secs", "arr_chord_legs"], "arr_len", ilen);
    println!("fmt 6 pack: PASS (every row is an exact slice of its train's full path)");

    use rayon::prelude::*;

    let mut by_name: Vec<(&str, Value)> = Vec::new();
    by_name.push(("china-flow-atlas-data-v2.json", combined));
    by_name.push(("atlas-v2-shared.json", shared5));
    by_name.push((
        "atlas-v2-out-map.json",
        json!({ "fmt": FMT, "origins": out_map5 }),
    ));
    by_name.push((
        "atlas-v2-out-tables.json",
        json!({ "fmt": FMT, "paths": op, "stop_pos": osp, "chords": och, "origins": out_tables5 }),
    ));
    by_name.push((
        "atlas-v2-in-map.json",
        json!({ "fmt": FMT, "origins": in_map5 }),
    ));
    by_name.push((
        "atlas-v2-in-tables.json",
        json!({ "fmt": FMT, "paths": ip, "chords": ich, "origins": in_tables5 }),
    ));
    by_name.push((
        "atlas-v2-schedules.json",
        json!({ "extra_stations": [], "schedules": get(&v1, "schedules") }),
    ));

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

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: usize) -> Vec<Value> {
        // "g" decreasing with the id, so the polyline tie-break is visible
        (0..n)
            .map(|i| json!({ "g": format!("{}", 9 - i) }))
            .collect()
    }

    fn origin(rows: &[i64], paths: &[Vec<i64>]) -> Value {
        json!({
            "deps": rows.iter().map(|t| json!([t])).collect::<Vec<_>>(),
            "dep_secs": paths,
        })
    }

    #[test]
    fn renumber_puts_the_longest_paths_first() {
        // train 0: [3, ~1] (2 long); train 1: [0, 2, 3] (3 long); section 4 on no path
        let o = origin(&[0, 1], &[vec![3, !1], vec![0, 2, 3]]);
        let perm = renumber(&[o], &OUT, &secs(5));
        // order: 0, 2, 3 (train 1), then 1 (train 0; 3 seen), then the unused 4
        assert_eq!(perm, vec![0, 3, 1, 2, 4]);
    }

    #[test]
    fn renumber_takes_a_trains_longest_row_across_origins() {
        let a = origin(&[7], &[vec![2]]);
        let b = origin(&[7], &[vec![1, 2, 0]]);
        let perm = renumber(&[a, b], &OUT, &secs(3));
        assert_eq!(perm, vec![2, 0, 1]);
    }

    #[test]
    fn renumber_is_a_permutation_and_orders_unused_sections_by_polyline() {
        let o = origin(&[0], &[vec![1]]);
        let perm = renumber(&[o], &OUT, &secs(4));
        // section 1 first; 0, 2, 3 on no path -> by "g" ascending = id descending
        assert_eq!(perm, vec![3, 0, 2, 1]);
        let mut sorted = perm.clone();
        sorted.sort();
        assert_eq!(sorted, vec![0, 1, 2, 3]);
    }

    #[test]
    fn remap_keeps_throat_ids_and_signs() {
        let perm = vec![2, 0, 1];
        assert_eq!(remap(0, &perm), 2);
        assert_eq!(remap(!0, &perm), !2);
        assert_eq!(remap(3, &perm), 3, "3 is a throat, not a section");
        assert_eq!(remap(!4, &perm), !4);
    }

    #[test]
    fn pack_flows_sorts_by_new_id_and_delta_encodes() {
        let rows = json!([[2, 10], [0, 5, 3], [1, 7]]);
        // old 0 -> 1, old 1 -> 0, old 2 -> 2
        let packed = pack_flows(&rows, &[1, 0, 2]);
        // new ids 0 (7), 1 (5, 3), 2 (10) -> deltas 0, 1, 1
        assert_eq!(packed, json!([[0, 7], [1, 5, 3], [1, 10]]));
    }

    #[test]
    fn pack_flows_keeps_gaps_as_deltas() {
        let rows = json!([[4, 9], [1, 2]]);
        let packed = pack_flows(&rows, &[0, 1, 2, 3, 4]);
        assert_eq!(packed, json!([[1, 2], [3, 9]]));
    }
}
