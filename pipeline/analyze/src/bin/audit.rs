use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use analyze_rs::chains;
use analyze_rs::cn::*;
use analyze_rs::entries;
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
    // every city point is a real place in China's box (a [0,0] point once
    // stretched the client's fitted extent to the Gulf of Guinea)
    let bad_city_pts: Vec<String> = arr(&shared["city_table"])
        .iter()
        .filter(|c| {
            let (lon, lat) = (c["pt"][0].as_f64(), c["pt"][1].as_f64());
            !matches!((lon, lat), (Some(x), Some(y))
                if (70.0..=140.0).contains(&x) && (15.0..=56.0).contains(&y))
        })
        .map(|c| c["zh"].as_str().unwrap_or("?").to_string())
        .collect();
    println!(
        "AUDIT pack city points outside lon 70-140 / lat 15-56: {} {bad_city_pts:?}",
        bad_city_pts.len()
    );
    ok &= bad_city_pts.is_empty();
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
    // and outbound rows with a > 20 km jump outside chord legs (report only)
    let mut jump20_out = 0i64;
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
                let (mut j_in, mut j_out, mut j20_out) = (false, false, false);
                for k in 1..path.len() {
                    let gap = hav_km_ll(oriented(path[k - 1]).1, oriented(path[k]).0);
                    if exempt.contains(&k) {
                        j_in |= gap > 35.0;
                        continue;
                    }
                    j_out |= gap > 35.0;
                    j20_out |= gap > 20.0;
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
                    jump20_out += j20_out as i64;
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
    println!("AUDIT pack outbound rows with a > 20 km jump: {jump20_out} outside chord legs");
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
    ok &= audit_national(dir, &shared, &out_map, &out_t, &mut g);
    ok &= audit_national_trains(dir, &shared, &out_t, &in_t, &sch, &mut g);
    ok &= audit_national_entries(dir, &shared, &sch, &mut g);
    ok &= audit_national_cities(dir, &shared, &out_map, &mut g);
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

/// P3.1 national table (`atlas-v2-national.json`; skipped while a pack has
/// none). Hard checks: section-parallel shape and `fmt`; classes sum to the
/// total; never below any origin's flow row (total and per class) on the
/// same section; and never below an independent recount from out-tables'
/// per-train `paths` (distinct trains whose path enters the section). The
/// recount is a lower bound, not an equality: the national table also
/// counts track a train runs before its first selected-city departure
/// (from its inbound legs), which no outbound path holds.
fn audit_national(
    dir: &Path,
    shared: &Value,
    out_map: &Value,
    out_t: &Value,
    g: &mut BTreeMap<String, i64>,
) -> bool {
    let name = "atlas-v2-national.json";
    if !pack::exists(dir, name) {
        println!("AUDIT national: no {name} in this pack, skipped");
        return true;
    }
    let nat = pack::read_json(dir, name);
    let ints = |v: &Value| -> Vec<i64> {
        v.as_array()
            .map(|a| a.iter().map(|x| x.as_i64().unwrap()).collect())
            .unwrap_or_default()
    };
    let n = shared["sections"].as_array().unwrap().len();
    let total = ints(&nat["total"]);
    let by_class: Vec<Vec<i64>> = nat["by_class"]
        .as_array()
        .map(|a| a.iter().map(ints).collect())
        .unwrap_or_default();
    let fmt = nat["fmt"].as_i64();
    if fmt != Some(6)
        || total.len() != n
        || by_class.len() != 8
        || by_class.iter().any(|c| c.len() != n)
    {
        println!(
            "AUDIT national FAIL: fmt {fmt:?}, total {} / by_class {:?} entries for {n} sections",
            total.len(),
            by_class.iter().map(Vec::len).collect::<Vec<_>>()
        );
        return false;
    }
    let class_bad = (0..n)
        .filter(|&s| by_class.iter().map(|c| c[s]).sum::<i64>() != total[s])
        .count();
    // every origin's map flow rows (delta-coded section ids)
    let (mut rows, mut below) = (0u64, 0u64);
    for o in out_map["origins"].as_array().unwrap() {
        let mut sec = 0i64;
        for r in o["flows"].as_array().unwrap() {
            let r = ints(r);
            sec += r[0];
            let s = sec as usize;
            rows += 1;
            if total[s] < r[1] || r[2..].iter().enumerate().any(|(c, &v)| by_class[c][s] < v) {
                below += 1;
            }
        }
    }
    // independent recount from the per-train outbound paths
    let classes: Vec<usize> = shared["train_table"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| class_idx(t["class"].as_str().unwrap()))
        .collect();
    let mut cnt = vec![0i64; n];
    let mut cls_cnt = vec![vec![0i64; n]; 8];
    let mut path_trains = 0i64;
    for (t, p) in out_t["paths"].as_array().unwrap().iter().enumerate() {
        let mut secs: Vec<usize> = ints(p)
            .into_iter()
            .map(|v| (if v >= 0 { v } else { !v }) as usize)
            .filter(|&s| s < n)
            .collect();
        secs.sort_unstable();
        secs.dedup();
        path_trains += !secs.is_empty() as i64;
        for s in secs {
            cnt[s] += 1;
            cls_cnt[classes[t]][s] += 1;
        }
    }
    let short = (0..n)
        .filter(|&s| total[s] < cnt[s] || (0..8).any(|c| by_class[c][s] < cls_cnt[c][s]))
        .count();
    let equal = (0..n).filter(|&s| total[s] == cnt[s]).count();
    let trains = nat["trains"].as_i64().unwrap_or(-1);
    let widest = (0..n)
        .max_by_key(|&s| (total[s], std::cmp::Reverse(s)))
        .unwrap_or(0);
    let most_added = (0..n)
        .max_by_key(|&s| (total[s] - cnt[s], std::cmp::Reverse(s)))
        .unwrap_or(0);
    for (label, s) in [("widest", widest), ("most added", most_added), ("first", 0)] {
        println!(
            "AUDIT national spot check, {label} section {s}: national {} (classes {:?}), out-path recount {} (classes {:?})",
            total[s],
            by_class.iter().map(|c| c[s]).collect::<Vec<_>>(),
            cnt[s],
            cls_cnt.iter().map(|c| c[s]).collect::<Vec<_>>()
        );
    }
    println!(
        "AUDIT national: {trains} trains ({path_trains} with an outbound path) over {n} sections; {class_bad} sections where sum(classes) != total; {below} of {rows} origin flow rows above national; {short} sections below the out-path recount, {equal} equal to it"
    );
    let ok = class_bad == 0
        && below == 0
        && short == 0
        && trains >= path_trains
        && trains <= classes.len() as i64;
    g.insert("national_sections".into(), n as i64);
    g.insert("national_trains".into(), trains);
    g.insert("national_total_sum".into(), total.iter().sum());
    g.insert("national_widest".into(), total[widest]);
    g.insert("national_eq_out_recount".into(), equal as i64);
    println!(
        "AUDIT national checks: {}",
        if ok { "PASS" } else { "FAIL" }
    );
    ok
}

/// National per-city counts (`atlas-v2-national.json` `cities`) and the
/// per-train index (`atlas-v2-national-index.json`); skipped while a pack has
/// neither. Hard checks: the class rows sum to `dep` / `arr`; every origin's
/// `outbound` / `inbound` is its city's `dep` / `arr` (all origins); and with
/// every train selected the index sums to `total`, `cities.dep` and
/// `cities.arr`, also per class.
fn audit_national_cities(
    dir: &Path,
    shared: &Value,
    out_map: &Value,
    g: &mut BTreeMap<String, i64>,
) -> bool {
    let (nat_name, ix_name) = ("atlas-v2-national.json", "atlas-v2-national-index.json");
    if !pack::exists(dir, nat_name) {
        return true;
    }
    let nat = pack::read_json(dir, nat_name);
    if nat.get("cities").is_none() {
        println!("AUDIT national cities: none in this pack, skipped");
        return true;
    }
    let ints = |v: &Value| -> Vec<i64> {
        v.as_array()
            .map(|a| a.iter().map(|x| x.as_i64().unwrap()).collect())
            .unwrap_or_default()
    };
    let rows = |v: &Value| -> Vec<Vec<i64>> {
        v.as_array()
            .map(|a| a.iter().map(ints).collect())
            .unwrap_or_default()
    };
    let c = &nat["cities"];
    let (idx, dep, arr) = (ints(&c["idx"]), ints(&c["dep"]), ints(&c["arr"]));
    let (dbc, abc) = (rows(&c["dep_by_class"]), rows(&c["arr_by_class"]));
    let k = idx.len();
    let n_city = shared["city_table"].as_array().unwrap().len() as i64;
    let mut bad = 0u64;
    let shape = dep.len() == k
        && arr.len() == k
        && dbc.len() == 8
        && abc.len() == 8
        && dbc.iter().chain(abc.iter()).all(|r| r.len() == k)
        && idx.windows(2).all(|w| w[0] < w[1])
        && idx.iter().all(|&i| (0..n_city).contains(&i));
    if !shape {
        println!("AUDIT national cities FAIL: shape ({k} cities)");
        return false;
    }
    for i in 0..k {
        bad += (dbc.iter().map(|r| r[i]).sum::<i64>() != dep[i]) as u64;
        bad += (abc.iter().map(|r| r[i]).sum::<i64>() != arr[i]) as u64;
        bad += (dep[i] + arr[i] == 0) as u64;
    }
    // origin parity
    let by_zh: HashMap<&str, i64> = shared["city_table"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, c)| (c["zh"].as_str().unwrap(), i as i64))
        .collect();
    let (mut origins, mut parity_bad) = (0u64, 0u64);
    for o in out_map["origins"].as_array().unwrap() {
        origins += 1;
        let hit = by_zh
            .get(o["zh"].as_str().unwrap())
            .and_then(|i| idx.binary_search(i).ok());
        parity_bad += (hit.map(|j| (dep[j], arr[j]))
            != Some((
                o["outbound"].as_i64().unwrap(),
                o["inbound"].as_i64().unwrap(),
            ))) as u64;
    }
    println!(
        "AUDIT national cities: {k} cities; {bad} rows whose classes do not sum or are empty; {parity_bad} of {origins} origins whose outbound/inbound differ from dep/arr"
    );
    let mut ok = bad == 0 && parity_bad == 0 && origins > 0;
    g.insert("national_cities".into(), k as i64);
    g.insert(
        "national_cities_origin_parity_bad".into(),
        parity_bad as i64,
    );
    if !pack::exists(dir, ix_name) {
        println!("AUDIT national index: no {ix_name} in this pack, skipped");
        return ok;
    }
    let ix = pack::read_json(dir, ix_name);
    let tt = shared["train_table"].as_array().unwrap();
    let n_sec = shared["sections"].as_array().unwrap().len();
    let lists = |key: &str| -> Vec<Vec<i64>> {
        // delta-coded ascending ids -> absolute ids
        rows(&ix[key])
            .into_iter()
            .map(|r| {
                let mut a = 0;
                r.into_iter()
                    .map(|d| {
                        a += d;
                        a
                    })
                    .collect()
            })
            .collect()
    };
    let (secs, idep, iarr) = (lists("secs"), lists("dep"), lists("arr"));
    let (hour, dkm, dmi, dur) = (
        ints(&ix["hour"]),
        ints(&ix["dist_km"]),
        ints(&ix["dist_mi"]),
        ints(&ix["dur"]),
    );
    let n = tt.len();
    let shaped = ix["fmt"].as_i64() == Some(6)
        && ix["n_train"].as_u64() == Some(n as u64)
        && ix["n_sec"].as_u64() == Some(n_sec as u64)
        && [
            secs.len(),
            idep.len(),
            iarr.len(),
            hour.len(),
            dkm.len(),
            dmi.len(),
            dur.len(),
        ]
        .iter()
        .all(|&l| l == n);
    if !shaped {
        println!("AUDIT national index FAIL: shape for {n} trains / {n_sec} sections");
        return false;
    }
    let range_bad = (0..n)
        .filter(|&t| {
            !(-1..24).contains(&hour[t])
                || !(-1..=30).contains(&dkm[t])
                || !(-1..=40).contains(&dmi[t])
                || !(-1..=24).contains(&dur[t])
                || secs[t].iter().any(|&s| s < 0 || s >= n_sec as i64)
        })
        .count();
    let total = ints(&nat["total"]);
    let by_class = rows(&nat["by_class"]);
    let (mut tot, mut cls) = (vec![0i64; n_sec], vec![vec![0i64; n_sec]; 8]);
    let (mut d_cls, mut a_cls) = (vec![vec![0i64; k]; 8], vec![vec![0i64; k]; 8]);
    let mut city_bad = 0u64;
    for t in 0..n {
        let ci = class_idx(tt[t]["class"].as_str().unwrap());
        for &s in &secs[t] {
            tot[s as usize] += 1;
            cls[ci][s as usize] += 1;
        }
        for (ids, cls_rows) in [(&idep[t], &mut d_cls), (&iarr[t], &mut a_cls)] {
            for &i in ids.iter() {
                match idx.binary_search(&i) {
                    Ok(j) => cls_rows[ci][j] += 1,
                    Err(_) => city_bad += 1,
                }
            }
        }
    }
    let sec_bad = (0..n_sec).filter(|&s| tot[s] != total[s]).count()
        + (0..8)
            .map(|c| (0..n_sec).filter(|&s| cls[c][s] != by_class[c][s]).count())
            .sum::<usize>();
    let dep_bad = (0..8)
        .map(|c| (0..k).filter(|&j| d_cls[c][j] != dbc[c][j]).count())
        .sum::<usize>();
    let arr_bad = (0..8)
        .map(|c| (0..k).filter(|&j| a_cls[c][j] != abc[c][j]).count())
        .sum::<usize>();
    println!(
        "AUDIT national index: {n} trains; {range_bad} rows out of range; selecting every train: {sec_bad} section / {dep_bad} dep / {arr_bad} arr count mismatches (by class), {city_bad} cities outside the city counts"
    );
    ok &= range_bad == 0 && sec_bad == 0 && dep_bad == 0 && arr_bad == 0 && city_bad == 0;
    g.insert("national_index_trains".into(), n as i64);
    println!(
        "AUDIT national cities+index checks: {}",
        if ok { "PASS" } else { "FAIL" }
    );
    ok
}

