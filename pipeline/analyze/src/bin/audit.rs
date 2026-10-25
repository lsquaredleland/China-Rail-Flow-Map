use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use analyze_rs::chains;
use analyze_rs::cn::*;
use analyze_rs::geo::*;
use analyze_rs::inputs;
use analyze_rs::legs::*;
use analyze_rs::model::*;
use analyze_rs::names::*;
use analyze_rs::pack;
use analyze_rs::polyline::*;
use analyze_rs::timetable::*;

#[derive(Default, Clone)]
struct DestStats {
    total: u64,
    fast: u64,
    terminating: u64,
    times: Vec<i64>,
    rail: Vec<f64>,
    first: usize,
}

#[derive(serde::Serialize)]
struct AtlasSection {
    a: i64,
    b: i64,
    g: String,
}

/// Expand a fmt-5 tables file (per-train `paths` / `stop_pos` / `chords` plus
/// per-origin `dep_off` / `arr_len`) back to per-row `dep_secs` /
/// `dep_chord_legs` / `dep_stop_pos` (out) or `arr_secs` / `arr_chord_legs`
/// (in), the shape the checks below read. Independent of atlaspack's packer.
fn expand_tables(t: &mut Value, out: bool) {
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
    let mut chords: HashMap<usize, Vec<Vec<i64>>> = HashMap::new();
    for c in t["chords"].as_array().unwrap() {
        let legs = c[1].as_array().unwrap().iter().map(ints).collect();
        chords.insert(c[0].as_u64().unwrap() as usize, legs);
    }
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

/// Phase 1-2 checks on a packed v2 build (env AUDIT_PACK_DIR): oriented
/// per-train path continuity outside chord legs, monotone call cutoffs,
/// schedule coverage, and the Chengdu goldens. Returns whether the hard
/// checks pass, plus the counters that goldens.json gates on. Reads each file
/// as `.json.br` when present (what ships), else `.json`.
///
/// `dropped_chains` / `flow_lost` (O8) are not computed here, and cannot be:
/// a dropped chain is a section chain whose nodes have no OSM coordinates, so
/// it never reaches the pack. Its flow is missing from the flow rows and from
/// every train path alike, so the pack is internally consistent without it.
/// Only the full run, which has the OSM extract, can count them; the pack
/// shows at most their side effect (path joins with a gap), which the
/// `continuity_gaps_*` and `chord_leg_rows` counters already gate.
fn audit_pack(dir: &Path) -> (bool, BTreeMap<String, i64>) {
    let load = |n: &str| -> Value { pack::read_json(dir, n) };
    let shared = load("atlas-v2-shared.json");
    let out_map = load("atlas-v2-out-map.json");
    let in_map = load("atlas-v2-in-map.json");
    let (mut out_t, mut in_t) = (
        load("atlas-v2-out-tables.json"),
        load("atlas-v2-in-tables.json"),
    );
    let sch = load("atlas-v2-schedules.json");
    match shared.get("build") {
        Some(b) => println!("AUDIT pack build: {b}"),
        None => println!("AUDIT pack build: none (pack predates the provenance block)"),
    }
    let arr = |v: &Value| -> Vec<Value> { v.as_array().cloned().unwrap_or_default() };
    let int = |v: &Value| v.as_i64().unwrap();
    let mut ok = true;
    for (name, t) in [("out-tables", &out_t), ("in-tables", &in_t)] {
        let fmt = t.get("fmt").and_then(Value::as_i64);
        println!("AUDIT pack {name} fmt: {fmt:?}");
        ok &= fmt == Some(6);
    }
    for (name, m) in [
        ("shared", &shared),
        ("out-map", &out_map),
        ("in-map", &in_map),
    ] {
        let fmt = m.get("fmt").and_then(Value::as_i64);
        println!("AUDIT pack {name} fmt: {fmt:?}");
        ok &= fmt == Some(6);
    }
    if ok {
        expand_tables(&mut out_t, true);
        expand_tables(&mut in_t, false);
    }
    let ends = |key: &str| -> Vec<([f64; 2], [f64; 2])> {
        arr(&shared[key])
            .iter()
            .map(|s| {
                let p = decode_poly4(s["g"].as_str().unwrap());
                (p[0], *p.last().unwrap())
            })
            .collect()
    };
    // O1: path entries >= the section count are throats (`throats[v - n]`),
    // so the end lists run sections then throats and index by entry id
    let throat_ends: Vec<([f64; 2], [f64; 2])> = arr(&shared["throats"])
        .iter()
        .map(|s| {
            let p = decode_poly4(s.as_str().unwrap());
            (p[0], *p.last().unwrap())
        })
        .collect();
    let (n_out, n_in) = (
        arr(&shared["sections"]).len(),
        arr(&shared["in_sections"]).len(),
    );
    let (mut out_ends, mut in_ends) = (ends("sections"), ends("in_sections"));
    out_ends.extend(&throat_ends);
    in_ends.extend(&throat_ends);
    // flow sections among a path's entries (throats excluded)
    let flow_len = |path: &[Value], n: usize| -> i64 {
        path.iter()
            .filter(|v| {
                let v = v.as_i64().unwrap();
                ((if v >= 0 { v } else { !v }) as usize) < n
            })
            .count() as i64
    };
    let codes: Vec<String> = arr(&shared["train_table"])
        .iter()
        .map(|t| t["code"].as_str().unwrap().to_string())
        .collect();
    let zh: Vec<String> = arr(&out_map["origins"])
        .iter()
        .map(|o| o["zh"].as_str().unwrap().to_string())
        .collect();
    // ---- flow rows: [sec, total, g, d, c, s, z, t, k, plain]; the class
    // columns must add up to the total (a wrong class split under a right
    // total passes every other check) ----
    let (mut class_rows, mut class_bad) = (0u64, 0u64);
    for (m, key) in [(&out_map, "flows"), (&in_map, "in_flows")] {
        for o in arr(&m["origins"]).iter() {
            for r in arr(&o[key]).iter() {
                let r: Vec<i64> = arr(r).iter().map(int).collect();
                class_rows += 1;
                if r.len() < 2 || r.len() > 10 || r[2..].iter().sum::<i64>() != r[1] {
                    class_bad += 1;
                }
            }
        }
    }
    println!(
        "AUDIT pack flow class columns: {class_rows} rows, {class_bad} where sum(classes) != total"
    );
    ok &= class_bad == 0;
    // ---- path continuity: exit of oriented section k-1 -> entry of k ----
    let mut worst: Vec<(f64, String)> = Vec::new();
    let (mut checked, mut gaps, mut chord_rows, mut chord_legs) = (0u64, 0u64, 0u64, 0u64);
    // gaps up to 6 km were station-throat trims (B8) until O1's throats
    let mut throat_gaps = 0u64;
    // finer tiers of the same joins: gap > 0.1 km, (0.1, 1], (1, 3]
    let (mut gaps_100m, mut tier_1km, mut tier_3km) = (0u64, 0u64, 0u64);
    let mut throat_refs = 0u64;
    let mut bad_trains: HashSet<(usize, &str, usize)> = HashSet::new();
    let mut sec_cnt_over = 0u64;
    // outbound rows with a > 35 km jump, inside chord legs only / outside
    let (mut jump_in, mut jump_out) = (0i64, 0i64);
    for (label, tables, secs_key, chords_key, rows_key, ends, n_secs) in [
        (
            "out",
            &out_t,
            "dep_secs",
            "dep_chord_legs",
            "deps",
            &out_ends,
            n_out,
        ),
        (
            "in",
            &in_t,
            "arr_secs",
            "arr_chord_legs",
            "arrs",
            &in_ends,
            n_in,
        ),
    ] {
        for (oi, o) in arr(&tables["origins"]).iter().enumerate() {
            let rows = arr(&o[rows_key]);
            let chords = arr(&o[chords_key]);
            for (ri, path) in arr(&o[secs_key]).iter().enumerate() {
                let path: Vec<i64> = arr(path).iter().map(int).collect();
                throat_refs += path
                    .iter()
                    .filter(|&&v| (if v >= 0 { v } else { !v }) as usize >= n_secs)
                    .count() as u64;
                let mut exempt: HashSet<usize> = HashSet::new();
                let cl = arr(&chords[ri]);
                if !cl.is_empty() {
                    chord_rows += 1;
                }
                for c in cl.iter() {
                    chord_legs += 1;
                    for k in int(&c[1])..=int(&c[2]) {
                        exempt.insert(k as usize);
                    }
                }
                let oriented = |v: i64| -> ([f64; 2], [f64; 2]) {
                    if v >= 0 {
                        ends[v as usize]
                    } else {
                        let (a, b) = ends[!v as usize];
                        (b, a)
                    }
                };
                let (mut j_in, mut j_out) = (false, false);
                for k in 1..path.len() {
                    let gap = hav_km_ll(oriented(path[k - 1]).1, oriented(path[k]).0);
                    if exempt.contains(&k) {
                        j_in |= gap > 35.0;
                        continue;
                    }
                    j_out |= gap > 35.0;
                    checked += 1;
                    if gap > 0.1 {
                        gaps_100m += 1;
                        if gap <= 1.0 {
                            tier_1km += 1;
                        } else if gap <= 3.0 {
                            tier_3km += 1;
                        }
                    }
                    if gap > 3.0 {
                        gaps += 1;
                        if gap <= 6.0 {
                            throat_gaps += 1;
                        }
                        bad_trains.insert((oi, label, ri));
                        let code = &codes[int(&rows[ri][0]) as usize];
                        worst.push((
                            gap,
                            format!("{} {label} {code} at {k}/{}", zh[oi], path.len()),
                        ));
                    }
                }
                if label == "out" {
                    jump_out += j_out as i64;
                    jump_in += (j_in && !j_out) as i64;
                }
            }
            // ---- cutoffs: per train, sec_cnt never decreases as calls
            // move away from this city (outbound: later arrival; inbound:
            // later boarding = shorter ride) ----
            let calls_key = if label == "out" { "calls" } else { "in_calls" };
            let mut per: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
            for cell in arr(&o[calls_key]).iter() {
                for r in arr(cell).iter() {
                    let (idx, t1, t2, off) = (int(&r[0]), int(&r[1]), int(&r[2]), int(&r[3]));
                    let cnt = int(&r[if label == "out" { 5 } else { 6 }]);
                    let len = flow_len(&arr(&o[secs_key][idx as usize]), n_secs);
                    if cnt > len {
                        sec_cnt_over += 1;
                    }
                    let key = if label == "out" {
                        off * 1440 + t1
                    } else {
                        off * 1440 + t2 - t1
                    };
                    per.entry(idx).or_default().push((key, cnt));
                }
            }
            for v in per.values_mut() {
                v.sort();
                if v.windows(2).any(|w| w[1].1 < w[0].1) {
                    worst.push((-1.0, format!("{} {label} non-monotone sec_cnt", zh[oi])));
                }
            }
        }
    }
    let non_mono: Vec<&(f64, String)> = worst.iter().filter(|w| w.0 < 0.0).collect();
    println!(
        "AUDIT pack chord legs: {chord_legs} on {chord_rows} train rows (gaps inside are exempt)"
    );
    println!(
        "AUDIT pack throats: {} pieces, {throat_refs} path entries (out + in rows)",
        throat_ends.len()
    );
    println!(
        "AUDIT pack path continuity: {gaps} gaps > 3 km in {checked} joins outside chord legs ({} train rows); {throat_gaps} of them <= 6 km (station throats), {} > 6 km",
        bad_trains.len(),
        gaps - throat_gaps
    );
    println!(
        "AUDIT pack path continuity tiers: {gaps_100m} joins > 0.1 km: {tier_1km} in (0.1, 1], {tier_3km} in (1, 3], {throat_gaps} in (3, 6], {} > 6 km",
        gaps - throat_gaps
    );
    let mut gap_list: Vec<&(f64, String)> = worst.iter().filter(|w| w.0 >= 0.0).collect();
    gap_list.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    for (g, what) in gap_list.iter().take(20) {
        println!("   {g:>8.1} km  {what}");
    }
    println!(
        "AUDIT pack sec_cnt: {} trains non-monotone, {sec_cnt_over} cutoffs beyond path length",
        non_mono.len()
    );
    println!("AUDIT pack outbound rows with a > 35 km jump: {jump_out} outside chord legs, {jump_in} only inside");
    ok &= sec_cnt_over == 0;
    // ---- schedules: every row's train has one, consistent with the row ----
    let scheds = arr(&sch["schedules"]);
    let extra = arr(&sch["extra_stations"]).len();
    let n_st = arr(&shared["station_table"]).len() as i64;
    let mut bad_idx = 0u64;
    for s in scheds.iter() {
        for r in arr(s).iter() {
            if !(0..n_st).contains(&int(&r[0])) {
                bad_idx += 1;
            }
        }
    }
    let (mut rows_n, mut missing, mut mismatch) = (0u64, 0u64, 0u64);
    for o in arr(&out_t["origins"]).iter() {
        for d in arr(&o["deps"]).iter() {
            rows_n += 1;
            let s = scheds.get(int(&d[0]) as usize).map(arr).unwrap_or_default();
            if s.is_empty() {
                missing += 1;
                continue;
            }
            // [t, fs, dep, ts, tc, arr, dur, stops, km]: boarding call at fs/dep,
            // `stops` calls after it, ending at ts
            let p = s
                .iter()
                .position(|r| int(&r[0]) == int(&d[1]) && int(&r[2]) == int(&d[2]));
            let fine = p.is_some_and(|p| (s.len() - 1 - p) as i64 == int(&d[7]))
                && int(&s.last().unwrap()[0]) == int(&d[3]);
            if !fine {
                mismatch += 1;
            }
        }
    }
    for o in arr(&in_t["origins"]).iter() {
        for a in arr(&o["arrs"]).iter() {
            rows_n += 1;
            let s = scheds.get(int(&a[0]) as usize).map(arr).unwrap_or_default();
            if s.is_empty() {
                missing += 1;
                continue;
            }
            // [t, fs, fc, dep, ts, arr, dur, stops, km]: first stop fs/dep,
            // arrival here is call index `stops`, at ts/arr
            let k = int(&a[7]) as usize;
            let fine = int(&s[0][0]) == int(&a[1])
                && int(&s[0][2]) == int(&a[3])
                && s.get(k)
                    .is_some_and(|r| int(&r[0]) == int(&a[4]) && int(&r[1]) == int(&a[5]));
            if !fine {
                mismatch += 1;
            }
        }
    }
    println!(
        "AUDIT pack schedules: {} trains, extra_stations {extra}, bad station idx {bad_idx}; {rows_n} dep/arr rows: {missing} without schedule, {mismatch} inconsistent",
        scheds.len()
    );
    ok &= extra == 0 && bad_idx == 0 && missing == 0 && mismatch == 0;
    // ---- station-level stops (dep_stop_pos): one position per schedule
    // stop after boarding, monotone, ending at the path end; and every city
    // call is one of those stops (same arrival minute, same position) ----
    let (mut st_total, mut st_bad, mut st_time_back, mut st_rows_extra) = (0i64, 0i64, 0i64, 0i64);
    let mut call_miss = 0i64;
    for o in arr(&out_t["origins"]).iter() {
        let pos_all = arr(&o["dep_stop_pos"]);
        // per dep row: (arrival minute in the calls' frame, path position)
        let mut stops_of: Vec<Vec<(i64, i64)>> = Vec::new();
        for (di, d) in arr(&o["deps"]).iter().enumerate() {
            let pos: Vec<i64> = arr(&pos_all[di]).iter().map(int).collect();
            let len = arr(&o["dep_secs"][di]).len() as i64;
            let sch: Vec<Vec<i64>> = scheds
                .get(int(&d[0]) as usize)
                .map(arr)
                .unwrap_or_default()
                .iter()
                .map(|r| arr(r).iter().take(4).map(int).collect())
                .collect();
            st_total += pos.len() as i64;
            let b = sch.len() as i64 - 1 - int(&d[7]);
            let fine = b >= 0
                && pos.len() as i64 == int(&d[7])
                && pos.windows(2).all(|w| w[0] <= w[1])
                && pos.last() == Some(&len);
            if !fine {
                st_bad += 1;
                stops_of.push(Vec::new());
                continue;
            }
            // schedule minutes (origin-day frame) -> the calls' frame
            let rb = &sch[b as usize];
            let mut dep_b = rb[3] * 1440 + rb[2];
            if rb[1] >= 0 && rb[2] < rb[1] {
                dep_b += 1440;
            }
            let rel = |day: i64, m: i64| day * 1440 + m - dep_b + int(&d[2]);
            // calls count flow sections only (O1): a stop's flow position
            let secs_d = arr(&o["dep_secs"][di]);
            let mut times: Vec<i64> = Vec::new();
            let mut row: Vec<(i64, i64)> = Vec::new();
            for (i, p) in pos.iter().enumerate() {
                let r = &sch[b as usize + 1 + i];
                let a = rel(r[3], r[1]);
                times.push(a);
                if r[2] >= 0 && i + 1 < pos.len() {
                    times.push(rel(r[3] + i64::from(r[2] < r[1]), r[2]));
                }
                row.push((a, flow_len(&secs_d[..*p as usize], n_out)));
            }
            if times.windows(2).any(|w| w[1] < w[0]) {
                st_time_back += 1;
            }
            stops_of.push(row);
        }
        let mut n_calls: HashMap<usize, usize> = HashMap::new();
        for cell in arr(&o["calls"]).iter() {
            for r in arr(cell).iter() {
                let di = int(&r[0]) as usize;
                *n_calls.entry(di).or_default() += 1;
                let arr_t = int(&r[3]) * 1440 + int(&r[1]);
                if !stops_of[di]
                    .iter()
                    .any(|&(a, p)| a == arr_t && p == int(&r[5]))
                {
                    call_miss += 1;
                }
            }
        }
        for (di, s) in stops_of.iter().enumerate() {
            if s.len() > n_calls.get(&di).copied().unwrap_or(0) {
                st_rows_extra += 1;
            }
        }
    }
    println!(
        "AUDIT pack dep_stop_pos: {st_total} station stops; {st_bad} rows inconsistent (count/order/path end), {st_time_back} with times going back, {call_miss} city calls not matching a stop; {st_rows_extra} dep rows have stations without a city call"
    );
    ok &= st_bad == 0 && call_miss == 0;
    let mut g: BTreeMap<String, i64> = BTreeMap::new();
    g.insert("dep_stops_total".into(), st_total);
    g.insert("dep_rows_with_uncalled_stations".into(), st_rows_extra);
    g.insert("dep_stops_time_regressions".into(), st_time_back);
    let n = |v: &Value| arr(v).len() as i64;
    g.insert("origins".into(), n(&out_map["origins"]));
    g.insert("sections".into(), n(&shared["sections"]));
    g.insert("in_sections".into(), n(&shared["in_sections"]));
    g.insert("schedules_trains".into(), scheds.len() as i64);
    g.insert("chord_leg_rows".into(), chord_legs as i64);
    g.insert("continuity_gaps_le6km".into(), throat_gaps as i64);
    g.insert("continuity_gaps_gt6km".into(), (gaps - throat_gaps) as i64);
    g.insert("continuity_gaps_gt100m".into(), gaps_100m as i64);
    g.insert("throats".into(), throat_ends.len() as i64);
    g.insert("dep_rows_jump_gt35km_outside_chords".into(), jump_out);
    g.insert("dep_rows_jump_gt35km_inside_chords".into(), jump_in);
    g.insert("nonmonotone_sec_cnt_trains".into(), non_mono.len() as i64);
    // Chengdu goldens (PIPELINE.md section 7 shape)
    let cities: Vec<String> = arr(&shared["city_table"])
        .iter()
        .map(|c| c["zh"].as_str().unwrap().to_string())
        .collect();
    if let Some(ci) = zh.iter().position(|z| z == "成都") {
        let (om, im) = (&out_map["origins"][ci], &in_map["origins"][ci]);
        let widest = |f: &Value| arr(f).iter().map(|r| int(&r[1])).max().unwrap_or(0);
        let cq = |rows: &Value| -> Vec<i64> {
            arr(rows)
                .iter()
                .find(|r| cities[int(&r[0]) as usize] == "重庆")
                .map(|r| arr(r).iter().map(int).collect())
                .unwrap_or_default()
        };
        let (dq, sq) = (cq(&om["dests"]), cq(&im["srcs"]));
        for (k, v) in [
            ("out", int(&om["outbound"])),
            ("dests", n(&om["dests"])),
            ("widest_out", widest(&om["flows"])),
            ("fully_tracked", int(&om["fully_tracked"])),
            ("chords", n(&om["chords"])),
            ("in", int(&om["inbound"])),
            ("srcs", n(&im["srcs"])),
            ("widest_in", widest(&im["in_flows"])),
            ("cq_out", dq.get(1).copied().unwrap_or(-1)),
            ("cq_out_term", dq.get(3).copied().unwrap_or(-1)),
            ("cq_out_fastest", dq.get(4).copied().unwrap_or(-1)),
            ("cq_in", sq.get(1).copied().unwrap_or(-1)),
            ("cq_in_orig", sq.get(3).copied().unwrap_or(-1)),
            ("cq_in_fastest", sq.get(4).copied().unwrap_or(-1)),
        ] {
            g.insert(format!("chengdu_{k}"), v);
        }
    }
    println!(
        "AUDIT pack hard checks: {}",
        if ok { "PASS" } else { "FAIL" }
    );
    (ok, g)
}

/// Gate the pack counters against goldens.json: {"exact": {k: v}, "max":
/// {k: v}}. An exact counter must match; a max counter must not rise.
/// `--update-goldens` rewrites the file with the current values (keys
/// keep their class; new keys go to "max"). Returns false on a breach.
fn gate_goldens(path: &Path, cur: &BTreeMap<String, i64>, update: bool, partial: bool) -> bool {
    let text = fs::read_to_string(path).ok();
    if text.is_none() && !update {
        println!(
            "AUDIT goldens FAIL: {} not found (create it with --update-goldens)",
            path.display()
        );
        return false;
    }
    let old: Value = text
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({ "exact": {}, "max": {} }));
    if update {
        let mut out = old.clone();
        for (k, v) in cur {
            let class = if old["exact"].get(k).is_some() {
                "exact"
            } else {
                "max"
            };
            out[class][k] = serde_json::json!(v);
        }
        fs::write(path, serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
        println!("AUDIT goldens: updated {}", path.display());
        return true;
    }
    let mut ok = true;
    for class in ["exact", "max"] {
        for (k, want) in old[class].as_object().into_iter().flatten() {
            let want = want.as_i64().unwrap();
            if partial && !cur.contains_key(k) {
                println!("AUDIT goldens skipped {k} (not computed with --pack-only)");
                continue;
            }
            let breach = match cur.get(k) {
                None => true,
                Some(&got) => (class == "exact" && got != want) || (class == "max" && got > want),
            };
            if breach {
                ok = false;
                println!(
                    "AUDIT goldens BREACH {class} {k}: golden {want}, now {:?}",
                    cur.get(k)
                );
            } else if cur[k] != want {
                println!(
                    "AUDIT goldens improved {k}: {want} -> {} (rebase with --update-goldens)",
                    cur[k]
                );
            }
        }
    }
    println!("AUDIT goldens gate: {}", if ok { "PASS" } else { "FAIL" });
    ok
}

/// Gate `counters` against `--goldens <path>` (default ./goldens.json);
/// `--update-goldens` rebases instead. `partial`: the legacy counters were
/// not computed (`--pack-only`), so golden keys missing here are skipped.
fn run_goldens_gate(counters: &BTreeMap<String, i64>, partial: bool) -> bool {
    let args: Vec<String> = env::args().collect();
    let goldens = args
        .windows(2)
        .find(|w| w[0] == "--goldens")
        .map(|w| PathBuf::from(&w[1]))
        .unwrap_or_else(|| PathBuf::from("goldens.json"));
    gate_goldens(
        &goldens,
        counters,
        args.iter().any(|a| a == "--update-goldens"),
        partial,
    )
}

fn main() {
    let mut pack: Option<(bool, BTreeMap<String, i64>)> = None;
    if let Ok(dir) = env::var("AUDIT_PACK_DIR") {
        let r = audit_pack(Path::new(&dir));
        if env::args().any(|a| a == "--pack-only") {
            let ok = r.0 & run_goldens_gate(&r.1, true);
            std::process::exit(if ok { 0 } else { 1 });
        }
        pack = Some(r);
    }
    let inp = inputs::load();
    let override_map = &inp.override_map;
    let trains = &inp.trains;
    let d1_len = inp.d1_len;
    let path_map = &inp.path_map;
    let coords = &inp.coords;
    let en = |c: &str| -> String { inp.en(c) };
    let station_pt = |name: &str| -> Option<[f64; 2]> { inp.stations.point(name) };

    let seg_coords = |ids: &[i64]| -> Vec<[f64; 2]> {
        ids.iter()
            .filter_map(|id| coords.get(id).copied())
            .collect()
    };

    // ---- precompute per-train names/cities ----
    let train_names: Vec<Vec<String>> = trains
        .iter()
        .map(|t| t.stops.iter().map(|s| clean(&s.name)).collect())
        .collect();
    let train_cities: Vec<Vec<String>> = train_names
        .iter()
        .map(|ns| ns.iter().map(|n| city_of(n)).collect())
        .collect();

    // ---- rank cities by outbound trains ----
    let mut outbound_count: HashMap<String, u64> = HashMap::new();
    for cities in train_cities.iter() {
        let mut seen: HashSet<&str> = HashSet::new();
        for (i, c) in cities.iter().enumerate() {
            if i + 1 < cities.len() && seen.insert(c.as_str()) {
                *outbound_count.entry(c.clone()).or_insert(0) += 1;
            }
        }
    }
    let mut ranked: Vec<(String, u64)> = outbound_count.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let top_n = 100usize;
    let mut selected: Vec<String> = ranked.iter().take(top_n).map(|(c, _)| c.clone()).collect();
    for (zh, en) in FEATURED_ORIGINS {
        if !selected.iter().any(|c| c == zh) {
            if let Some((_, n)) = ranked.iter().find(|(c, _)| c == zh) {
                println!(
                    "Adding {en} ({zh}) as a special featured origin city ({n} outbound trains)"
                );
                selected.push(zh.to_string());
            }
        }
    }
    println!("TOP {} CITIES BY OUTBOUND TRAINS:", top_n);
    for (i, (c, n)) in ranked.iter().take(top_n).enumerate() {
        println!("  {:>2}. {} {} - {}", i + 1, c, en(c), n);
    }

    // ---- global station stop counts per city -> principal points ----
    let mut city_stations: HashMap<String, HashMap<String, (u64, usize)>> = HashMap::new();
    let mut cs_counter = 0usize;
    for (ti, _) in trains.iter().enumerate() {
        for (i, nm) in train_names[ti].iter().enumerate() {
            let e = city_stations
                .entry(train_cities[ti][i].clone())
                .or_default()
                .entry(nm.clone())
                .or_insert_with(|| {
                    let v = cs_counter;
                    cs_counter += 1;
                    (0, v)
                });
            e.0 += 1;
        }
    }
    let mut city_pt: HashMap<String, [f64; 2]> = HashMap::new(); // [lat, lon]
    for (cty, sts) in city_stations.iter() {
        let mut ordered: Vec<(&String, &(u64, usize))> = sts.iter().collect();
        ordered.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.1 .1.cmp(&b.1 .1)));
        for (nm, _) in ordered {
            if let Some(p) = station_pt(nm) {
                city_pt.insert(cty.clone(), p);
                break;
            }
        }
        if let Some(p) = city_point_override(cty) {
            city_pt.insert(cty.clone(), p);
        }
    }

    // ---- corridor graph (shared by all cities) ----
    let pair_len: HashMap<(String, String), f64> = path_map
        .iter()
        .filter(|(_, (_, segs))| segs.iter().any(|s| s.len() >= 2))
        .map(|(k, (_, segs))| {
            let l: f64 = segs
                .iter()
                .map(|s| {
                    let c = seg_coords(s);
                    c.windows(2).map(|w| hav_km_ll(w[0], w[1])).sum::<f64>()
                })
                .sum();
            (k.clone(), l)
        })
        .collect();
    let mut adj_pure: CorridorAdj = HashMap::new();
    let mut adj: CorridorAdj = HashMap::new();
    let mut pair_lens: Vec<(&(String, String), &f64)> = pair_len.iter().collect();
    pair_lens.sort_by(|a, b| a.0.cmp(b.0));
    for (k, l) in pair_lens {
        adj_pure
            .entry(k.0.clone())
            .or_default()
            .push((k.1.clone(), Some(k.clone()), *l));
        adj_pure
            .entry(k.1.clone())
            .or_default()
            .push((k.0.clone(), Some(k.clone()), *l));
        adj.entry(k.0.clone())
            .or_default()
            .push((k.1.clone(), Some(k.clone()), *l));
        adj.entry(k.1.clone())
            .or_default()
            .push((k.0.clone(), Some(k.clone()), *l));
    }
    {
        let mut all_stations: HashSet<String> = HashSet::new();
        for (a, b) in path_map.keys() {
            all_stations.insert(a.clone());
            all_stations.insert(b.clone());
        }
        let mut by_city: HashMap<String, Vec<String>> = HashMap::new();
        for s in all_stations.iter() {
            by_city.entry(city_of(s)).or_default().push(s.clone());
        }
        let mut by_city: Vec<(String, Vec<String>)> = by_city.into_iter().collect();
        by_city.sort();
        for (_, sts) in by_city.iter_mut() {
            sts.sort();
            if sts.len() < 2 || sts.len() > 12 {
                continue;
            }
            for i in 0..sts.len() {
                for j in (i + 1)..sts.len() {
                    if let (Some(p), Some(q)) = (station_pt(&sts[i]), station_pt(&sts[j])) {
                        let w = hav_km_ll([p[1], p[0]], [q[1], q[0]]) * 2.0 + 2.0;
                        if w > 60.0 {
                            continue;
                        }
                        adj.entry(sts[i].clone())
                            .or_default()
                            .push((sts[j].clone(), None, w));
                        adj.entry(sts[j].clone())
                            .or_default()
                            .push((sts[i].clone(), None, w));
                    }
                }
            }
        }
    }
    let mut leg_cache: HashMap<(String, String), Option<Vec<Vec<i64>>>> = HashMap::new();
    let mut variant_cache: VariantCache = HashMap::new();
    let mut variant_stats: (u64, u64) = (0, 0);

    // ---- interning tables (filled during assembly) ----
    let _city_table: Vec<AtlasCity> = Vec::new();
    let _city_idx: HashMap<String, i64> = HashMap::new();
    let _station_table: Vec<AtlasStation> = Vec::new();
    let _station_idx: HashMap<String, i64> = HashMap::new();
    let _train_table: Vec<AtlasTrainRef> = Vec::new();
    let _train_idx: HashMap<(String, String), usize> = HashMap::new();

    // ---- per-city work ----
    // Mirrors atlas.rs's data model; the audit reads only the flow fields.
    #[allow(dead_code)]
    struct DepRaw {
        code: String,
        class: String,
        from_station: String,
        depart: String,
        to_station: String,
        to_city: String,
        arrive: String,
        dur: Option<i64>,
        stops_after: u64,
        set: u8,
    }
    #[allow(dead_code)]
    struct CityWork {
        zh: String,
        outbound: u64,
        fully_tracked: u64,
        legs: Vec<((String, String, String), u64)>,
        dests: Vec<(String, DestStats)>,
        deps: Vec<DepRaw>,
        home_pt: [f64; 2],
        train_leg_keys: Vec<Vec<(String, String, String)>>,
        train_cls: Vec<usize>,
    }
    let mut works: Vec<CityWork> = Vec::new();
    let mut throat_stations: HashSet<String> = HashSet::new();
    for home_city in selected.iter() {
        let mut out_stats: HashMap<String, DestStats> = HashMap::new();
        let mut counter = 0usize;
        let mut leg_count: HashMap<(String, String, String), u64> = HashMap::new();
        let mut deps: Vec<DepRaw> = Vec::new();
        let mut outbound = 0u64;
        let mut train_legs: Vec<Vec<(String, String, String)>> = Vec::new();
        let mut train_cls: Vec<usize> = Vec::new();
        for (ti, t) in trains.iter().enumerate() {
            let names = &train_names[ti];
            let cities = &train_cities[ti];
            let cd_idx = match cities.iter().position(|c| c == home_city) {
                Some(i) => i,
                None => continue,
            };
            if cd_idx + 1 >= cities.len() {
                continue;
            }
            outbound += 1;
            let is_fast = ["G", "D", "C", "S"].contains(&t.train_class.as_str());
            let final_city = cities.last().unwrap().clone();
            deps.push(DepRaw {
                code: t.code.clone(),
                class: t.train_class.clone(),
                from_station: names[cd_idx].clone(),
                depart: t.stops[cd_idx].depart.clone(),
                to_station: names.last().unwrap().clone(),
                to_city: final_city.clone(),
                arrive: t.stops.last().unwrap().arrive.clone(),
                dur: travel_time(&t.stops, cd_idx, t.stops.len() - 1),
                stops_after: (t.stops.len() - 1 - cd_idx) as u64,
                set: if ti < d1_len { 0 } else { 1 },
            });
            let mut seen_dest: HashSet<String> = HashSet::new();
            let mut cum_km = 0f64;
            let mut cum_ok = true;
            let mut last_k = cd_idx;
            // j walks cities/names/stops in lockstep; the index is the join.
            #[allow(clippy::needless_range_loop)]
            for j in (cd_idx + 1)..cities.len() {
                // extend cumulative track distance from stop last_k to stop j
                while last_k < j {
                    let (a, b) = (names[last_k].clone(), names[last_k + 1].clone());
                    if a != b {
                        match leg_km(override_map, &pair_len, t, &a, &b) {
                            Some(l) => cum_km += l,
                            None => cum_ok = false,
                        }
                    }
                    last_k += 1;
                }
                if &cities[j] == home_city || !seen_dest.insert(cities[j].clone()) {
                    continue;
                }
                let dest = cities[j].clone();
                let e = out_stats.entry(dest.clone()).or_insert_with(|| {
                    let v = counter;
                    counter += 1;
                    DestStats {
                        first: v,
                        ..Default::default()
                    }
                });
                e.total += 1;
                if is_fast {
                    e.fast += 1;
                }
                if final_city == dest {
                    e.terminating += 1;
                }
                if let Some(tt) = travel_time(&t.stops, cd_idx, j) {
                    if tt > 0 && tt < 6000 {
                        e.times.push(tt);
                    }
                }
                if cum_ok && cum_km > 0.0 {
                    e.rail.push(cum_km);
                }
            }
            let mut legs: Vec<(String, String, String)> = Vec::new();
            for j in cd_idx..(names.len() - 1) {
                let (a, b) = (names[j].clone(), names[j + 1].clone());
                if a == b {
                    continue;
                }
                let key = leg_key3(override_map, t, &a, &b);
                *leg_count.entry(key.clone()).or_insert(0) += 1;
                legs.push(key);
            }
            train_legs.push(legs);
            train_cls.push(class_idx(&t.train_class));
        }
        let mut legs_vec: Vec<((String, String, String), u64)> = Vec::new();
        let mut resolved_flags: HashMap<(String, String, String), bool> = HashMap::new();
        for (k, n) in leg_count.iter() {
            let r = resolve_leg3(
                k,
                path_map,
                &adj_pure,
                &adj,
                &pair_len,
                &station_pt,
                &mut leg_cache,
                &mut variant_cache,
                &mut variant_stats,
            );
            resolved_flags.insert(k.clone(), r.is_some());
            legs_vec.push((k.clone(), *n));
            throat_stations.insert(k.0.clone());
            throat_stations.insert(k.1.clone());
        }
        let mut fully = 0u64;
        for legs in train_legs.iter() {
            if legs
                .iter()
                .all(|k| resolved_flags.get(k).copied().unwrap_or(false))
            {
                fully += 1;
            }
        }
        deps.sort_by(|x, y| x.depart.cmp(&y.depart).then(x.code.cmp(&y.code)));
        let mut dests: Vec<(String, DestStats)> = out_stats.into_iter().collect();
        dests.sort_by(|a, b| b.1.total.cmp(&a.1.total).then(a.1.first.cmp(&b.1.first)));
        let hp = city_pt.get(home_city).copied().unwrap_or([30.63, 104.13]);
        println!(
            "{}: outbound {} dests {} legs {} fully {}",
            home_city,
            outbound,
            dests.len(),
            legs_vec.len(),
            fully
        );
        works.push(CityWork {
            zh: home_city.clone(),
            outbound,
            fully_tracked: fully,
            legs: legs_vec,
            dests,
            deps,
            home_pt: [hp[1], hp[0]],
            train_leg_keys: train_legs,
            train_cls,
        });
    }

    // ---- global atomic sections over the union of all selected cities ----
    let mut station_grid: HashMap<(i32, i32), Vec<[f64; 2]>> = HashMap::new();
    for nm in throat_stations.iter() {
        if let Some(p) = station_pt(nm) {
            let ll = [p[1], p[0]];
            station_grid
                .entry(((ll[0] * 50.0).floor() as i32, (ll[1] * 50.0).floor() as i32))
                .or_default()
                .push(ll);
        }
    }
    let near_station = |pt: &[f64; 2]| -> bool {
        let gx = (pt[0] * 50.0).floor() as i32;
        let gy = (pt[1] * 50.0).floor() as i32;
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(cell) = station_grid.get(&(gx + dx, gy + dy)) {
                    for c in cell {
                        if hav_km_ll(*pt, *c) < 1.3 {
                            return true;
                        }
                    }
                }
            }
        }
        false
    };
    // atomic edge -> per-city DISTINCT train counts (dedup, as production)
    let mut edge_counts: HashMap<(i64, i64), HashMap<usize, u64>> = HashMap::new();
    let mut edge_class_counts: HashMap<(i64, i64), HashMap<usize, [u32; 8]>> = HashMap::new();
    for (ci, w) in works.iter().enumerate() {
        for (legs, cidx) in w.train_leg_keys.iter().zip(w.train_cls.iter()) {
            let mut eset: HashSet<(i64, i64)> = HashSet::new();
            for key in legs.iter() {
                let seqs = match leg_seqs(key, &leg_cache, &variant_cache) {
                    Some(s) => s,
                    _ => continue,
                };
                for s in seqs.iter() {
                    for win in s.windows(2) {
                        let (c1, c2) = match (coords.get(&win[0]), coords.get(&win[1])) {
                            (Some(x), Some(y)) => (*x, *y),
                            _ => continue,
                        };
                        let mid = [(c1[0] + c2[0]) / 2.0, (c1[1] + c2[1]) / 2.0];
                        if near_station(&mid) {
                            continue;
                        }
                        eset.insert(if win[0] < win[1] {
                            (win[0], win[1])
                        } else {
                            (win[1], win[0])
                        });
                    }
                }
            }
            for e in eset {
                *edge_counts.entry(e).or_default().entry(ci).or_insert(0) += 1;
                edge_class_counts
                    .entry(e)
                    .or_default()
                    .entry(ci)
                    .or_insert([0; 8])[*cidx] += 1;
            }
        }
    }
    println!("union atomic edges: {}", edge_counts.len());
    // intern count signatures: a global section has constant per-city counts
    let (sig_list, edge_sig) = chains::intern_sigs(&edge_counts, &edge_class_counts);
    println!("distinct signatures: {}", sig_list.len());
    let section_chains = chains::build_section_chains(&edge_sig);
    // section endpoint station names (nearest real station point)
    let mut station_pts_all: HashMap<String, [f64; 2]> = HashMap::new();
    for (a, b) in path_map.keys() {
        for s in [a, b] {
            if let Some(p) = station_pt(s) {
                station_pts_all.insert(s.clone(), [p[1], p[0]]);
            }
        }
    }
    let nearest_station = |pt: [f64; 2]| -> String {
        let mut best: Option<(&String, f64)> = None;
        for (nm, sp) in station_pts_all.iter() {
            let d = hav_km_ll(pt, *sp);
            if d < 5.0 && best.is_none_or(|(bn, bd)| d < bd || (d == bd && nm < bn)) {
                best = Some((nm, d));
            }
        }
        best.map(|(nm, _)| nm.clone()).unwrap_or_default()
    };
    let mut sections: Vec<AtlasSection> = Vec::new();
    let mut flows_per_city: Vec<Vec<[usize; 2]>> = vec![Vec::new(); works.len()];
    let mut total_sec_pts = 0usize;
    for (sid, chain) in section_chains.iter() {
        let raw: Vec<[f64; 2]> = chain
            .iter()
            .filter_map(|id| coords.get(id).copied())
            .collect();
        if raw.len() < 2 {
            continue;
        }
        let simp = dp_keep(&raw, 0.00035);
        let simp: Vec<[f64; 2]> = simp.iter().map(|p| round_pt(*p, 4)).collect();
        if simp.len() < 2 {
            continue;
        }
        total_sec_pts += simp.len();
        let sec_idx = sections.len();
        // Endpoint station names are an atlas concern; the audit leaves
        // them unset and checks counts and geometry instead.
        sections.push(AtlasSection {
            a: -1,
            b: -1,
            g: polyline_encode(&simp),
        });
        for (ci, n, _) in sig_list[*sid as usize].iter() {
            flows_per_city[*ci].push([sec_idx, *n as usize]);
        }
    }
    for f in flows_per_city.iter_mut() {
        f.sort_by(|a, b| b[1].cmp(&a[1]));
    }
    println!("sections: {} points: {}", sections.len(), total_sec_pts);

    // ================= AUDIT (standalone bin) =================
    // chain-level flows from signatures
    let n_chains = section_chains.len();
    // dropped chains: geometry missing -> counts lost in JSON output
    let mut dropped_flow = 0u64;
    let mut dropped_chains = 0usize;
    for (sid, chain) in section_chains.iter() {
        let raw_n = chain.iter().filter(|id| coords.contains_key(id)).count();
        if raw_n < 2 {
            dropped_chains += 1;
            for (_, n, _) in sig_list[*sid as usize].iter() {
                dropped_flow += n;
            }
        }
    }
    println!(
        "AUDIT dropped chains (no geometry): {} (flow lost {})",
        dropped_chains, dropped_flow
    );
    // edge -> chain
    let mut edge_to_chain: HashMap<(i64, i64), usize> = HashMap::new();
    for (ci2, (_, chain)) in section_chains.iter().enumerate() {
        for w in chain.windows(2) {
            let e = if w[0] < w[1] {
                (w[0], w[1])
            } else {
                (w[1], w[0])
            };
            edge_to_chain.insert(e, ci2);
        }
    }
    // per-train dedup recount vs signature flows
    let mut total_diff_sections = 0usize;
    let mut worst: Vec<(String, i64, usize)> = Vec::new();
    for (ci, w) in works.iter().enumerate() {
        // signature flows per chain
        let mut sig_flow: HashMap<usize, u64> = HashMap::new();
        for (ch, (sid, _)) in section_chains.iter().enumerate() {
            for (c2, n, _) in sig_list[*sid as usize].iter() {
                if *c2 == ci {
                    sig_flow.insert(ch, *n);
                }
            }
        }
        // dedup recount: per train, set of chains its edges touch
        let mut recount: HashMap<usize, u64> = HashMap::new();
        for legs in w.train_leg_keys.iter() {
            let mut hit: HashSet<usize> = HashSet::new();
            for key in legs.iter() {
                if let Some(seqs) = leg_seqs(key, &leg_cache, &variant_cache) {
                    for s in seqs.iter() {
                        for win in s.windows(2) {
                            let (c1, c2) = match (coords.get(&win[0]), coords.get(&win[1])) {
                                (Some(x), Some(y)) => (*x, *y),
                                _ => continue,
                            };
                            let mid = [(c1[0] + c2[0]) / 2.0, (c1[1] + c2[1]) / 2.0];
                            if near_station(&mid) {
                                continue;
                            }
                            let e = if win[0] < win[1] {
                                (win[0], win[1])
                            } else {
                                (win[1], win[0])
                            };
                            if let Some(ch) = edge_to_chain.get(&e) {
                                hit.insert(*ch);
                            }
                        }
                    }
                }
            }
            for ch in hit {
                *recount.entry(ch).or_insert(0) += 1;
            }
        }
        let mut diffs = 0usize;
        let mut maxd = 0i64;
        let keys: HashSet<usize> = sig_flow.keys().chain(recount.keys()).copied().collect();
        for ch in keys {
            let a = sig_flow.get(&ch).copied().unwrap_or(0) as i64;
            let b = recount.get(&ch).copied().unwrap_or(0) as i64;
            if a != b {
                diffs += 1;
                if (a - b).abs() > maxd {
                    maxd = (a - b).abs();
                }
            }
        }
        total_diff_sections += diffs;
        worst.push((w.zh.clone(), maxd, diffs));
        println!(
            "AUDIT dedup {}: chains differing {}, max |diff| {}",
            w.zh, diffs, maxd
        );
    }
    println!(
        "AUDIT dedup total differing chains: {}",
        total_diff_sections
    );
    // decompose the single worst chain overall
    {
        let mut best: Option<(usize, usize, i64, u64, u64)> = None; // ci, chain, diff, sig, recount
        for (ci, w) in works.iter().enumerate() {
            let mut sig_flow: HashMap<usize, u64> = HashMap::new();
            for (ch, (sid, _)) in section_chains.iter().enumerate() {
                for (c2, n, _) in sig_list[*sid as usize].iter() {
                    if *c2 == ci {
                        sig_flow.insert(ch, *n);
                    }
                }
            }
            let mut recount: HashMap<usize, u64> = HashMap::new();
            let mut touches: HashMap<usize, HashMap<usize, u32>> = HashMap::new(); // chain -> train idx -> legs touching
            for (ti2, legs) in w.train_leg_keys.iter().enumerate() {
                let mut hit: HashMap<usize, u32> = HashMap::new();
                for key in legs.iter() {
                    if let Some(seqs) = leg_seqs(key, &leg_cache, &variant_cache) {
                        for s2 in seqs.iter() {
                            for win in s2.windows(2) {
                                let (c1, c2b) = match (coords.get(&win[0]), coords.get(&win[1])) {
                                    (Some(x), Some(y)) => (*x, *y),
                                    _ => continue,
                                };
                                let mid = [(c1[0] + c2b[0]) / 2.0, (c1[1] + c2b[1]) / 2.0];
                                if near_station(&mid) {
                                    continue;
                                }
                                let e = if win[0] < win[1] {
                                    (win[0], win[1])
                                } else {
                                    (win[1], win[0])
                                };
                                if let Some(ch) = edge_to_chain.get(&e) {
                                    *hit.entry(*ch).or_insert(0) += 1;
                                }
                            }
                        }
                    }
                }
                for ch in hit.keys() {
                    *recount.entry(*ch).or_insert(0) += 1;
                }
                for (ch, cnt) in hit.iter() {
                    touches.entry(*ch).or_default().insert(ti2, *cnt);
                }
            }
            let keys: HashSet<usize> = sig_flow.keys().chain(recount.keys()).copied().collect();
            for ch in keys {
                let a = sig_flow.get(&ch).copied().unwrap_or(0);
                let b = recount.get(&ch).copied().unwrap_or(0);
                let df = (a as i64 - b as i64).abs();
                if best.is_none_or(|(_, _, bd, _, _)| df > bd) {
                    best = Some((ci, ch, df, a, b));
                }
            }
            if ci == 4 {
                // Changsha deep-dive printed below via best if it is the worst
            }
            let _ = touches;
        }
        if let Some((ci, ch, df, a, b)) = best {
            let w = &works[ci];
            let chain = &section_chains[ch].1;
            let p0 = coords.get(&chain[0]).copied().unwrap_or([0.0, 0.0]);
            let p1 = coords
                .get(chain.last().unwrap())
                .copied()
                .unwrap_or([0.0, 0.0]);
            println!("WORST chain: origin {} chain {} sig {} recount {} diff {} ends near {} .. {} nodes {}",
                w.zh, ch, a, b, df, nearest_station(p0), nearest_station(p1), chain.len());
            // which legs contribute, and how many of their trains touch the chain in >1 leg
            let chain_edges: HashSet<(i64, i64)> = chain
                .windows(2)
                .map(|w2| {
                    if w2[0] < w2[1] {
                        (w2[0], w2[1])
                    } else {
                        (w2[1], w2[0])
                    }
                })
                .collect();
            let mut legstat: HashMap<(String, String, String), (u64, u64)> = HashMap::new(); // leg -> (trains using leg, trains whose THIS leg touches chain)
            for legs in w.train_leg_keys.iter() {
                let mut counted: HashSet<(String, String, String)> = HashSet::new();
                for key in legs.iter() {
                    if counted.contains(key) {
                        continue;
                    }
                    let touch = if let Some(seqs) = leg_seqs(key, &leg_cache, &variant_cache) {
                        seqs.iter().any(|s2| {
                            s2.windows(2).any(|win| {
                                let e = if win[0] < win[1] {
                                    (win[0], win[1])
                                } else {
                                    (win[1], win[0])
                                };
                                chain_edges.contains(&e)
                            })
                        })
                    } else {
                        false
                    };
                    let e = legstat.entry(key.clone()).or_insert((0, 0));
                    e.0 += 1;
                    if touch {
                        e.1 += 1;
                    }
                    counted.insert(key.clone());
                }
            }
            let mut rows: Vec<_> = legstat.into_iter().filter(|(_, (_, t))| *t > 0).collect();
            rows.sort_by_key(|x| std::cmp::Reverse(x.1 .1));
            for (k, (tot, t)) in rows.iter().take(10) {
                println!(
                    "   leg {} -> {} trains-on-leg {} touching-chain {}",
                    k.0, k.1, tot, t
                );
            }
        }
    }
    // junction balance: a section may not carry more than all other incident
    // sections at a junction plus trains terminating at that junction's city
    let mut node_chains: HashMap<i64, Vec<usize>> = HashMap::new();
    for (ch, (_, chain)) in section_chains.iter().enumerate() {
        node_chains.entry(chain[0]).or_default().push(ch);
        node_chains
            .entry(*chain.last().unwrap())
            .or_default()
            .push(ch);
    }
    let mut flags = 0usize;
    for (ci, w) in works.iter().enumerate() {
        let term_by_city: HashMap<String, u64> = w
            .dests
            .iter()
            .map(|(zh, s)| (zh.clone(), s.terminating))
            .collect();
        let mut sig_flow: HashMap<usize, u64> = HashMap::new();
        for (ch, (sid, _)) in section_chains.iter().enumerate() {
            for (c2, n, _) in sig_list[*sid as usize].iter() {
                if *c2 == ci {
                    sig_flow.insert(ch, *n);
                }
            }
        }
        for (node, chs) in node_chains.iter() {
            if chs.len() < 2 {
                continue;
            }
            let counts: Vec<u64> = chs
                .iter()
                .map(|ch| sig_flow.get(ch).copied().unwrap_or(0))
                .collect();
            let m = *counts.iter().max().unwrap_or(&0);
            if m == 0 {
                continue;
            }
            let s: u64 = counts.iter().sum::<u64>() - m;
            // termination credit: city of nearest station to this junction
            let credit = match coords.get(node) {
                Some(pt) => {
                    let nm = nearest_station(*pt);
                    if nm.is_empty() {
                        0
                    } else {
                        let cty = city_of(&nm);
                        if cty == w.zh {
                            w.outbound
                        } else {
                            term_by_city.get(&cty).copied().unwrap_or(0)
                        }
                    }
                }
                None => 0,
            };
            if m > s + credit + 2 {
                flags += 1;
                if flags <= 15 {
                    println!(
                        "AUDIT junction flag {}: node {} max {} others {} credit {}",
                        w.zh, node, m, s, credit
                    );
                }
            }
        }
    }
    println!(
        "AUDIT variant legs: {} resolved via override tiling, {} fell back to base pair geometry",
        variant_stats.0, variant_stats.1
    );
    println!("AUDIT junction flags total: {}", flags);
    println!("AUDIT chains total: {}", n_chains);
    if let Some((ok, mut counters)) = pack {
        counters.insert("dropped_chains".into(), dropped_chains as i64);
        counters.insert("flow_lost".into(), dropped_flow as i64);
        let ok = ok & run_goldens_gate(&counters, false);
        std::process::exit(if ok { 0 } else { 1 });
    }
}