/// P2.2 national trains (`atlas-v2-national-trains.json`; skipped while a
/// pack has none). Hard checks: shape, `fmt` and id bases against the shared
/// file, every id resolvable; the train set is exactly the trains with an
/// out- or in-tables path; recounting distinct trains per section (and per
/// class) from the whole paths reproduces `atlas-v2-national.json` exactly
/// (when present; a piece listed in `on_sec` counts on its section); every
/// out-tables path is the tail of its train's whole
/// path, with its stop positions and chord legs; stop positions are one per
/// schedule stop after the first, monotone, ending at the path end.
/// Counters: path continuity outside chord legs (as for the table rows),
/// chord legs, and reversals where the head meets the out-tables tail.
fn audit_national_trains(
    dir: &Path,
    shared: &Value,
    out_t: &Value,
    in_t: &Value,
    sch: &Value,
    g: &mut BTreeMap<String, i64>,
) -> bool {
    let name = "atlas-v2-national-trains.json";
    if !pack::exists(dir, name) {
        println!("AUDIT national trains: no {name} in this pack, skipped");
        return true;
    }
    let nt = pack::read_json(dir, name);
    let ints = |v: &Value| -> Vec<i64> {
        v.as_array()
            .map(|a| a.iter().map(|x| x.as_i64().unwrap()).collect())
            .unwrap_or_default()
    };
    let rows = |v: &Value| -> Vec<Vec<i64>> {
        v.as_array()
            .map(|a| a.iter().map(ints).collect())
            .unwrap_or_default()
    };
    let chord_map = |v: &Value| -> HashMap<usize, Vec<Vec<i64>>> {
        v.as_array()
            .into_iter()
            .flatten()
            .map(|c| (c[0].as_u64().unwrap() as usize, rows(&c[1])))
            .collect()
    };
    let polys = |v: &Value| -> Vec<Vec<[f64; 2]>> {
        v.as_array()
            .into_iter()
            .flatten()
            .map(|s| decode_poly4(s.as_str().unwrap()))
            .collect()
    };
    let sec_geo: Vec<Vec<[f64; 2]>> = shared["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| decode_poly4(s["g"].as_str().unwrap()))
        .collect();
    let (n_sec, n_thr) = (sec_geo.len(), shared["throats"].as_array().unwrap().len());
    let extra = polys(&nt["extra"]);
    let ends: Vec<([f64; 2], [f64; 2])> = sec_geo
        .iter()
        .chain(polys(&shared["throats"]).iter())
        .chain(extra.iter())
        .map(|p| (p[0], *p.last().unwrap()))
        .collect();
    let paths = rows(&nt["paths"]);
    let stop_pos = rows(&nt["stop_pos"]);
    let chords = chord_map(&nt["chords"]);
    let train_table = shared["train_table"].as_array().unwrap();
    let scheds = sch["schedules"].as_array().unwrap();
    let fmt = nt["fmt"].as_i64();
    let shape_ok = fmt == Some(6)
        && nt["n_sec"].as_u64() == Some(n_sec as u64)
        && nt["n_thr"].as_u64() == Some(n_thr as u64)
        && paths.len() == train_table.len()
        && stop_pos.len() == train_table.len();
    let sec_of = |v: i64| (if v >= 0 { v } else { !v }) as usize;
    let bad_ids = paths
        .iter()
        .flatten()
        .filter(|&&v| sec_of(v) >= ends.len())
        .count();
    if !shape_ok || bad_ids > 0 {
        println!(
            "AUDIT national trains FAIL: fmt {fmt:?}, n_sec {} / n_thr {} vs shared {n_sec} / {n_thr}, {} paths and {} stop lists for {} trains, {bad_ids} ids out of range",
            nt["n_sec"],
            nt["n_thr"],
            paths.len(),
            stop_pos.len(),
            train_table.len()
        );
        return false;
    }
    let is_flow = |v: i64| sec_of(v) < n_sec;
    // ---- train set: exactly the trains with an out- or in-tables path ----
    let (out_p, in_p) = (rows(&out_t["paths"]), rows(&in_t["paths"]));
    let set_diff = (0..paths.len())
        .filter(|&t| {
            let has_row = out_p.get(t).is_some_and(|p| !p.is_empty())
                || in_p.get(t).is_some_and(|p| !p.is_empty());
            paths[t].is_empty() == has_row
        })
        .count();
    let trains = paths.iter().filter(|p| !p.is_empty()).count() as i64;
    // ---- A <-> B: recount distinct trains per section and class ----
    let classes: Vec<usize> = train_table
        .iter()
        .map(|t| class_idx(t["class"].as_str().unwrap()))
        .collect();
    // geometry-only pieces on a section a head covers only part of
    let on_sec: HashMap<usize, usize> = rows(&nt["on_sec"])
        .iter()
        .map(|r| (r[0] as usize, r[1] as usize))
        .collect();
    let mut cnt = vec![0i64; n_sec];
    let mut cls_cnt = vec![vec![0i64; n_sec]; 8];
    for (t, p) in paths.iter().enumerate() {
        let mut secs: Vec<usize> = p
            .iter()
            .filter_map(|&v| {
                let id = sec_of(v);
                if id < n_sec {
                    Some(id)
                } else {
                    on_sec.get(&id).copied()
                }
            })
            .collect();
        secs.sort_unstable();
        secs.dedup();
        for s in secs {
            cnt[s] += 1;
            cls_cnt[classes[t]][s] += 1;
        }
    }
    let (mut recount_eq, mut recount_ok) = (-1i64, true);
    let nat_name = "atlas-v2-national.json";
    if pack::exists(dir, nat_name) {
        let nat = pack::read_json(dir, nat_name);
        let total = ints(&nat["total"]);
        let by_class = rows(&nat["by_class"]);
        recount_eq = (0..n_sec)
            .filter(|&s| {
                total.get(s) == Some(&cnt[s])
                    && (0..8)
                        .all(|c| by_class.get(c).and_then(|v| v.get(s)) == Some(&cls_cnt[c][s]))
            })
            .count() as i64;
        let nat_trains = nat["trains"].as_i64().unwrap_or(-1);
        recount_ok = recount_eq == n_sec as i64 && nat_trains == trains;
        println!(
            "AUDIT national trains vs national table: {trains} vs {nat_trains} trains; recount equal (total and every class) on {recount_eq} of {n_sec} sections"
        );
    }
    // ---- out-tables tail, stop positions, chord legs, continuity ----
    let (out_sp, out_ch) = (rows(&out_t["stop_pos"]), chord_map(&out_t["chords"]));
    let (mut tail_eq, mut tail_bad, mut seam_rev) = (0i64, 0i64, 0i64);
    let (mut stops_bad, mut stops_total) = (0i64, 0i64);
    let (mut checked, mut gaps, mut gaps_100m, mut chord_legs) = (0u64, 0i64, 0i64, 0i64);
    let mut worst: Vec<(f64, String)> = Vec::new();
    for (t, w) in paths.iter().enumerate() {
        if w.is_empty() {
            continue;
        }
        let sp = &stop_pos[t];
        let o = out_p.get(t).cloned().unwrap_or_default();
        if !o.is_empty() {
            let fine = w.ends_with(&o) && {
                let off = (w.len() - o.len()) as i64;
                let osp = &out_sp[t];
                let tail_sp: Vec<i64> = sp[sp.len().saturating_sub(osp.len())..]
                    .iter()
                    .map(|p| p - off)
                    .collect();
                let tail_legs: Vec<Vec<i64>> = chords
                    .get(&t)
                    .into_iter()
                    .flatten()
                    .filter(|l| l[1] >= off)
                    .map(|l| vec![l[0], l[1] - off, l[2] - off])
                    .collect();
                // the head's last flow section against the tail's first
                let head_last = w[..off as usize].iter().rev().find(|&&v| is_flow(v));
                let tail_first = o.iter().find(|&&v| is_flow(v));
                if let (Some(&a), Some(&b)) = (head_last, tail_first) {
                    seam_rev += (a == !b) as i64;
                }
                sp.len() >= osp.len()
                    && tail_sp == *osp
                    && tail_legs == out_ch.get(&t).cloned().unwrap_or_default()
            };
            if fine {
                tail_eq += 1;
            } else {
                tail_bad += 1;
            }
        }
        let n_stops = scheds.get(t).and_then(Value::as_array).map_or(0, Vec::len);
        stops_total += sp.len() as i64;
        if sp.len() + 1 != n_stops
            || sp.windows(2).any(|x| x[1] < x[0])
            || sp.last() != Some(&(w.len() as i64))
        {
            stops_bad += 1;
        }
        // continuity outside chord legs, as for the table rows
        let mut exempt: HashSet<usize> = HashSet::new();
        for l in chords.get(&t).into_iter().flatten() {
            chord_legs += 1;
            exempt.extend(l[1] as usize..=l[2] as usize);
        }
        let oriented = |v: i64| {
            let (a, b) = ends[sec_of(v)];
            if v >= 0 {
                (a, b)
            } else {
                (b, a)
            }
        };
        for k in 1..w.len() {
            if exempt.contains(&k) {
                continue;
            }
            checked += 1;
            let gap = hav_km_ll(oriented(w[k - 1]).1, oriented(w[k]).0);
            gaps_100m += (gap > 0.1) as i64;
            if gap > 3.0 {
                gaps += 1;
                let code = train_table[t]["code"].as_str().unwrap_or("?");
                worst.push((gap, format!("{code} at {k}/{}", w.len())));
            }
        }
    }
    worst.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    println!(
        "AUDIT national trains: {trains} trains ({set_diff} differ from the trains with a table row); {tail_eq} end with their out-tables path ({tail_bad} do not); {stops_total} stop positions, {stops_bad} trains inconsistent (count/order/path end); {} extra pieces; {seam_rev} reversals where the head meets the out-tables path",
        extra.len()
    );
    println!(
        "AUDIT national trains continuity: {gaps} gaps > 3 km, {gaps_100m} > 0.1 km in {checked} joins outside {chord_legs} chord legs"
    );
    for (gap, what) in worst.iter().take(10) {
        println!("   {gap:>8.1} km  {what}");
    }
    let ok = set_diff == 0 && recount_ok && tail_bad == 0 && stops_bad == 0;
    g.insert("national_trains_trains".into(), trains);
    if recount_eq >= 0 {
        g.insert("national_trains_recount_eq".into(), recount_eq);
    }
    g.insert("national_trains_out_tail_eq".into(), tail_eq);
    g.insert("national_trains_stops_total".into(), stops_total);
    g.insert("national_trains_chord_legs".into(), chord_legs);
    g.insert("national_trains_gaps_gt3km".into(), gaps);
    g.insert("national_trains_gaps_gt100m".into(), gaps_100m);
    println!(
        "AUDIT national trains checks: {}",
        if ok { "PASS" } else { "FAIL" }
    );
    ok
}

/// P3.3 national entries (`atlas-v2-national-entries.json`; skipped while a
/// pack has none). Hard checks: shape, `fmt` and `n_sec` against the shared
/// file; every array sorted, every tick in the day; per section and class
/// the entry count equals `atlas-v2-national.json` (so the A+B counts at
/// 24:00 are B exactly) and `trains` its train count; recomputing the
/// entries from the national trains file (`entries::from_pack`) gives the
/// shipped arrays exactly; every entry lies between the times of the stops
/// that bracket it on the path (the last stop at or before the entry: its
/// arrival, or the departure at the first stop; the next stop: its
/// arrival), a check independent of the interpolation. Counters: entries past
/// midnight of the boarding day (wrapped) and the trains they belong to.
fn audit_national_entries(
    dir: &Path,
    shared: &Value,
    sch: &Value,
    g: &mut BTreeMap<String, i64>,
) -> bool {
    let name = "atlas-v2-national-entries.json";
    if !pack::exists(dir, name) {
        println!("AUDIT national entries: no {name} in this pack, skipped");
        return true;
    }
    let ne = pack::read_json(dir, name);
    let n_sec = shared["sections"].as_array().unwrap().len();
    let tpm = ne["ticks_per_min"].as_u64().unwrap_or(0) as i64;
    let rows: Vec<Vec<Vec<i64>>> = ne["by_class"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            c.as_array()
                .into_iter()
                .flatten()
                .map(|s| {
                    s.as_array()
                        .into_iter()
                        .flatten()
                        .map(|x| x.as_i64().unwrap())
                        .collect()
                })
                .collect()
        })
        .collect();
    let shape_ok = ne["fmt"].as_i64() == Some(6)
        && ne["n_sec"].as_u64() == Some(n_sec as u64)
        && tpm > 0
        && rows.len() == 8
        && rows.iter().all(|c| c.len() == n_sec);
    if !shape_ok {
        println!(
            "AUDIT national entries FAIL: fmt {:?}, n_sec {} vs shared {n_sec}, ticks_per_min {tpm}, {} class rows",
            ne["fmt"],
            ne["n_sec"],
            rows.len()
        );
        return false;
    }
    let day = 1440 * tpm;
    let unsorted = rows
        .iter()
        .flatten()
        .filter(|s| s.windows(2).any(|w| w[1] < w[0]))
        .count();
    let out_of_day = rows
        .iter()
        .flatten()
        .flatten()
        .filter(|&&v| !(0..day).contains(&v))
        .count();
    let total: i64 = rows.iter().flatten().map(|s| s.len() as i64).sum();
    // ---- A+B at 24:00 == B: counts per section and class ----
    let (mut eq_b, mut b_ok) = (-1i64, true);
    let nat_name = "atlas-v2-national.json";
    if pack::exists(dir, nat_name) {
        let nat = pack::read_json(dir, nat_name);
        let at = |v: &Value, s: usize| v.get(s).and_then(Value::as_i64);
        eq_b = (0..n_sec)
            .filter(|&s| {
                let n: i64 = (0..8).map(|c| rows[c][s].len() as i64).sum();
                at(&nat["total"], s) == Some(n)
                    && (0..8).all(|c| at(&nat["by_class"][c], s) == Some(rows[c][s].len() as i64))
            })
            .count() as i64;
        b_ok = eq_b == n_sec as i64 && ne["trains"] == nat["trains"];
        println!(
            "AUDIT national entries vs national table: {} vs {} trains; counts equal (total and every class) on {eq_b} of {n_sec} sections",
            ne["trains"], nat["trains"]
        );
    }
    // ---- recompute from the national trains file; stop brackets ----
    let (mut recompute_eq, mut recompute_ok) = (-1i64, true);
    let (mut bracket_bad, mut wrapped, mut wrapped_trains) = (0i64, 0i64, 0i64);
    let nt_name = "atlas-v2-national-trains.json";
    if pack::exists(dir, nt_name) {
        let nt = pack::read_json(dir, nt_name);
        let trains = entries::from_pack(shared, &nt, &sch["schedules"]);
        let mine = entries::by_class(&trains, n_sec, tpm as u32);
        recompute_eq = (0..n_sec)
            .filter(|&s| {
                (0..8).all(|c| {
                    mine[c][s].len() == rows[c][s].len()
                        && mine[c][s]
                            .iter()
                            .zip(&rows[c][s])
                            .all(|(a, b)| *a as i64 == *b)
                })
            })
            .count() as i64;
        recompute_ok = recompute_eq == n_sec as i64;
        let train_table = shared["train_table"].as_array().unwrap();
        let st_name = |t: usize, j: usize| -> String {
            let st = sch["schedules"][t][j][0].as_u64().unwrap_or(0) as usize;
            shared["station_table"][st]["zh"]
                .as_str()
                .unwrap_or("?")
                .to_string()
        };
        let clock = |a: f64| {
            let m = a.rem_euclid(1440.0);
            format!("{:02}:{:04.1}", (m / 60.0).floor() as i64, m % 60.0)
        };
        let mut spots: Vec<String> = Vec::new();
        let mut spot_cls = [false; 8];
        for tr in &trains {
            let sp: Vec<usize> = nt["stop_pos"][tr.t]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_u64().unwrap() as usize)
                .collect();
            let m = &tr.motion;
            let mut any_wrap = false;
            for (k, &(s, i, a)) in tr.entries.iter().enumerate() {
                // stop j >= 1 sits before path entry sp[j - 1]: the train
                // has reached every stop before entry i (the boarding stop
                // is left at the start) and not yet any stop after it; a
                // stop at the entry itself lies inside the bracket. The
                // arrival, not the departure, bounds it below: a stop
                // followed only by zero-length pieces is at the entry's
                // distance, and the dot reaches it on arrival
                let prev = sp.iter().take_while(|&&p| p < i).count();
                let next = sp.iter().take_while(|&&p| p <= i).count();
                let lo = match prev {
                    0 => m.start,
                    j => m.stops[j - 1].arr,
                };
                // the terminus sits at the path end, so some stop follows
                let hi = m.stops[next].arr;
                let outside = !(lo - 1e-9..=hi + 1e-9).contains(&a);
                bracket_bad += outside as i64;
                // spot checks: the middle entry of the first train of each
                // class bucket, the first entry that wraps past midnight,
                // the first misses
                let first_wrap = a >= 1440.0 && wrapped == 0;
                if a >= 1440.0 {
                    wrapped += 1;
                    any_wrap = true;
                }
                let first = !spot_cls[tr.cls] && k == tr.entries.len() / 2;
                spot_cls[tr.cls] |= first;
                if first || first_wrap || (outside && bracket_bad <= 5) {
                    spots.push(format!(
                        "{}{} section {s}: entry {} (abs {a:.2}) between {} {} and {} {}",
                        match (outside, a >= 1440.0) {
                            (true, _) => "[OUTSIDE] ",
                            (_, true) => "[wrap] ",
                            _ => "",
                        },
                        train_table[tr.t]["code"].as_str().unwrap_or("?"),
                        clock(a),
                        st_name(tr.t, prev),
                        clock(lo),
                        st_name(tr.t, next + 1),
                        clock(hi),
                    ));
                }
            }
            wrapped_trains += any_wrap as i64;
        }
        for s in &spots {
            println!("AUDIT national entries spot check: {s}");
        }
    }
    println!(
        "AUDIT national entries: {} trains, {total} entries in {n_sec} sections x 8 classes at {tpm} ticks/min; {unsorted} unsorted arrays, {out_of_day} ticks outside the day; recompute equal on {recompute_eq} sections; {bracket_bad} entries outside their stop bracket; {wrapped} entries in {wrapped_trains} trains past the boarding day's midnight (wrapped)",
        ne["trains"]
    );
    let ok = unsorted == 0 && out_of_day == 0 && b_ok && recompute_ok && bracket_bad == 0;
    g.insert("national_entries_total".into(), total);
    if eq_b >= 0 {
        g.insert("national_entries_eq_national".into(), eq_b);
    }
    if recompute_eq >= 0 {
        g.insert("national_entries_recompute_eq".into(), recompute_eq);
        g.insert("national_entries_bracket_bad".into(), bracket_bad);
        g.insert("national_entries_wrapped".into(), wrapped);
    }
    println!(
        "AUDIT national entries checks: {}",
        if ok { "PASS" } else { "FAIL" }
    );
    ok
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
    let mut edge_trains = chains::EdgeTrains::new();
    for (ci, w) in works.iter().enumerate() {
        for (k, (legs, cidx)) in w.train_leg_keys.iter().zip(w.train_cls.iter()).enumerate() {
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
            let mark = chains::train_mark(ci, k);
            for e in eset {
                let m = edge_trains.entry(e).or_insert(0);
                *m = m.wrapping_add(mark);
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
    // (no walk cuts: they only split chains of equal counts, which the
    // recounts below do not see)
    let section_chains = chains::build_section_chains(&edge_sig, &edge_trains, &HashSet::new());
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
