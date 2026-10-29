use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::PathBuf;

use analyze_rs::chains;
use analyze_rs::cn::*;
use analyze_rs::flows;
use analyze_rs::geo::*;
use analyze_rs::inputs;
use analyze_rs::legs::*;
use analyze_rs::legwalk::*;
use analyze_rs::model::*;
use analyze_rs::names::*;
use analyze_rs::osm;
use analyze_rs::polyline::*;
use analyze_rs::provenance;
use analyze_rs::timetable::*;
use analyze_rs::trainpath;

/// One train in data/raw/stops*.jsonl (the 12306 stop-list dump).
#[derive(Deserialize)]
struct RawTrain {
    train_no: String,
    stops: Vec<RawStop>,
}
#[derive(Deserialize)]
struct RawStop {
    station_name: String,
    arrive_time: String,
    start_time: String,
}
/// One schedule row: [station idx, arrive mins, depart mins (-1 = none),
/// day offset of the call from the train's origin day, leg km from the
/// previous stop (-1 = unknown)].
/// (station idx, arr mins, dep mins, day offset, leg km, leg km/h): the leg
/// is the one arriving at this stop; km/h is its timetable average (0 when
/// unknown).
type ScheduleRow = (i64, i64, i64, i64, f64, i64);
#[derive(Default, Clone)]
struct DestStats {
    total: u64,
    fast: u64,
    terminating: u64,
    times: Vec<i64>,
    rail: Vec<f64>,
    calls: Vec<CallRaw>,
    first: usize,
}

fn is_zero(v: &u8) -> bool {
    *v == 0
}

fn pack_flow_row(sec_idx: usize, n: usize, cls_counts: &[u32; 8]) -> Vec<usize> {
    let mut row = Vec::with_capacity(10);
    row.push(sec_idx);
    row.push(n);
    let mut last_nz = 0usize;
    for (i, &c) in cls_counts.iter().enumerate() {
        if c > 0 {
            last_nz = i + 1;
        }
    }
    for &c in &cls_counts[..last_nz] {
        row.push(c as usize);
    }
    row
}

#[derive(serde::Serialize)]
struct AtlasSection {
    a: i64,
    b: i64,
    g: String,
    #[serde(skip_serializing_if = "is_zero")]
    h: u8,
    /// The OSM line names the section runs on: indices into `lines`, by
    /// share of the section's named length, largest first.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    l: Vec<u32>,
    /// Signed speed limit (OSM `maxspeed`, km/h) over most of the section's
    /// tagged length; 0 (omitted) when under half its length is tagged.
    #[serde(skip_serializing_if = "is_zero_u16")]
    v: u16,
}
fn is_zero_u16(v: &u16) -> bool {
    *v == 0
}
#[derive(serde::Serialize)]
struct AtlasChord {
    a: i64,
    b: i64,
    n: u64,
    g: String,
}
/// One call row in an origin's calls list: (dep row idx, arr, dep, day off, terminates, sec_cnt).
type CallList = Vec<(usize, String, String, i64, u8, usize)>;
/// One call row in a destination's inbound calls list:
/// (arr row idx, board time, arrival time, day off, started-here, board station idx, sec_cnt).
type InCallList = Vec<(usize, String, String, i64, u8, i64, usize)>;
/// Join key for a train's departure row: (train index, origin station, depart time).
type DepKey = (usize, String, String);
/// Join key for a train's arrival row: (train index, origin station, depart time, dataset index).
type ArrKey = (usize, String, String, u8);
#[derive(serde::Serialize)]
struct AtlasDep {
    t: usize,
    fs: i64,
    dep: String,
    ts: i64,
    tc: i64,
    arr: String,
    dur: i64,
    stops: u64,
    set: u8,
    km: i64,
}

#[derive(serde::Serialize)]
struct AtlasArr {
    t: usize,
    fs: i64,
    fc: i64,
    dep: String,
    ts: i64,
    arr: String,
    dur: i64,
    stops: u64,
    set: u8,
    km: i64,
}
#[derive(serde::Serialize)]
struct AtlasOrigin {
    zh: String,
    en: String,
    pt: [f64; 2],
    outbound: u64,
    fully_tracked: u64,
    dests: Vec<[i64; 8]>,
    calls: Vec<CallList>,
    flows: Vec<Vec<usize>>,
    chords: Vec<AtlasChord>,
    deps: Vec<AtlasDep>,
    pub dep_secs: Vec<Vec<i64>>,
    /// Per dep: [stop, s0, s1] for each leg without usable geometry
    /// (unresolved, or a gap > CHORD_GAP_KM): the leg departs the train's
    /// stop index `stop`; its entries (sections and throats) are
    /// dep_secs[s0..s1].
    dep_chord_legs: Vec<Vec<[usize; 3]>>,
    /// Per dep: path position of every stop after boarding (station level).
    dep_stop_pos: Vec<Vec<usize>>,
    inbound: u64,
    srcs: Vec<[i64; 8]>,
    in_calls: Vec<InCallList>,
    in_flows: Vec<Vec<usize>>,
    arrs: Vec<AtlasArr>,
    pub arr_secs: Vec<Vec<i64>>,
    /// Per arr: as dep_chord_legs, positions into arr_secs.
    arr_chord_legs: Vec<Vec<[usize; 3]>>,
}
#[derive(serde::Serialize)]
struct AtlasOut {
    about: String,
    /// Provenance (code revision, input hashes); atlaspack copies it to `shared.build`.
    build: serde_json::Value,
    origins: Vec<AtlasOrigin>,
    sections: Vec<AtlasSection>,
    in_sections: Vec<AtlasSection>,
    /// OSM line names `[name, name:en]` ("" when OSM has no English name)
    /// that `sections` / `in_sections` `l` index, in order of first use.
    lines: Vec<[String; 2]>,
    /// O1 station-throat pieces (polylines): path entries `base + j` (base =
    /// sections.len() in dep_secs, in_sections.len() in arr_secs).
    throats: Vec<String>,
    city_table: Vec<AtlasCity>,
    station_table: Vec<AtlasStation>,
    train_table: Vec<AtlasTrainRef>,
    network: Vec<String>,
    stats: std::collections::BTreeMap<String, i64>,
    /// Indexed by train_table index t: the train's full stop list.
    schedules: Vec<Vec<ScheduleRow>>,
    /// P3.1 national per-section table over `sections` (this file's
    /// numbering; atlaspack renumbers it with the sections). Last, so the
    /// fields before it serialize exactly as before it existed.
    national: flows::National,
    /// P2.2 national trains (A): every national train's whole run, after
    /// `national` for the same reason.
    national_trains: NationalTrains,
    /// Per-train national facts for filtering (section numbering as `national`).
    national_index: flows::NationalIndex,
    /// Train-export builds only: the export's dates, which each train_table
    /// row's `days` indexes.
    #[serde(skip_serializing_if = "Option::is_none")]
    calendar: Option<Vec<String>>,
}

/// Every national train's whole path (see atlaspack's header for the
/// packed form), indexed by train_table t like `schedules`; a train outside
/// the national set has an empty path.
#[derive(serde::Serialize, Default)]
struct NationalTrains {
    /// Whole path per train, out-tables encoding over `sections` (this
    /// file's numbering), then `throats`, then `extra`.
    paths: Vec<Vec<i64>>,
    /// Per train: entries before each stop after its first.
    stop_pos: Vec<Vec<usize>>,
    /// `[t, legs]` for trains with chord legs (`[stop, s0, s1]`).
    chords: Vec<(usize, Vec<[usize; 3]>)>,
    /// Geometry-only pieces the shared throats lack: path entries
    /// `sections.len() + throats.len() + j` (polylines like `throats`).
    extra: Vec<String>,
    /// `(path id, section)` for the geometry-only entries that lie on a flow
    /// section a head covers only part of (a train counts on that section).
    on_sec: Vec<(usize, usize)>,
}

/// One train's call at one destination city (first stop in that city).
#[derive(Clone)]
struct CallRaw {
    /// The train's index into `trains`.
    ti: usize,
    from_station: String,
    depart: String,
    arr: String,
    dep: String,
    off: i64,
    term: bool,
    leg_cnt: usize,
}

/// One train's boarding at one source city, for the inbound view of the
/// city it later arrives at (first stop in the source city).
#[derive(Clone)]
struct InCallRaw {
    /// The train's index into `trains`.
    ti: usize,
    from_station: String,
    depart: String,
    arr: String,
    off: i64,
    started: bool,
    okey_station: String,
    okey_depart: String,
    set: u8,
    leg_start: usize,
}

/// Per (destination city, source city) inbound stats; mirrors DestStats.
#[derive(Default)]
struct InSrcStats {
    total: u64,
    fast: u64,
    originating: u64,
    times: Vec<i64>,
    rail: Vec<f64>,
    calls: Vec<InCallRaw>,
    first: usize,
}

type StationGrid = HashMap<(i32, i32), Vec<[f64; 2]>>;

struct DepRaw {
    code: String,
    from_station: String,
    depart: String,
    to_station: String,
    to_city: String,
    arrive: String,
    dur: Option<i64>,
    stops_after: u64,
    set: u8,
    km: f64,
    leg_keys: Vec<(String, String, String)>,
    /// Per leg: travelled key.0 -> key.1 (the key is canonical (min, max)).
    leg_fwd: Vec<bool>,
    /// Per leg: index of its departing stop in the train's stop list.
    leg_stop: Vec<usize>,
    /// Index of the boarding stop in the train's stop list.
    board: usize,
    /// The train's index into `trains`.
    ti: usize,
}
/// (class bucket, train index into `trains`, leg keys)
type TrainLegs = (usize, usize, Vec<(String, String, String)>);
struct CityWork {
    zh: String,
    outbound: u64,
    fully_tracked: u64,
    legs: Vec<((String, String, String), u64)>,
    dests: Vec<(String, DestStats)>,
    deps: Vec<DepRaw>,
    home_pt: [f64; 2],
    train_leg_keys: Vec<TrainLegs>,
}
struct InArrRaw {
    code: String,
    from_station: String,
    from_city: String,
    depart: String,
    arr_station: String,
    arrive: String,
    dur: Option<i64>,
    stops_before: u64,
    set: u8,
    km: f64,
    leg_keys: Vec<(String, String, String)>,
    /// Per leg: travelled key.0 -> key.1 (the key is canonical (min, max)).
    leg_fwd: Vec<bool>,
    /// Per leg: index of its departing stop in the train's stop list.
    leg_stop: Vec<usize>,
    /// The train's index into `trains`.
    ti: usize,
}
struct InCityWork {
    zh: String,
    arrivals: u64,
    sources: Vec<(String, InSrcStats)>,
    arrs: Vec<InArrRaw>,
    home_pt: [f64; 2],
    train_leg_keys: Vec<TrainLegs>,
}

/// Read-only state every phase shares: the loaded inputs plus what is derived
/// from them once (way classes, per-train cleaned names and cities).
struct Ctx<'a> {
    inp: &'a inputs::Inputs,
    ways: osm::WayClasses,
    train_names: Vec<Vec<String>>,
    train_cities: Vec<Vec<String>>,
}

impl<'a> Ctx<'a> {
    /// HSR edges & nodes from the OSM ways (highspeed=yes or maxspeed>=200),
    /// and the per-train names/cities.
    fn new(inp: &'a inputs::Inputs) -> Ctx<'a> {
        let ways = osm::scan_ways(&inp.osm_data);
        let trains = &inp.trains;

        let train_names: Vec<Vec<String>> = trains
            .iter()
            .map(|t| t.stops.iter().map(|s| clean(&s.name)).collect())
            .collect();
        let train_cities: Vec<Vec<String>> = train_names
            .iter()
            .map(|ns| ns.iter().map(|n| city_of(n)).collect())
            .collect();

        Ctx {
            inp,
            ways,
            train_names,
            train_cities,
        }
    }

    fn station_pt(&self, name: &str) -> Option<[f64; 2]> {
        self.inp.stations.point(name)
    }

    fn seg_coords(&self, ids: &[i64]) -> Vec<[f64; 2]> {
        ids.iter()
            .filter_map(|id| self.inp.coords.get(id).copied())
            .collect()
    }

    fn chain_hsr(&self, chain: &[i64]) -> u8 {
        let osm::WayClasses {
            hsr_edges,
            conv_edges,
            hsr_nodes,
            ..
        } = &self.ways;

        let total = chain.len().saturating_sub(1);
        let hsr_n = chain
            .windows(2)
            .filter(|w| {
                let e = if w[0] < w[1] {
                    (w[0], w[1])
                } else {
                    (w[1], w[0])
                };
                hsr_edges.contains(&e)
                    || (!conv_edges.contains(&e)
                        && hsr_nodes.contains(&w[0])
                        && hsr_nodes.contains(&w[1]))
            })
            .count();
        u8::from(total > 0 && hsr_n * 2 >= total)
    }

    /// The OSM lines (`WayClasses::lines` indices) a chain runs on, each
    /// with at least `LINE_MIN_SHARE` of its named length, largest share
    /// first. Unnamed edges count for no line.
    fn chain_lines(&self, chain: &[i64]) -> Vec<u32> {
        const LINE_MIN_SHARE: f64 = 0.2;
        let coords = &self.inp.coords;
        let mut km: HashMap<u32, f64> = HashMap::new();
        for w in chain.windows(2) {
            let Some(&li) = self.ways.edge_line.get(&osm::edge_key(w[0], w[1])) else {
                continue;
            };
            if let (Some(&p), Some(&q)) = (coords.get(&w[0]), coords.get(&w[1])) {
                *km.entry(li).or_insert(0.0) += hav_km_ll(p, q);
            }
        }
        let total: f64 = km.values().sum();
        let mut ls: Vec<(u32, f64)> = km
            .into_iter()
            .filter(|&(_, k)| total > 0.0 && k >= LINE_MIN_SHARE * total)
            .collect();
        ls.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        ls.into_iter().map(|(li, _)| li).collect()
    }

    /// The chain's signed speed limit: the `maxspeed` covering the most of
    /// its length (ties to the higher), or 0 when tags cover under half of it.
    fn chain_speed(&self, chain: &[i64]) -> u16 {
        let coords = &self.inp.coords;
        let (mut total, mut tagged) = (0.0, 0.0);
        let mut km: HashMap<u16, f64> = HashMap::new();
        for w in chain.windows(2) {
            let (Some(&p), Some(&q)) = (coords.get(&w[0]), coords.get(&w[1])) else {
                continue;
            };
            let d = hav_km_ll(p, q);
            total += d;
            if let Some(&v) = self.ways.edge_speed.get(&osm::edge_key(w[0], w[1])) {
                tagged += d;
                *km.entry(v).or_insert(0.0) += d;
            }
        }
        if total <= 0.0 || tagged * 2.0 < total {
            return 0;
        }
        km.into_iter()
            .max_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)))
            .map_or(0, |(v, _)| v)
    }
}

/// Rank cities by outbound trains and pick the top 100 plus the featured ones.
fn select_cities(cx: &Ctx) -> Vec<String> {
    let train_cities = &cx.train_cities;
    let en = |c: &str| -> String { cx.inp.en(c) };

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
    for th in [300u64, 200, 150, 100, 75, 50, 25, 10] {
        println!(
            "TIER outbound >= {}: {} cities",
            th,
            ranked.iter().filter(|(_, n)| *n >= th).count()
        );
    }
    println!("total cities with >= 1 outbound train: {}", ranked.len());
    println!("TOP {} CITIES BY OUTBOUND TRAINS:", top_n);
    for (i, (c, n)) in ranked.iter().take(top_n).enumerate() {
        println!("  {:>2}. {} {} - {}", i + 1, c, en(c), n);
    }
    selected
}

/// Global station stop counts per city -> principal points ([lat, lon]).
fn principal_points(cx: &Ctx) -> HashMap<String, [f64; 2]> {
    let trains = &cx.inp.trains;
    let (train_names, train_cities) = (&cx.train_names, &cx.train_cities);
    let station_pt = |name: &str| -> Option<[f64; 2]> { cx.station_pt(name) };

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
    city_pt
}

/// The corridor graph shared by all cities.
struct Corridor {
    pair_len: HashMap<(String, String), f64>,
    adj_pure: CorridorAdj,
    adj: CorridorAdj,
}

impl Corridor {
    fn build(cx: &Ctx) -> Corridor {
        let path_map = &cx.inp.path_map;
        let station_pt = |name: &str| -> Option<[f64; 2]> { cx.station_pt(name) };

        let pair_len: HashMap<(String, String), f64> = path_map
            .iter()
            .filter(|(_, (_, segs))| segs.iter().any(|s| s.len() >= 2))
            .map(|(k, (_, segs))| {
                let l: f64 = segs
                    .iter()
                    .map(|s| {
                        let c = cx.seg_coords(s);
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
        Corridor {
            pair_len,
            adj_pure,
            adj,
        }
    }
}

/// Leg resolution caches, filled while the per-city passes resolve legs.
#[derive(Default)]
struct LegCaches {
    leg_cache: HashMap<(String, String), Option<Vec<Vec<i64>>>>,
    variant_cache: VariantCache,
    variant_stats: (u64, u64),
}

/// Interning tables (filled during assembly).
#[derive(Default)]
struct Interner {
    city_table: Vec<AtlasCity>,
    city_idx: HashMap<String, i64>,
    station_table: Vec<AtlasStation>,
    station_idx: HashMap<String, i64>,
    train_table: Vec<AtlasTrainRef>,
    /// train_table t -> index into `trains` (train_ti[t]), and back
    train_ti: Vec<usize>,
    train_idx: HashMap<usize, usize>,
    line_table: Vec<[String; 2]>,
    /// OSM line index (`WayClasses::lines`) -> line_table index
    line_idx: HashMap<u32, u32>,
}

impl Interner {
    fn line(&mut self, li: u32, lines: &[(String, String)]) -> u32 {
        if let Some(&i) = self.line_idx.get(&li) {
            return i;
        }
        let i = self.line_table.len() as u32;
        let (zh, en) = &lines[li as usize];
        self.line_table.push([zh.clone(), en.clone()]);
        self.line_idx.insert(li, i);
        i
    }
    fn city(
        &mut self,
        zh: &str,
        city_en: &HashMap<String, String>,
        city_pt: &HashMap<String, [f64; 2]>,
    ) -> i64 {
        if let Some(i) = self.city_idx.get(zh) {
            return *i;
        }
        let pt = city_pt.get(zh).map(|p| [p[1], p[0]]).unwrap_or_else(|| {
            panic!("city {zh} has no point: add it to CITY_POINTS in cn/gazetteer.rs")
        });
        let i = self.city_table.len() as i64;
        self.city_table.push(AtlasCity {
            zh: zh.to_string(),
            en: city_en.get(zh).cloned().unwrap_or_else(|| zh.to_string()),
            pt,
        });
        self.city_idx.insert(zh.to_string(), i);
        i
    }

    fn station(&mut self, zh: &str, city_en: &HashMap<String, String>) -> i64 {
        if let Some(i) = self.station_idx.get(zh) {
            return *i;
        }
        let i = self.station_table.len() as i64;
        self.station_table.push(AtlasStation {
            zh: zh.to_string(),
            en: station_en(zh, city_en),
            pt: None,
            city: None,
            closeup: None,
        });
        self.station_idx.insert(zh.to_string(), i);
        i
    }

    /// The train_table row of train `ti` (an index into `inp.trains`): one row
    /// per train, so two trains sharing a code stay apart.
    fn train(&mut self, inp: &inputs::Inputs, ti: usize) -> usize {
        if let Some(i) = self.train_idx.get(&ti) {
            return *i;
        }
        let i = self.train_table.len();
        let t = &inp.trains[ti];
        let cal = inp.calendar.as_ref().map(|(c, _)| &c[ti]);
        self.train_table.push(AtlasTrainRef {
            code: t.code.clone(),
            class: t.train_class.clone(),
            days: cal.map(|c| c.days.clone()),
            pattern: cal.and_then(|c| c.pattern.clone()),
            suspended: cal.and_then(|c| c.listed_suspended.then_some(true)),
        });
        self.train_ti.push(ti);
        self.train_idx.insert(ti, i);
        i
    }
}

/// The outbound pass's results.
struct OutPass {
    works: Vec<CityWork>,
    /// dep rows with stations that have no city call: [home city, terminus
    /// city, intermediate city, any]; and the distinct trains behind "any"
    skipped_rows: [u64; 4],
    skipped_trains: HashSet<String>,
    skipped_example: [Option<String>; 3],
    throat_stations: HashSet<String>,
}

/// Per-city work: for each selected city, every train departing from it.
fn outbound_works(
    cx: &Ctx,
    selected: &[String],
    city_pt: &HashMap<String, [f64; 2]>,
    corr: &Corridor,
    lc: &mut LegCaches,
) -> OutPass {
    let inp = cx.inp;
    let (trains, d1_len) = (&inp.trains, inp.d1_len);
    let (override_map, path_map) = (&inp.override_map, &inp.path_map);
    let (train_names, train_cities) = (&cx.train_names, &cx.train_cities);
    let station_pt = |name: &str| -> Option<[f64; 2]> { cx.station_pt(name) };

    let mut works: Vec<CityWork> = Vec::new();
    // dep rows with stations that have no city call: [home city, terminus
    // city, intermediate city, any]; and the distinct trains behind "any"
    let mut skipped_rows = [0u64; 4];
    let mut skipped_trains: HashSet<String> = HashSet::new();
    let mut skipped_example: [Option<String>; 3] = [None, None, None];
    let mut throat_stations: HashSet<String> = HashSet::new();
    for home_city in selected.iter() {
        let mut out_stats: HashMap<String, DestStats> = HashMap::new();
        let mut counter = 0usize;
        let mut leg_count: HashMap<(String, String, String), u64> = HashMap::new();
        let mut deps: Vec<DepRaw> = Vec::new();
        let mut outbound = 0u64;
        let mut train_legs: Vec<TrainLegs> = Vec::new();
        for (ti, t) in trains.iter().enumerate() {
            let names = &train_names[ti];
            let cities = &train_cities[ti];
            let Some(cd_idx) = flows::departs_from(cities, home_city) else {
                continue;
            };
            outbound += 1;
            let is_fast = ["G", "D", "C", "S"].contains(&t.train_class.as_str());
            let final_city = cities.last().unwrap().clone();
            let mut legs: Vec<(String, String, String)> = Vec::new();
            let (mut leg_fwd, mut leg_stop) = (Vec::new(), Vec::new());
            let mut leg_prefix: Vec<usize> = vec![0; names.len()];
            for k in cd_idx..(names.len() - 1) {
                let (a, b) = (names[k].clone(), names[k + 1].clone());
                if a != b {
                    let key = leg_key3(override_map, t, &a, &b);
                    *leg_count.entry(key.clone()).or_insert(0) += 1;
                    legs.push(key);
                    leg_fwd.push(a < b);
                    leg_stop.push(k);
                }
                leg_prefix[k + 1] = legs.len();
            }
            deps.push(DepRaw {
                code: t.code.clone(),
                from_station: names[cd_idx].clone(),
                depart: t.stops[cd_idx].depart.clone(),
                to_station: names.last().unwrap().clone(),
                to_city: final_city.clone(),
                arrive: t.stops.last().unwrap().arrive.clone(),
                dur: travel_time(&t.stops, cd_idx, t.stops.len() - 1),
                stops_after: (t.stops.len() - 1 - cd_idx) as u64,
                set: if ti < d1_len { 0 } else { 1 },
                km: -1.0,
                leg_keys: legs.clone(),
                leg_fwd,
                leg_stop,
                board: cd_idx,
                ti,
            });
            let mut seen_dest: HashSet<String> = HashSet::new();
            let mut skipped = [false; 3];
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
                        match leg_km(override_map, &corr.pair_len, t, &a, &b) {
                            Some(l) => cum_km += l,
                            None => cum_ok = false,
                        }
                    }
                    last_k += 1;
                }
                if &cities[j] == home_city || !seen_dest.insert(cities[j].clone()) {
                    // a station with no city call of its own: in the home
                    // city, at the terminus city, or in an intermediate city
                    let class = if &cities[j] == home_city {
                        0
                    } else if j == cities.len() - 1 {
                        1
                    } else {
                        2
                    };
                    skipped[class] = true;
                    skipped_example[class].get_or_insert_with(|| {
                        format!("{} from {}: {}", t.code, home_city, names[j])
                    });
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
                let tt = travel_time(&t.stops, cd_idx, j);
                if let Some(ttv) = tt {
                    if ttv > 0 && ttv < 6000 {
                        e.times.push(ttv);
                    }
                }
                if cum_ok && cum_km > 0.0 {
                    e.rail.push(cum_km);
                }
                let off = match (mins(&t.stops[cd_idx].depart), tt) {
                    (Some(dm), Some(ttv)) => (dm + ttv) / 1440,
                    _ => 0,
                };
                e.calls.push(CallRaw {
                    ti,
                    from_station: names[cd_idx].clone(),
                    depart: t.stops[cd_idx].depart.clone(),
                    arr: t.stops[j].arrive.clone(),
                    dep: t.stops[j].depart.clone(),
                    off,
                    term: final_city == dest,
                    leg_cnt: leg_prefix[j],
                });
            }
            if cum_ok && cum_km > 0.0 {
                if let Some(d0) = deps.last_mut() {
                    d0.km = cum_km;
                }
            }
            for (n, hit) in skipped_rows.iter_mut().zip(skipped) {
                *n += hit as u64;
            }
            if skipped.iter().any(|&x| x) {
                skipped_rows[3] += 1;
                skipped_trains.insert(t.code.clone());
            }
            train_legs.push((class_idx(&t.train_class), ti, legs));
        }
        let mut legs_vec: Vec<((String, String, String), u64)> = Vec::new();
        let mut resolved_flags: HashMap<(String, String, String), bool> = HashMap::new();
        for (k, n) in leg_count.iter() {
            let r = resolve_leg3(
                k,
                path_map,
                &corr.adj_pure,
                &corr.adj,
                &corr.pair_len,
                &station_pt,
                &mut lc.leg_cache,
                &mut lc.variant_cache,
                &mut lc.variant_stats,
            );
            resolved_flags.insert(k.clone(), r.is_some());
            legs_vec.push((k.clone(), *n));
            throat_stations.insert(k.0.clone());
            throat_stations.insert(k.1.clone());
        }
        let mut fully = 0u64;
        for (_, _, legs) in train_legs.iter() {
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
        });
    }
    OutPass {
        works,
        skipped_rows,
        skipped_trains,
        skipped_example,
        throat_stations,
    }
}

/// Inbound works: for each selected city, every train arriving there.
/// Mirror of the outbound pass. cd_in = the train's first stop in the city
/// at index >= 1 (a real arrival). Sources = every distinct city boarded
/// before a later arrival in this city; per source, the arrival used is
/// the first home-city stop AFTER boarding, which makes the pair identity
/// srcs[X][P].total == dests[P][X].total exact (checked at assembly).
fn inbound_works(
    cx: &Ctx,
    selected: &[String],
    city_pt: &HashMap<String, [f64; 2]>,
    corr: &Corridor,
) -> Vec<InCityWork> {
    let inp = cx.inp;
    let (trains, d1_len) = (&inp.trains, inp.d1_len);
    let override_map = &inp.override_map;
    let (train_names, train_cities) = (&cx.train_names, &cx.train_cities);

    let mut in_works: Vec<InCityWork> = Vec::new();
    for home_city in selected.iter() {
        let mut src_stats: HashMap<String, InSrcStats> = HashMap::new();
        let mut counter = 0usize;
        let mut arrs: Vec<InArrRaw> = Vec::new();
        let mut train_leg_keys_in: Vec<TrainLegs> = Vec::new();
        for (ti, t) in trains.iter().enumerate() {
            let names = &train_names[ti];
            let cities = &train_cities[ti];
            let Some(cd_in) = flows::arrives_at(cities, home_city) else {
                continue;
            };
            let is_fast = ["G", "D", "C", "S"].contains(&t.train_class.as_str());
            // prefix track distances from stop 0: cumulative km + bad-leg count
            let mut pref_km: Vec<f64> = vec![0.0; cities.len()];
            let mut pref_bad: Vec<i64> = vec![0; cities.len()];
            for k in 1..cities.len() {
                let (a, b) = (names[k - 1].clone(), names[k].clone());
                pref_bad[k] = pref_bad[k - 1];
                pref_km[k] = pref_km[k - 1];
                if a != b {
                    match leg_km(override_map, &corr.pair_len, t, &a, &b) {
                        Some(l) => pref_km[k] += l,
                        None => pref_bad[k] += 1,
                    }
                }
            }
            let journey_km = if pref_bad[cd_in] == 0 && pref_km[cd_in] > 0.0 {
                pref_km[cd_in]
            } else {
                -1.0
            };
            let mut legs: Vec<(String, String, String)> = Vec::new();
            let (mut leg_fwd, mut leg_stop) = (Vec::new(), Vec::new());
            let mut leg_prefix: Vec<usize> = vec![0; cities.len()];
            for k in 0..cd_in {
                let (a, b) = (names[k].clone(), names[k + 1].clone());
                if a != b {
                    legs.push(leg_key3(override_map, t, &a, &b));
                    leg_fwd.push(a < b);
                    leg_stop.push(k);
                }
                leg_prefix[k + 1] = legs.len();
            }
            for p in leg_prefix.iter_mut().skip(cd_in + 1) {
                *p = legs.len();
            }
            arrs.push(InArrRaw {
                code: t.code.clone(),
                from_station: names[0].clone(),
                from_city: cities[0].clone(),
                depart: t.stops[0].depart.clone(),
                arr_station: names[cd_in].clone(),
                arrive: t.stops[cd_in].arrive.clone(),
                dur: travel_time(&t.stops, 0, cd_in),
                stops_before: cd_in as u64,
                set: if ti < d1_len { 0 } else { 1 },
                km: journey_km,
                leg_keys: legs.clone(),
                leg_fwd,
                leg_stop,
                ti,
            });
            // sources: distinct cities (first index each), home city excluded
            let mut seen_src: HashSet<String> = HashSet::new();
            let mut src_list: Vec<(String, usize)> = Vec::new();
            // k walks cities/names in lockstep; the index is the join.
            #[allow(clippy::needless_range_loop)]
            for k in 0..cities.len() {
                if &cities[k] == home_city {
                    continue;
                }
                if seen_src.insert(cities[k].clone()) {
                    src_list.push((cities[k].clone(), k));
                }
            }
            for (pcity, p_idx) in src_list.iter() {
                let p_idx = *p_idx;
                let arr_j = match (p_idx + 1..cities.len()).find(|&j| &cities[j] == home_city) {
                    Some(j) => j,
                    None => continue,
                };
                let e = src_stats.entry(pcity.clone()).or_insert_with(|| {
                    let v = counter;
                    counter += 1;
                    InSrcStats {
                        first: v,
                        ..Default::default()
                    }
                });
                e.total += 1;
                if is_fast {
                    e.fast += 1;
                }
                if p_idx == 0 {
                    e.originating += 1;
                }
                let tt = travel_time(&t.stops, p_idx, arr_j);
                if let Some(ttv) = tt {
                    if ttv > 0 && ttv < 6000 {
                        e.times.push(ttv);
                    }
                }
                if pref_bad[arr_j] - pref_bad[p_idx] == 0 {
                    let d = pref_km[arr_j] - pref_km[p_idx];
                    if d > 0.0 {
                        e.rail.push(d);
                    }
                }
                let off = match (mins(&t.stops[p_idx].depart), tt) {
                    (Some(dm), Some(ttv)) => (dm + ttv) / 1440,
                    _ => 0,
                };
                e.calls.push(InCallRaw {
                    ti,
                    from_station: names[p_idx].clone(),
                    depart: t.stops[p_idx].depart.clone(),
                    arr: t.stops[arr_j].arrive.clone(),
                    off,
                    started: p_idx == 0,
                    okey_station: names[0].clone(),
                    okey_depart: t.stops[0].depart.clone(),
                    set: if ti < d1_len { 0 } else { 1 },
                    leg_start: leg_prefix[p_idx.min(cd_in)],
                });
            }
            train_leg_keys_in.push((class_idx(&t.train_class), ti, legs));
        }
        arrs.sort_by(|x, y| x.arrive.cmp(&y.arrive).then(x.code.cmp(&y.code)));
        let mut sources: Vec<(String, InSrcStats)> = src_stats.into_iter().collect();
        sources.sort_by(|a, b| b.1.total.cmp(&a.1.total).then(a.1.first.cmp(&b.1.first)));
        let hp = city_pt.get(home_city).copied().unwrap_or([30.63, 104.13]);
        println!(
            "IN {}: arrivals {} sources {}",
            home_city,
            arrs.len(),
            sources.len()
        );
        in_works.push(InCityWork {
            zh: home_city.clone(),
            arrivals: arrs.len() as u64,
            sources,
            arrs,
            home_pt: [hp[1], hp[0]],
            train_leg_keys: train_leg_keys_in,
        });
    }
    in_works
}

/// Inbound legs resolve exactly like outbound ones. Legs before the first
/// selected city on a train are never seen outbound, so resolve them here
/// (cached per key, so outbound legs are unaffected). Their stations trim
/// throats in the inbound pass only, which keeps outbound flows unchanged.
/// Returns the stations that trim throats in the inbound pass.
fn resolve_inbound_legs(
    cx: &Ctx,
    out: &OutPass,
    in_works: &[InCityWork],
    corr: &Corridor,
    lc: &mut LegCaches,
) -> HashSet<String> {
    let path_map = &cx.inp.path_map;
    let throat_stations = &out.throat_stations;
    let station_pt = |name: &str| -> Option<[f64; 2]> { cx.station_pt(name) };

    let mut in_throat_stations = throat_stations.clone();
    for key in in_works
        .iter()
        .flat_map(|w| w.train_leg_keys.iter())
        .flat_map(|(_, _, legs)| legs.iter())
    {
        in_throat_stations.insert(key.0.clone());
        in_throat_stations.insert(key.1.clone());
        resolve_leg3(
            key,
            path_map,
            &corr.adj_pure,
            &corr.adj,
            &corr.pair_len,
            &station_pt,
            &mut lc.leg_cache,
            &mut lc.variant_cache,
            &mut lc.variant_stats,
        );
    }
    in_throat_stations
}

/// Leg walks: every resolved leg oriented key.0 -> key.1.
fn orient_legs(
    cx: &Ctx,
    works: &[CityWork],
    in_works: &[InCityWork],
    lc: &LegCaches,
) -> HashMap<(String, String, String), LegWalk> {
    let (path_map, coords) = (&cx.inp.path_map, &cx.inp.coords);
    let station_pt = |name: &str| -> Option<[f64; 2]> { cx.station_pt(name) };

    // One-time direction check: base pair paths must already run
    // key.0 -> key.1 (fail loudly otherwise); router, variant (via) and
    // corridor-chain geometry is oriented from coordinates and reported.
    let mut leg_walks: HashMap<(String, String, String), LegWalk> = HashMap::new();
    // kind -> [as stored, reversed, mixed, unchecked (station point missing/untrusted)]
    let mut orient_stats: std::collections::BTreeMap<&str, [u64; 4]> = Default::default();
    let mut bad_pairs: Vec<String> = Vec::new();
    let out_keys = works
        .iter()
        .flat_map(|w| w.deps.iter())
        .flat_map(|d| d.leg_keys.iter());
    let in_keys = in_works
        .iter()
        .flat_map(|w| w.arrs.iter())
        .flat_map(|a| a.leg_keys.iter());
    for key in out_keys.chain(in_keys) {
        if leg_walks.contains_key(key) {
            continue;
        }
        let Some(seqs) = leg_seqs(key, &lc.leg_cache, &lc.variant_cache) else {
            continue;
        };
        let kind = if leg_path(&key.2).is_some() {
            "router"
        } else if !key.2.is_empty() {
            "variant"
        } else if path_map
            .get(&(key.0.clone(), key.1.clone()))
            .is_some_and(|(_, segs)| segs.iter().any(|s| s.len() >= 2))
        {
            "pair"
        } else {
            "chain"
        };
        let st = orient_stats.entry(kind).or_default();
        let oriented = match (station_pt(&key.0), station_pt(&key.1)) {
            (Some(p0), Some(p1)) => Some(orient_leg(seqs, coords, [p0[1], p0[0]], [p1[1], p1[0]])),
            _ => None,
        };
        let stored = || {
            let ends: Vec<[f64; 2]> = seqs
                .iter()
                .flat_map(|s| {
                    let first = s.iter().find_map(|id| coords.get(id));
                    let last = s.iter().rev().find_map(|id| coords.get(id));
                    first.zip(last).map(|(a, b)| [*a, *b])
                })
                .flatten()
                .collect();
            let max_gap = ends
                .chunks(2)
                .collect::<Vec<_>>()
                .windows(2)
                .map(|w| hav_km_ll(w[0][1], w[1][0]))
                .chain(seqs.iter().map(|s| seg_hole(s, coords)))
                .fold(0.0, f64::max);
            LegWalk {
                steps: (0..seqs.len()).map(|i| (i, false)).collect(),
                max_gap,
            }
        };
        let walk = match oriented {
            Some((walk, end_gap)) if end_gap <= ORIENT_TRUST_KM => {
                let as_stored = walk.steps.windows(2).all(|w| w[0].0 < w[1].0)
                    && walk.steps.iter().all(|s| !s.1);
                let reversed = walk.steps.windows(2).all(|w| w[0].0 > w[1].0)
                    && walk.steps.iter().all(|s| s.1);
                st[if as_stored {
                    0
                } else if reversed {
                    1
                } else {
                    2
                }] += 1;
                if kind == "pair" && !as_stored {
                    bad_pairs.push(format!("{} -> {} {:?}", key.0, key.1, walk.steps));
                }
                walk
            }
            _ => {
                st[3] += 1;
                stored()
            }
        };
        leg_walks.insert(key.clone(), walk);
    }
    for (kind, st) in orient_stats.iter() {
        println!(
            "leg orientation {kind}: as stored {} reversed {} mixed {} unchecked {}",
            st[0], st[1], st[2], st[3]
        );
    }
    assert!(
        bad_pairs.is_empty(),
        "pair paths not stored key.0 -> key.1: {bad_pairs:?}"
    );
    println!("leg orientation: all checked pair paths run key.0 -> key.1");
    leg_walks
}

/// Grid of station points (50 cells per degree), for `near_station`.
fn throat_grid(cx: &Ctx, names: &HashSet<String>) -> StationGrid {
    let mut grid: StationGrid = HashMap::new();
    for nm in names.iter() {
        if let Some(p) = cx.station_pt(nm) {
            let ll = [p[1], p[0]];
            grid.entry(((ll[0] * 50.0).floor() as i32, (ll[1] * 50.0).floor() as i32))
                .or_default()
                .push(ll);
        }
    }
    grid
}

fn near_station(station_grid: &StationGrid, pt: &[f64; 2]) -> bool {
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
}

/// Section endpoint station names (nearest real station point).
fn section_station_points(cx: &Ctx) -> HashMap<String, [f64; 2]> {
    let mut station_pts_all: HashMap<String, [f64; 2]> = HashMap::new();
    for (a, b) in cx.inp.path_map.keys() {
        for s in [a, b] {
            if let Some(p) = cx.station_pt(s) {
                station_pts_all.insert(s.clone(), [p[1], p[0]]);
            }
        }
    }
    station_pts_all
}

/// Everything the section, assembly and national phases read once the
/// per-city passes and the leg walks are done.
struct Model<'a> {
    cx: &'a Ctx<'a>,
    selected: Vec<String>,
    city_pt: HashMap<String, [f64; 2]>,
    corr: Corridor,
    lc: LegCaches,
    out: OutPass,
    in_works: Vec<InCityWork>,
    leg_walks: HashMap<(String, String, String), LegWalk>,
    station_grid: StationGrid,
    in_station_grid: StationGrid,
    station_pts_all: HashMap<String, [f64; 2]>,
}

/// The atomic sections of one direction, with their per-city flow rows.
struct SectionSet {
    sections: Vec<AtlasSection>,
    /// directed edge -> (section, travelled against the section's stored
    /// point order)
    edge_dir_to_sec: HashMap<(i64, i64), (usize, bool)>,
    flows_per_city: Vec<Vec<Vec<usize>>>,
    total_sec_pts: usize,
    /// edges per section (row_path's partial re-coverage, national heads)
    sec_edges: Vec<usize>,
}

/// Atomic edge -> per-city DISTINCT train counts: each train counts at
/// most once per edge, no matter how many of its legs' paths overlap
/// there (adjacent-leg path overlap near stations otherwise inflates
/// short sections between close stations). The rule lives in
/// flows::train_edges, shared with the inbound and national counts.
struct EdgeCounts {
    counts: HashMap<(i64, i64), HashMap<usize, u64>>,
    class_counts: HashMap<(i64, i64), HashMap<usize, [u32; 8]>>,
    trains: chains::EdgeTrains,
}

/// `per_city[ci]` is city `ci`'s trains' leg keys.
fn count_edges<'a>(
    per_city: impl Iterator<Item = &'a Vec<TrainLegs>>,
    lc: &LegCaches,
    coords: &HashMap<i64, [f64; 2]>,
    station_grid: &StationGrid,
) -> EdgeCounts {
    let seqs_of = |k: &(String, String, String)| leg_seqs(k, &lc.leg_cache, &lc.variant_cache);
    let mut edge_counts: HashMap<(i64, i64), HashMap<usize, u64>> = HashMap::new();
    let mut edge_class_counts: HashMap<(i64, i64), HashMap<usize, [u32; 8]>> = HashMap::new();
    let mut edge_trains = chains::EdgeTrains::new();
    for (ci, train_leg_keys) in per_city.enumerate() {
        for (k, (cidx, _, legs)) in train_leg_keys.iter().enumerate() {
            let eset = flows::train_edges(legs, seqs_of, coords, |p| near_station(station_grid, p));
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
    EdgeCounts {
        counts: edge_counts,
        class_counts: edge_class_counts,
        trains: edge_trains,
    }
}

/// Turn the section chains into `AtlasSection`s (interning their endpoint
/// stations) and the per-city packed flow rows.
fn build_sections(
    cx: &Ctx,
    section_chains: &[(u32, Vec<i64>)],
    sig_list: &[chains::Sig],
    n_cities: usize,
    station_pts_all: &HashMap<String, [f64; 2]>,
    it: &mut Interner,
) -> SectionSet {
    let (coords, city_en) = (&cx.inp.coords, &cx.inp.city_en);

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
    // directed edge -> (section, travelled against the section's stored
    // point order); built here, where sec_idx is known (chains with too
    // few points are skipped, so chain and section indices drift).
    let mut edge_dir_to_sec: HashMap<(i64, i64), (usize, bool)> = HashMap::new();
    let mut sections: Vec<AtlasSection> = Vec::new();
    let mut flows_per_city: Vec<Vec<Vec<usize>>> = vec![Vec::new(); n_cities];
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
        for win in chain.windows(2) {
            edge_dir_to_sec.insert((win[0], win[1]), (sec_idx, false));
            edge_dir_to_sec.insert((win[1], win[0]), (sec_idx, true));
        }
        let a_nm = nearest_station(simp[0]);
        let b_nm = nearest_station(*simp.last().unwrap());
        let a_i = if a_nm.is_empty() {
            -1
        } else {
            it.station(&a_nm, city_en)
        };
        let b_i = if b_nm.is_empty() {
            -1
        } else {
            it.station(&b_nm, city_en)
        };
        sections.push(AtlasSection {
            a: a_i,
            b: b_i,
            g: polyline_encode(&simp),
            h: cx.chain_hsr(chain),
            l: cx
                .chain_lines(chain)
                .into_iter()
                .map(|li| it.line(li, &cx.ways.lines))
                .collect(),
            v: cx.chain_speed(chain),
        });
        for (ci, n, cls_counts) in sig_list[*sid as usize].iter() {
            flows_per_city[*ci].push(pack_flow_row(sec_idx, *n as usize, cls_counts));
        }
    }
    for f in flows_per_city.iter_mut() {
        f.sort_by(|a, b| b[1].cmp(&a[1]));
    }
    // edges per section (row_path's partial re-coverage, national heads)
    let mut sec_edges = vec![0usize; sections.len()];
    for &(s, rev) in edge_dir_to_sec.values() {
        sec_edges[s] += !rev as usize;
    }
    SectionSet {
        sections,
        edge_dir_to_sec,
        flows_per_city,
        total_sec_pts,
        sec_edges,
    }
}

/// Atomic sections of one direction: outbound, the global sections over
/// the union of all selected cities; inbound, the same machinery indexed
/// by dest city. `per_city[ci]` is city `ci`'s trains' leg keys, `rows`
/// the direction's rows (deps / arrs) for the chain cuts.
fn sections<'a>(
    m: &Model,
    it: &mut Interner,
    per_city: impl ExactSizeIterator<Item = &'a Vec<TrainLegs>>,
    rows: impl Iterator<Item = (&'a [(String, String, String)], &'a [bool])>,
    inbound: bool,
) -> SectionSet {
    let cx = m.cx;
    let (coords, lc, leg_walks) = (&cx.inp.coords, &m.lc, &m.leg_walks);
    let n_cities = per_city.len();
    let (grid, dir, tag) = if inbound {
        (&m.in_station_grid, "inbound ", "in_")
    } else {
        (&m.station_grid, "", "")
    };
    let ec = count_edges(per_city, lc, coords, grid);
    println!("union {dir}atomic edges: {}", ec.counts.len());
    // intern count signatures: a global section has constant per-city counts
    let (sig_list, edge_sig) = chains::intern_sigs(&ec.counts, &ec.class_counts);
    if !inbound {
        println!("distinct signatures: {}", sig_list.len());
    }

    let walk_geom = |key: &(String, String, String)| {
        leg_seqs(key, &lc.leg_cache, &lc.variant_cache).zip(leg_walks.get(key))
    };
    let cuts = chain_cuts(rows, &walk_geom, &edge_sig);
    if inbound {
        println!("inbound section chain cuts: {}", cuts.len());
    } else {
        println!(
            "section chain cuts (rows leaving equal-signature track mid-way): {}",
            cuts.len()
        );
    }
    let section_chains = chains::build_section_chains(&edge_sig, &ec.trains, &cuts);
    let ss = build_sections(
        cx,
        &section_chains,
        &sig_list,
        n_cities,
        &m.station_pts_all,
        it,
    );
    println!(
        "{tag}sections: {} points: {}",
        ss.sections.len(),
        ss.total_sec_pts
    );
    ss
}

/// P3.1 national table over `sections`: every train once.
/// A train's legs are the union of its outbound rows (from its first
/// selected city on) and inbound rows (from its first stop to a selected
/// city), so it covers its whole run whenever it calls at a selected city.
/// Edges go through the same rule as the per-city counts (one count per
/// edge, outbound near_station grid); a train counts once on a section
/// when it covers any of its edges (flows::national_table).
fn national_table(
    m: &Model,
    os: &SectionSet,
) -> (
    std::collections::BTreeMap<usize, TrainLegs>,
    flows::National,
) {
    let (coords, lc) = (&m.cx.inp.coords, &m.lc);
    let (works, in_works) = (&m.out.works, &m.in_works);
    let station_grid = &m.station_grid;
    let (edge_dir_to_sec, sections) = (&os.edge_dir_to_sec, &os.sections);
    let seqs_of = |k: &(String, String, String)| leg_seqs(k, &lc.leg_cache, &lc.variant_cache);

    let mut nat_legs: std::collections::BTreeMap<usize, TrainLegs> = Default::default();
    let all_legs = works
        .iter()
        .flat_map(|w| w.train_leg_keys.iter())
        .chain(in_works.iter().flat_map(|w| w.train_leg_keys.iter()));
    for (cidx, ti, legs) in all_legs {
        nat_legs
            .entry(*ti)
            .or_insert_with(|| (*cidx, *ti, Vec::new()))
            .2
            .extend(legs.iter().cloned());
    }
    for (_, _, legs) in nat_legs.values_mut() {
        legs.sort();
        legs.dedup();
    }
    let nat_trains = nat_legs.values().map(|(cidx, ti, legs)| {
        let eset = flows::train_edges(legs, seqs_of, coords, |p| near_station(station_grid, p));
        (*ti, *cidx, eset)
    });
    let (national, nat_u) = flows::national_table(
        nat_trains,
        |e| edge_dir_to_sec.get(e).map(|&(s, _)| s),
        sections.len(),
    );
    println!(
        "national: {} trains; widest section {}; sum over sections {}",
        national.trains,
        national.total.iter().max().copied().unwrap_or(0),
        national.total.iter().map(|&n| n as u64).sum::<u64>()
    );
    println!(
        "national uniformity: {} sections with unequal per-edge counts (max spread {}); {} sections whose distinct trains exceed their busiest edge (max +{})",
        nat_u.nonuniform, nat_u.max_spread, nat_u.union_above_max, nat_u.max_union_gain
    );
    (nat_legs, national)
}

/// What `assemble_origins` threads through the per-city loop.
struct Assembled {
    origins: Vec<AtlasOrigin>,
    /// O1: throat pieces shared by both directions; path entries `base + j`
    /// with base = that direction's section count
    throats: Throats,
    throat_drops: [u64; 2],
}

#[derive(Default)]
struct AsmCounters {
    chord_legs_out: usize,
    chord_legs_in: usize,
    pair_mismatch: u64,
}

/// The outbound half of one origin's assembly.
struct OutSide {
    dep_secs: Vec<Vec<i64>>,
    dep_chord_legs: Vec<Vec<[usize; 3]>>,
    dep_stop_pos: Vec<Vec<usize>>,
    dests: Vec<[i64; 8]>,
    calls_out: Vec<CallList>,
    chords: Vec<AtlasChord>,
    deps: Vec<AtlasDep>,
}

/// The inbound half of one origin's assembly.
struct InSide {
    arr_secs: Vec<Vec<i64>>,
    arr_chord_legs: Vec<Vec<[usize; 3]>>,
    srcs: Vec<[i64; 8]>,
    in_calls_out: Vec<InCallList>,
    arrs_out: Vec<AtlasArr>,
}

fn assemble_outbound(
    m: &Model,
    os: &SectionSet,
    asm: &mut Assembled,
    cnt: &mut AsmCounters,
    it: &mut Interner,
    w: &CityWork,
) -> OutSide {
    let cx = m.cx;
    let (coords, city_en, city_pt) = (&cx.inp.coords, &cx.inp.city_en, &m.city_pt);
    let lc = &m.lc;
    let station_pt = |name: &str| -> Option<[f64; 2]> { cx.station_pt(name) };
    let station_grid = &m.station_grid;
    let (sections, edge_dir_to_sec, sec_edges) = (&os.sections, &os.edge_dir_to_sec, &os.sec_edges);
    let geom = |key: &(String, String, String)| {
        leg_seqs(key, &lc.leg_cache, &lc.variant_cache).zip(m.leg_walks.get(key))
    };
    let (throats, throat_drops) = (&mut asm.throats, &mut asm.throat_drops);
    let chord_legs_out = &mut cnt.chord_legs_out;
    let inp = cx.inp;

    // dep_secs: sections in travel order, a section again whenever the
    // train runs back over it (flows dedupe per train separately, above);
    // `!sec` (= -(sec + 1)) marks a section travelled against its
    // stored point order; entries >= sections.len() are throats (O1,
    // see row_path). Positions count every entry; call sec_cnt counts
    // flow sections only (dep_leg_sec_cnt = RowPath::flow_cnt).
    let mut dep_secs: Vec<Vec<i64>> = Vec::with_capacity(w.deps.len());
    let mut dep_leg_sec_cnt: Vec<Vec<usize>> = Vec::with_capacity(w.deps.len());
    let mut dep_chord_legs: Vec<Vec<[usize; 3]>> = Vec::with_capacity(w.deps.len());
    // dep_stop_pos: per dep row, the path position of every stop after
    // boarding (entries before it = full_cnt at its stop, so the stop
    // sits at the start of the departing leg's station throat), station
    // level; times and stations come from schedules[t]
    let mut dep_stop_pos: Vec<Vec<usize>> = Vec::with_capacity(w.deps.len());
    for d in w.deps.iter() {
        let p = row_path(
            &d.leg_keys,
            &d.leg_fwd,
            &d.leg_stop,
            &geom,
            &|u, v| edge_dir_to_sec.get(&(u, v)).copied(),
            sec_edges,
            &|_, _, p| near_station(station_grid, p).then_some(None),
            coords,
            throats,
            sections.len(),
            throat_drops,
        );
        let chord_legs = p.chord_legs;
        *chord_legs_out += chord_legs.len();
        dep_stop_pos.push(
            ((d.board + 1)..=(d.board + d.stops_after as usize))
                .map(|j| p.full_cnt[d.leg_stop.partition_point(|&s| s < j)])
                .collect(),
        );
        dep_secs.push(p.secs);
        dep_leg_sec_cnt.push(p.flow_cnt);
        dep_chord_legs.push(chord_legs);
    }
    let dep_lookup: HashMap<DepKey, usize> = w
        .deps
        .iter()
        .enumerate()
        .map(|(i, d)| ((d.ti, d.from_station.clone(), d.depart.clone()), i))
        .collect();
    let mut dests: Vec<[i64; 8]> = Vec::new();
    let mut calls_out: Vec<CallList> = Vec::new();
    for (zh, st) in w.dests.iter() {
        let dp = match city_pt.get(zh) {
            Some(p) => *p,
            None => continue,
        };
        let idx = it.city(zh, city_en, city_pt);
        let mut times = st.times.clone();
        times.sort();
        let fastest = times.first().copied().unwrap_or(-1);
        let median_v = if times.is_empty() {
            -1
        } else {
            times[times.len() / 2]
        };
        // crow-flies km (origin pt -> destination city pt) and rail km
        // (median over direct trains of summed track leg lengths)
        let crow = hav_km_ll(w.home_pt, [dp[1], dp[0]]).round() as i64;
        let mut rail = st.rail.clone();
        rail.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let rail_v = if rail.is_empty() {
            -1
        } else {
            rail[rail.len() / 2].round() as i64
        };
        dests.push([
            idx,
            st.total as i64,
            st.fast as i64,
            st.terminating as i64,
            fastest,
            median_v,
            crow,
            rail_v,
        ]);
        let mut cl: Vec<(usize, String, String, i64, u8, usize)> = Vec::new();
        for c in st.calls.iter() {
            if let Some(di) = dep_lookup.get(&(c.ti, c.from_station.clone(), c.depart.clone())) {
                let sec_cnt = dep_leg_sec_cnt[*di]
                    .get(c.leg_cnt)
                    .copied()
                    .unwrap_or(*dep_leg_sec_cnt[*di].last().unwrap());
                cl.push((
                    *di,
                    c.arr.clone(),
                    c.dep.clone(),
                    c.off,
                    if c.term { 1 } else { 0 },
                    sec_cnt,
                ));
            }
        }
        cl.sort_by_key(|r| (r.3, mins(&r.1).unwrap_or(0)));
        if cl.len() as u64 != st.total {
            println!(
                "CALLS MISMATCH {} -> {}: {} calls vs total {}",
                w.zh,
                zh,
                cl.len(),
                st.total
            );
        }
        calls_out.push(cl);
    }
    let mut chords: Vec<AtlasChord> = Vec::new();
    for (key, n) in w.legs.iter() {
        let resolved = leg_seqs(key, &lc.leg_cache, &lc.variant_cache).is_some();
        if resolved {
            continue;
        }
        if let (Some(p1), Some(p2)) = (station_pt(&key.0), station_pt(&key.1)) {
            let a_i = it.station(&key.0, city_en);
            let b_i = it.station(&key.1, city_en);
            chords.push(AtlasChord {
                a: a_i,
                b: b_i,
                n: *n,
                g: polyline_encode(&[[p1[1], p1[0]], [p2[1], p2[0]]]),
            });
        }
    }
    let mut deps: Vec<AtlasDep> = Vec::new();
    for d in w.deps.iter() {
        let t_i = it.train(inp, d.ti);
        let fs_i = it.station(&d.from_station, city_en);
        let ts_i = it.station(&d.to_station, city_en);
        let tc_i = it.city(&d.to_city, city_en, city_pt);
        deps.push(AtlasDep {
            t: t_i,
            fs: fs_i,
            dep: d.depart.clone(),
            ts: ts_i,
            tc: tc_i,
            arr: d.arrive.clone(),
            dur: d.dur.unwrap_or(-1),
            stops: d.stops_after,
            set: d.set,
            km: if d.km > 0.0 { d.km.round() as i64 } else { -1 },
        });
    }
    OutSide {
        dep_secs,
        dep_chord_legs,
        dep_stop_pos,
        dests,
        calls_out,
        chords,
        deps,
    }
}

fn assemble_inbound(
    m: &Model,
    is_: &SectionSet,
    asm: &mut Assembled,
    cnt: &mut AsmCounters,
    it: &mut Interner,
    iw: &InCityWork,
) -> InSide {
    let cx = m.cx;
    let (coords, city_en, city_pt) = (&cx.inp.coords, &cx.inp.city_en, &m.city_pt);
    let lc = &m.lc;
    let (selected, works) = (&m.selected, &m.out.works);
    let in_station_grid = &m.in_station_grid;
    let (in_sections, in_edge_dir_to_sec, in_sec_edges) =
        (&is_.sections, &is_.edge_dir_to_sec, &is_.sec_edges);
    let geom = |key: &(String, String, String)| {
        leg_seqs(key, &lc.leg_cache, &lc.variant_cache).zip(m.leg_walks.get(key))
    };
    let (throats, throat_drops) = (&mut asm.throats, &mut asm.throat_drops);
    let chord_legs_in = &mut cnt.chord_legs_in;
    let pair_mismatch = &mut cnt.pair_mismatch;
    let inp = cx.inp;

    // arr_secs: same encoding as dep_secs (throats >= in_sections.len()),
    // in travel order (train origin -> arrival here). arr_leg_sec_cnt[li]
    // = flow sections from leg li to the arrival, so a call's sec_cnt is
    // the trailing count.
    let mut arr_secs: Vec<Vec<i64>> = Vec::with_capacity(iw.arrs.len());
    let mut arr_leg_sec_cnt: Vec<Vec<usize>> = Vec::with_capacity(iw.arrs.len());
    let mut arr_chord_legs: Vec<Vec<[usize; 3]>> = Vec::with_capacity(iw.arrs.len());
    for a in iw.arrs.iter() {
        let p = row_path(
            &a.leg_keys,
            &a.leg_fwd,
            &a.leg_stop,
            &geom,
            &|u, v| in_edge_dir_to_sec.get(&(u, v)).copied(),
            in_sec_edges,
            &|_, _, p| near_station(in_station_grid, p).then_some(None),
            coords,
            throats,
            in_sections.len(),
            throat_drops,
        );
        let total = *p.flow_cnt.last().unwrap();
        *chord_legs_in += p.chord_legs.len();
        arr_secs.push(p.secs);
        arr_leg_sec_cnt.push(p.flow_cnt.iter().map(|c| total - c).collect());
        arr_chord_legs.push(p.chord_legs);
    }
    let arr_lookup: HashMap<ArrKey, usize> = iw
        .arrs
        .iter()
        .enumerate()
        .map(|(i, a)| ((a.ti, a.from_station.clone(), a.depart.clone(), a.set), i))
        .collect();
    let mut srcs: Vec<[i64; 8]> = Vec::new();
    let mut in_calls_out: Vec<InCallList> = Vec::new();
    for (zh, st) in iw.sources.iter() {
        let dp = match city_pt.get(zh) {
            Some(p) => *p,
            None => continue,
        };
        let idx = it.city(zh, city_en, city_pt);
        let mut times = st.times.clone();
        times.sort();
        let fastest = times.first().copied().unwrap_or(-1);
        let median_v = if times.is_empty() {
            -1
        } else {
            times[times.len() / 2]
        };
        let crow = hav_km_ll(iw.home_pt, [dp[1], dp[0]]).round() as i64;
        let mut rail = st.rail.clone();
        rail.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let rail_v = if rail.is_empty() {
            -1
        } else {
            rail[rail.len() / 2].round() as i64
        };
        srcs.push([
            idx,
            st.total as i64,
            st.fast as i64,
            st.originating as i64,
            fastest,
            median_v,
            crow,
            rail_v,
        ]);
        let mut cl: Vec<(usize, String, String, i64, u8, i64, usize)> = Vec::new();
        for c in st.calls.iter() {
            if let Some(ai) =
                arr_lookup.get(&(c.ti, c.okey_station.clone(), c.okey_depart.clone(), c.set))
            {
                let bfs_i = it.station(&c.from_station, city_en);
                let sec_cnt = arr_leg_sec_cnt[*ai]
                    .get(c.leg_start)
                    .copied()
                    .unwrap_or(arr_leg_sec_cnt[*ai][0]);
                cl.push((
                    *ai,
                    c.depart.clone(),
                    c.arr.clone(),
                    c.off,
                    if c.started { 1 } else { 0 },
                    bfs_i,
                    sec_cnt,
                ));
            }
        }
        cl.sort_by_key(|r| (r.3, mins(&r.2).unwrap_or(0)));
        if cl.len() as u64 != st.total {
            println!(
                "IN CALLS MISMATCH {} <- {}: {} calls vs total {}",
                iw.zh,
                zh,
                cl.len(),
                st.total
            );
        }
        in_calls_out.push(cl);
        // pair identity: srcs[X][P] must equal dests[P][X] when P is selected
        if let Some(pi) = selected.iter().position(|c| c == zh) {
            match works[pi].dests.iter().find(|(dz, _)| dz == &iw.zh) {
                Some((_, dst)) => {
                    if dst.total != st.total {
                        *pair_mismatch += 1;
                        println!(
                            "PAIR IDENTITY MISMATCH {} -> {}: out {} vs in {}",
                            zh, iw.zh, dst.total, st.total
                        );
                    }
                }
                None => {
                    *pair_mismatch += 1;
                    println!("PAIR IDENTITY MISSING {} -> {}", zh, iw.zh);
                }
            }
        }
    }
    let mut arrs_out: Vec<AtlasArr> = Vec::new();
    for a in iw.arrs.iter() {
        let t_i = it.train(inp, a.ti);
        let fs_i = it.station(&a.from_station, city_en);
        let fc_i = it.city(&a.from_city, city_en, city_pt);
        let ts_i = it.station(&a.arr_station, city_en);
        arrs_out.push(AtlasArr {
            t: t_i,
            fs: fs_i,
            fc: fc_i,
            dep: a.depart.clone(),
            ts: ts_i,
            arr: a.arrive.clone(),
            dur: a.dur.unwrap_or(-1),
            stops: a.stops_before,
            set: a.set,
            km: if a.km > 0.0 { a.km.round() as i64 } else { -1 },
        });
    }
    InSide {
        arr_secs,
        arr_chord_legs,
        srcs,
        in_calls_out,
        arrs_out,
    }
}

/// Assemble origins.
fn assemble_origins(m: &Model, os: &SectionSet, is_: &SectionSet, it: &mut Interner) -> Assembled {
    let en = |c: &str| -> String { m.cx.inp.en(c) };
    let out = &m.out;
    let mut asm = Assembled {
        origins: Vec::new(),
        throats: Throats::default(),
        throat_drops: [0u64; 2],
    };
    let mut cnt = AsmCounters::default();
    for (ci, w) in out.works.iter().enumerate() {
        let o = assemble_outbound(m, os, &mut asm, &mut cnt, it, w);
        let iw = &m.in_works[ci];
        let i = assemble_inbound(m, is_, &mut asm, &mut cnt, it, iw);
        asm.origins.push(AtlasOrigin {
            zh: w.zh.clone(),
            en: en(&w.zh),
            pt: w.home_pt,
            outbound: w.outbound,
            fully_tracked: w.fully_tracked,
            dests: o.dests,
            calls: o.calls_out,
            flows: os.flows_per_city[ci].clone(),
            chords: o.chords,
            deps: o.deps,
            dep_secs: o.dep_secs,
            dep_chord_legs: o.dep_chord_legs,
            dep_stop_pos: o.dep_stop_pos,
            inbound: iw.arrivals,
            srcs: i.srcs,
            in_calls: i.in_calls_out,
            in_flows: is_.flows_per_city[ci].clone(),
            arrs: i.arrs_out,
            arr_secs: i.arr_secs,
            arr_chord_legs: i.arr_chord_legs,
        });
    }
    let (skipped_rows, skipped_trains, skipped_example) =
        (&out.skipped_rows, &out.skipped_trains, &out.skipped_example);
    let (pair_mismatch, chord_legs_out, chord_legs_in) =
        (cnt.pair_mismatch, cnt.chord_legs_out, cnt.chord_legs_in);
    let lc = &m.lc;

    println!("pair identity mismatches: {}", pair_mismatch);
    println!(
        "dep rows with stations lacking a city call: {} ({} trains): home city {}, terminus city {}, intermediate city {}",
        skipped_rows[3],
        skipped_trains.len(),
        skipped_rows[0],
        skipped_rows[1],
        skipped_rows[2]
    );
    println!("  examples (home / terminus / intermediate): {skipped_example:?}");
    println!(
        "chord legs (per-train rows): out {} in {}",
        chord_legs_out, chord_legs_in
    );
    println!(
        "variant legs: {} resolved via override tiling, {} fell back to base pair geometry",
        lc.variant_stats.0, lc.variant_stats.1
    );
    asm
}

/// P2.2 national trains (A): every national train's whole run.
/// Same train set and legs as the national table (nat_legs: the union of
/// a train's outbound and inbound legs, which is every leg of its run).
/// The whole path is a head over the legs before the train's first
/// selected-city departure, then that city's out-tables row verbatim (a
/// train with no outbound row is all head). The head walks `sections`
/// through the same edge map as the national table, so the sections it
/// touches are exactly the ones that table counts. A section the head
/// covers whole is a flow entry as in the out-tables rows. Sections are
/// cut where per-city counts change, so a head (track no selected city's
/// outbound train runs over) can join one at a junction mid-way: that
/// partial stretch, and track no section carries, become geometry-only
/// pieces interned like throats (a shared throat when the node chain
/// matches one, else a new piece in `extra`); a piece on a partly covered
/// section is listed in `on_sec`, so the train still counts there.
/// Returns the trains and the extra pieces' node chains.
fn national_trains_phase(
    m: &Model,
    os: &SectionSet,
    nat_legs: &std::collections::BTreeMap<usize, TrainLegs>,
    national: &flows::National,
    asm: &Assembled,
    it: &Interner,
) -> (NationalTrains, Vec<Vec<i64>>) {
    let cx = m.cx;
    let inp = cx.inp;
    let (trains, coords, override_map) = (&inp.trains, &inp.coords, &inp.override_map);
    let train_names = &cx.train_names;
    let (lc, works) = (&m.lc, &m.out.works);
    let (sections, edge_dir_to_sec, sec_edges) = (&os.sections, &os.edge_dir_to_sec, &os.sec_edges);
    let (origins, throats) = (&asm.origins, &asm.throats);
    let geom = |key: &(String, String, String)| {
        leg_seqs(key, &lc.leg_cache, &lc.variant_cache).zip(m.leg_walks.get(key))
    };

    // ti -> (boarding stop, origin, dep row) of its earliest outbound row
    let mut first_dep: HashMap<usize, (usize, usize, usize)> = HashMap::new();
    for (ci, w) in works.iter().enumerate() {
        for (ri, d) in w.deps.iter().enumerate() {
            let e = first_dep.entry(d.ti).or_insert((d.board, ci, ri));
            if d.board < e.0 {
                *e = (d.board, ci, ri);
            }
        }
    }
    let n_sec = sections.len();
    let is_flow = |v: i64| ((if v >= 0 { v } else { !v }) as usize) < n_sec;
    let mut nat_throats = throats.clone();
    let mut national_trains = NationalTrains::default();
    // trains, with a head, all head, emptied (on no section)
    let mut nt_n = [0usize; 4];
    // seam: dup dropped, flow repeat, reversal
    let mut nt_seam = [0usize; 3];
    // head entries: flow sections, shared throats, extra pieces
    let mut nt_head = [0usize; 3];
    // (throat index, section) of pieces on partly covered sections
    let mut nt_on_sec: std::collections::BTreeMap<usize, usize> = Default::default();
    let mut nt_partial = 0usize;
    let mut nt_rev_examples: Vec<String> = Vec::new();
    for (t, tr) in it.train_table.iter().enumerate() {
        let ti = it.train_ti[t];
        let Some((_, _, nat_keys)) = nat_legs.get(&ti) else {
            national_trains.paths.push(Vec::new());
            national_trains.stop_pos.push(Vec::new());
            continue;
        };
        let (names, tt) = (&train_names[ti], &trains[ti]);
        let (mut keys, mut fwd, mut stop) = (Vec::new(), Vec::new(), Vec::new());
        for k in 0..names.len() - 1 {
            let (a, b) = (&names[k], &names[k + 1]);
            if a != b {
                keys.push(leg_key3(override_map, tt, a, b));
                fwd.push(a < b);
                stop.push(k);
            }
        }
        let mut uniq = keys.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(
            &uniq, nat_keys,
            "train {}: whole-run legs differ from the national table's",
            tr.code
        );
        let dep = first_dep.get(&ti).copied();
        let b = dep.map_or(names.len() - 1, |d| d.0);
        let nh = stop.partition_point(|&s| s < b);
        // the head's edges per section: which sections it covers whole
        let mut cover: HashMap<usize, HashSet<(i64, i64)>> = HashMap::new();
        for li in 0..nh {
            if let Some((seqs, walk)) = geom(&keys[li]) {
                walk_edges(seqs, walk, fwd[li], |u, v| {
                    if let Some(&(s, _)) = edge_dir_to_sec.get(&(u, v)) {
                        cover.entry(s).or_default().insert((u.min(v), u.max(v)));
                    }
                });
            }
        }
        let whole_sec = |s: usize| cover.get(&s).is_some_and(|e| e.len() == sec_edges[s]);
        nt_partial += cover.keys().filter(|&&s| !whole_sec(s)).count();
        let h = row_path(
            &keys[..nh],
            &fwd[..nh],
            &stop[..nh],
            &geom,
            &|u, v| {
                edge_dir_to_sec
                    .get(&(u, v))
                    .copied()
                    .filter(|&(s, _)| whole_sec(s))
            },
            sec_edges,
            &|u, v, _| Some(edge_dir_to_sec.get(&(u, v)).map(|&(s, _)| s)),
            coords,
            &mut nat_throats,
            n_sec,
            &mut [0u64; 2],
        );
        for &(j, s) in h.on_sec.iter() {
            let prev = nt_on_sec.insert(j, s);
            assert!(prev.is_none_or(|p| p == s), "piece {j} on two sections");
        }
        for &v in h.secs.iter() {
            let id = (if v >= 0 { v } else { !v }) as usize;
            nt_head[if id < n_sec {
                0
            } else if id < n_sec + throats.chains.len() {
                1
            } else {
                2
            }] += 1;
        }
        let head = trainpath::PathPart {
            stop_pos: (1..=b)
                .map(|j| h.full_cnt[stop[..nh].partition_point(|&s| s < j)])
                .collect(),
            secs: h.secs,
            chord_legs: h.chord_legs,
        };
        let tail = match dep {
            Some((_, ci, ri)) => trainpath::PathPart {
                secs: origins[ci].dep_secs[ri].clone(),
                stop_pos: origins[ci].dep_stop_pos[ri].clone(),
                chord_legs: origins[ci].dep_chord_legs[ri].clone(),
            },
            None => Default::default(),
        };
        nt_n[0] += 1;
        nt_n[1] += !head.secs.is_empty() as usize;
        nt_n[2] += dep.is_none() as usize;
        let (whole, seam) = trainpath::join(head, &tail, is_flow);
        assert_eq!(whole.stop_pos.len(), names.len() - 1, "train {}", tr.code);
        for (n, hit) in nt_seam
            .iter_mut()
            .zip([seam.dup_dropped, seam.flow_repeat, seam.reversal])
        {
            *n += hit as usize;
        }
        if seam.reversal && nt_rev_examples.len() < 8 {
            nt_rev_examples.push(format!("{} at {}", tr.code, names[b]));
        }
        let counted = |v: i64| {
            let id = (if v >= 0 { v } else { !v }) as usize;
            id < n_sec || nt_on_sec.contains_key(&(id - n_sec))
        };
        if !whole.secs.iter().any(|&v| counted(v)) {
            nt_n[3] += 1;
            national_trains.paths.push(Vec::new());
            national_trains.stop_pos.push(Vec::new());
            continue;
        }
        if !whole.chord_legs.is_empty() {
            national_trains.chords.push((t, whole.chord_legs));
        }
        national_trains.paths.push(whole.secs);
        national_trains.stop_pos.push(whole.stop_pos);
    }
    let nt_trains = national_trains
        .paths
        .iter()
        .filter(|p| !p.is_empty())
        .count();
    assert_eq!(
        nt_trains, national.trains,
        "national trains file and national table disagree on the train count"
    );
    // keep only the extra pieces a path still refers to (row_path drops a
    // throat run again when a flow section repeats right after it), numbered
    // by first use
    let extra_base = n_sec + throats.chains.len();
    let mut extra_chains: Vec<Vec<i64>> = Vec::new();
    let mut extra_new: HashMap<usize, usize> = HashMap::new();
    for v in national_trains.paths.iter_mut().flatten() {
        let (id, rev) = if *v >= 0 {
            (*v as usize, false)
        } else {
            ((!*v) as usize, true)
        };
        if id < extra_base {
            continue;
        }
        let j = *extra_new.entry(id).or_insert_with(|| {
            extra_chains.push(nat_throats.chains[id - n_sec].clone());
            extra_chains.len() - 1
        });
        let nv = (extra_base + j) as i64;
        *v = if rev { !nv } else { nv };
    }
    let n_extra = extra_chains.len();
    // pieces on partly covered sections, in path id space (as renumbered)
    for (j, s) in nt_on_sec.iter() {
        let id = n_sec + j;
        let id = if id < extra_base {
            Some(id)
        } else {
            extra_new.get(&id).map(|&k| extra_base + k)
        };
        if let Some(id) = id {
            national_trains.on_sec.push((id, *s));
        }
    }
    national_trains.on_sec.sort_unstable();
    println!(
        "national trains: {} trains ({} with a head before their first selected-city departure, {} all head, {} on no section left out); seam: {} duplicated pieces dropped, {} flow repeats, {} reversals; head entries: {} sections, {} shared throats, {} extra pieces ({} distinct pieces kept); {} trains with chord legs ({} legs)",
        nt_trains,
        nt_n[1],
        nt_n[2],
        nt_n[3],
        nt_seam[0],
        nt_seam[1],
        nt_seam[2],
        nt_head[0],
        nt_head[1],
        nt_head[2],
        n_extra,
        national_trains.chords.len(),
        national_trains.chords.iter().map(|c| c.1.len()).sum::<usize>()
    );
    println!("  seam reversal examples: {nt_rev_examples:?}");
    println!(
        "national trains: {nt_partial} (train, section) pairs where a head covers only part of a section, on {} pieces",
        national_trains.on_sec.len()
    );
    (national_trains, extra_chains)
}

/// Per-train schedules, indexed by train_table t, from data/raw.
/// Names are clean()ed before interning, so every stop resolves into
/// station_table (appended after the atlas's own stations).
fn schedules_phase(m: &Model, it: &mut Interner) -> Vec<Vec<ScheduleRow>> {
    let cx = m.cx;
    let inp = cx.inp;
    let (trains, d1_len, override_map) = (&inp.trains, inp.d1_len, &inp.override_map);
    let (city_en, data_dir) = (&inp.city_en, &inp.paths.data_dir);
    let (train_names, corr) = (&cx.train_names, &m.corr);

    // A train export's stop lists are its schedules; otherwise the 12306
    // stop-list dumps, keyed (dataset, train_no).
    let mut raw_stops: HashMap<(u8, String), Vec<RawStop>> = HashMap::new();
    if inp.calendar.is_none() {
        for (set, file) in [(0u8, "raw/stops.jsonl"), (1, "raw/stops_cs.jsonl")] {
            for line in fs::read_to_string(data_dir.join(file)).unwrap().lines() {
                let r: RawTrain = serde_json::from_str(line).unwrap();
                raw_stops.insert((set, r.train_no), r.stops);
            }
        }
    }
    let mut schedules: Vec<Vec<ScheduleRow>> = Vec::with_capacity(it.train_table.len());
    let (mut sched_name_mismatch, mut sched_km_unknown) = (0usize, 0usize);
    let train_tis = it.train_ti.clone();
    for &ti in &train_tis {
        let t = &trains[ti];
        let set = if ti < d1_len { 0u8 } else { 1 };
        let own: Vec<RawStop>;
        let stops = if inp.calendar.is_some() {
            own = t
                .stops
                .iter()
                .map(|s| RawStop {
                    station_name: s.name.clone(),
                    arrive_time: s.arrive.clone(),
                    start_time: s.depart.clone(),
                })
                .collect();
            &own
        } else {
            &raw_stops[&(set, t.train_no.clone())]
        };
        let names: Vec<String> = stops.iter().map(|s| clean(&s.station_name)).collect();
        if names != train_names[ti] {
            sched_name_mismatch += 1;
        }
        // day offsets: advance a clock from the origin departure whenever
        // a stop time wraps past midnight (as travel_time does)
        let mut clock: Option<i64> = None;
        let mut advance = |tod: i64| -> i64 {
            let c = match clock {
                None => tod,
                Some(c) => c + (tod - c).rem_euclid(1440),
            };
            clock = Some(c);
            c / 1440
        };
        let mut rows: Vec<ScheduleRow> = Vec::with_capacity(stops.len());
        // the previous stop's departure, in minutes from the first day
        let mut prev_dep: Option<i64> = None;
        for (j, s) in stops.iter().enumerate() {
            let arr = mins(&s.arrive_time);
            let dep = mins(&s.start_time);
            let day = arr.map(&mut advance);
            let day_dep = dep.map(&mut advance);
            let arr_abs = arr.zip(day).map(|(m, d)| d * 1440 + m);
            let dep_abs = dep.zip(day_dep).map(|(m, d)| d * 1440 + m);
            let km = if j == 0 || names[j - 1] == names[j] {
                0.0
            } else {
                match leg_km(override_map, &corr.pair_len, t, &names[j - 1], &names[j]) {
                    Some(l) => (l * 10.0).round() / 10.0,
                    None => {
                        sched_km_unknown += 1;
                        -1.0
                    }
                }
            };
            let st = it.station(&names[j], city_en);
            let kmh = leg_kmh(km, prev_dep, arr_abs);
            prev_dep = dep_abs.or(arr_abs);
            rows.push((
                st,
                arr.unwrap_or(-1),
                dep.unwrap_or(-1),
                day.or(day_dep).unwrap_or(0),
                km,
                kmh,
            ));
        }
        schedules.push(rows);
    }
    println!(
        "schedules: {} trains, {} name mismatches vs timetables, {} legs without km",
        schedules.len(),
        sched_name_mismatch,
        sched_km_unknown
    );
    schedules
}

/// A leg's timetable average speed (km/h, rounded) from its km and the
/// departure / arrival minutes either side; 0 when either is unknown or the
/// result is no train's (over `LEG_KMH_MAX`: a timetable or distance slip).
fn leg_kmh(km: f64, dep: Option<i64>, arr: Option<i64>) -> i64 {
    const LEG_KMH_MAX: f64 = 400.0;
    match (dep, arr) {
        (Some(d), Some(a)) if a > d && km > 0.0 => {
            let v = km * 60.0 / (a - d) as f64;
            if v <= LEG_KMH_MAX {
                v.round() as i64
            } else {
                0
            }
        }
        _ => 0,
    }
}

/// Network backdrop (shared, polyline-encoded).
fn network_backdrop(cx: &Ctx) -> Vec<String> {
    let path_map = &cx.inp.path_map;

    let mut network: Vec<String> = Vec::new();
    {
        let mut seen: HashSet<(String, String)> = HashSet::new();
        let mut keys: Vec<&(String, String)> = path_map.keys().collect();
        keys.sort();
        for key in keys {
            let segs = &path_map[key].1;
            if !seen.insert(key.clone()) {
                continue;
            }
            for s in segs {
                let c = cx.seg_coords(s);
                if c.len() >= 2 {
                    let simp = dp_keep(&c, 0.008);
                    let simp: Vec<[f64; 2]> = simp.iter().map(|p| round_pt(*p, 3)).collect();
                    if simp.len() >= 2 {
                        network.push(polyline_encode(&simp));
                    }
                }
            }
        }
    }
    println!("network polylines: {}", network.len());
    network
}

/// O1 throat geometry, simplified like the sections; also fills the national
/// trains' extra pieces. Returns the throat pieces.
fn throat_geometry(
    cx: &Ctx,
    asm: &Assembled,
    extra_chains: &[Vec<i64>],
    national_trains: &mut NationalTrains,
    os: &SectionSet,
    is_: &SectionSet,
) -> Vec<String> {
    let coords = &cx.inp.coords;
    let (origins, throats, throat_drops) = (&asm.origins, &asm.throats, asm.throat_drops);
    let (sections, in_sections) = (&os.sections, &is_.sections);

    let mut throat_pts = 0usize;
    let throat_geo: Vec<String> = throats
        .chains
        .iter()
        .map(|chain| {
            let raw: Vec<[f64; 2]> = chain.iter().map(|id| coords[id]).collect();
            let simp: Vec<[f64; 2]> = dp_keep(&raw, 0.00035)
                .iter()
                .map(|p| round_pt(*p, 4))
                .collect();
            throat_pts += simp.len();
            polyline_encode(&simp)
        })
        .collect();
    let mut extra_km = 0.0f64;
    let extra_geo: Vec<String> = extra_chains
        .iter()
        .map(|chain| {
            let raw: Vec<[f64; 2]> = chain.iter().map(|id| coords[id]).collect();
            extra_km += raw.windows(2).map(|w| hav_km_ll(w[0], w[1])).sum::<f64>();
            let simp: Vec<[f64; 2]> = dp_keep(&raw, 0.00035)
                .iter()
                .map(|p| round_pt(*p, 4))
                .collect();
            polyline_encode(&simp)
        })
        .collect();
    println!(
        "national trains extra pieces: {} ({extra_km:.1} km of head track the shared sections and throats do not draw)",
        extra_geo.len()
    );
    national_trains.extra = extra_geo;
    let throat_refs = |rows: &dyn Fn(&AtlasOrigin) -> &Vec<Vec<i64>>, base: usize| -> usize {
        origins
            .iter()
            .flat_map(|o| rows(o).iter().flatten())
            .filter(|&&v| (if v < 0 { !v } else { v }) as usize >= base)
            .count()
    };
    println!(
        "throats: {} pieces, {} points; row refs out {} in {}; flow repeats that dropped throats {} ({} across a leg boundary)",
        throat_geo.len(),
        throat_pts,
        throat_refs(&|o| &o.dep_secs, sections.len()),
        throat_refs(&|o| &o.arr_secs, in_sections.len()),
        throat_drops[0],
        throat_drops[1]
    );
    throat_geo
}

/// The `about` sentence and, for train-export builds, the date window.
fn about_and_calendar(cx: &Ctx) -> (String, Option<Vec<String>>) {
    let inp = cx.inp;
    let trains = &inp.trains;

    let mut about = "China Rail Flow Atlas - Minard-style outbound flow maps for China's top 100 rail cities. Shared national track-section atlas (each section = a stretch of track with constant per-city train counts); every origin city is a sparse index (section, trains/day) into it, plus destination stats and departures. Track geometry: OpenStreetMap. Timetables: 12306 timetables Wed 2026-10-21 (5,043 trains, trunk) and Wed 2026-10-28 (2,210 intercity C/S trains). Flow width = trains/day summed over each shared track section. Dashed chords = legs with no track routing. Geometry strings are Google-polyline-encoded at 1e5 precision, [lat, lon] order.".to_string();
    let calendar = inp.calendar.as_ref().map(|(_, window)| window.clone());
    if let Some(w) = &calendar {
        about = about.replace(
            "Timetables: 12306 timetables Wed 2026-10-21 (5,043 trains, trunk) and Wed 2026-10-28 (2,210 intercity C/S trains). Flow width = trains/day",
            &format!(
                "Timetables: train export, every train that runs on any date of {} .. {} counted once ({} trains). Flow width = trains",
                w.first().map_or("?", |d| d.as_str()),
                w.last().map_or("?", |d| d.as_str()),
                trains.len()
            ),
        );
    }
    (about, calendar)
}

/// Per-city national counts (dep/arr), the origins' counting rules.
/// Interned after every other city so existing city_table indices keep
/// their values; a city with no coordinates is not drawable and left out.
fn national_cities(m: &Model, asm: &Assembled, national: &mut flows::National, it: &mut Interner) {
    let cx = m.cx;
    let (trains, city_en) = (&cx.inp.trains, &cx.inp.city_en);
    let (train_cities, city_pt) = (&cx.train_cities, &m.city_pt);
    let origins = &asm.origins;

    // over the pack's trains (train_table), the same set as the sections
    let counts = flows::city_counts(it.train_ti.iter().map(|&ti| {
        (
            class_idx(&trains[ti].train_class),
            train_cities[ti].as_slice(),
        )
    }));
    let mut rows: Vec<(i64, [u32; 8], [u32; 8])> = Vec::new();
    let mut no_pt = 0usize;
    for (zh, (d, a)) in counts.iter() {
        if !city_pt.contains_key(zh) {
            no_pt += 1;
            continue;
        }
        let i = it.city(zh, city_en, city_pt);
        rows.push((i, *d, *a));
    }
    rows.sort_by_key(|r| r.0);
    let nc = &mut national.cities;
    nc.dep_by_class = vec![Vec::new(); 8];
    nc.arr_by_class = vec![Vec::new(); 8];
    for (i, d, a) in rows {
        nc.idx.push(i);
        nc.dep.push(d.iter().sum());
        nc.arr.push(a.iter().sum());
        for c in 0..8 {
            nc.dep_by_class[c].push(d[c]);
            nc.arr_by_class[c].push(a[c]);
        }
    }
    // parity: every origin's outbound/inbound is its city's dep/arr
    for o in origins.iter() {
        let k = it
            .city_idx
            .get(&o.zh)
            .and_then(|i| nc.idx.binary_search(i).ok())
            .unwrap_or_else(|| panic!("origin {} has no national city row", o.zh));
        assert_eq!(
            (nc.dep[k] as u64, nc.arr[k] as u64),
            (o.outbound, o.inbound),
            "national city counts differ from origin {}",
            o.zh
        );
    }
    println!(
        "national cities: {} with trains ({} without coordinates left out); {} origins agree with their dep/arr",
        nc.idx.len(),
        no_pt,
        origins.len()
    );
}

/// Per-train national index (see flows::NationalIndex).
fn national_index_phase(
    m: &Model,
    national: &flows::National,
    it: &Interner,
) -> flows::NationalIndex {
    let cx = m.cx;
    let (trains, override_map) = (&cx.inp.trains, &cx.inp.override_map);
    let (train_names, train_cities) = (&cx.train_names, &cx.train_cities);
    let (corr, city_pt) = (&m.corr, &m.city_pt);
    let nc = &national.cities;

    let secs_of: HashMap<usize, &Vec<usize>> =
        national.train_secs.iter().map(|(ti, v)| (*ti, v)).collect();
    let mut national_index = flows::NationalIndex::default();
    for &ti in it.train_ti.iter() {
        let (tr, names, cities) = (&trains[ti], &train_names[ti], &train_cities[ti]);
        let last = tr.stops.len() - 1;
        national_index
            .hour
            .push(flows::hour_bin(&tr.stops[0].depart));
        national_index
            .dur
            .push(flows::dur_bin(travel_time(&tr.stops, 0, last)));
        let (mut km, mut ok) = (0f64, true);
        for k in 0..last {
            if names[k] != names[k + 1] {
                match leg_km(override_map, &corr.pair_len, tr, &names[k], &names[k + 1]) {
                    Some(l) => km += l,
                    None => ok = false,
                }
            }
        }
        let km = if ok && km > 0.0 {
            km.round()
        } else {
            match (city_pt.get(&cities[0]), city_pt.get(&cities[last])) {
                (Some(a), Some(b)) => hav_km_ll([a[1], a[0]], [b[1], b[0]]),
                _ => -1.0,
            }
        };
        let (dk, dm) = flows::dist_bins(km);
        national_index.dist_km.push(dk);
        national_index.dist_mi.push(dm);
        national_index.secs.push(
            secs_of
                .get(&ti)
                .map_or(Vec::new(), |v| v.iter().map(|&s| s as u32).collect()),
        );
        // (city id, event minute) per distinct city, ascending id; the
        // stop is the one `f` finds, which also decides the membership.
        let ids =
            |f: &dyn Fn(&[String], &str) -> Option<usize>, dep: bool| -> (Vec<i64>, Vec<u16>) {
                let mut v: Vec<(i64, u16)> = cities
                    .iter()
                    .filter_map(|c| {
                        let k = f(cities, c)?;
                        let i = *it.city_idx.get(c)?;
                        nc.idx.binary_search(&i).ok()?;
                        let s = &tr.stops[k];
                        let m = if dep {
                            flows::event_minute(&s.depart, &s.arrive)
                        } else {
                            flows::event_minute(&s.arrive, &s.depart)
                        };
                        Some((i, m))
                    })
                    .collect();
                v.sort_unstable();
                v.dedup_by_key(|e| e.0);
                v.into_iter().unzip()
            };
        let (ids_d, min_d) = ids(&flows::departs_from, true);
        let (ids_a, min_a) = ids(&flows::arrives_at, false);
        national_index.dep.push(ids_d);
        national_index.dep_min.push(min_d);
        national_index.arr.push(ids_a);
        national_index.arr_min.push(min_a);
    }
    national_index
}

/// Each station's point and city, for the client's city close-ups. Runs last,
/// so it only fills rows: every table index stays as before. A point more
/// than CLOSEUP_FAR_KM from its city's is a homonym's: the station's OSM
/// candidate nearest the city replaces it; a station still that far keeps no
/// city (its own point or its city's is wrong), so it never splits from it.
fn station_places(cx: &Ctx, city_pt: &HashMap<String, [f64; 2]>, it: &mut Interner) {
    const CLOSEUP_FAR_KM: f64 = 60.0;
    let ll = |p: [f64; 2]| [p[1], p[0]];
    let (mut moved, mut far) = (0usize, 0usize);
    for i in 0..it.station_table.len() {
        let zh = it.station_table[i].zh.clone();
        let city = city_of(&zh);
        let mut pt = cx.station_pt(&zh);
        let mut in_city = true;
        if let (Some(p), Some(c)) = (pt, city_pt.get(&city)) {
            if hav_km_ll(ll(p), ll(*c)) > CLOSEUP_FAR_KM {
                if let Some(q) = cx.inp.stations.point_near(&zh, *c) {
                    if hav_km_ll(ll(q), ll(*c)) < hav_km_ll(ll(p), ll(*c)) {
                        pt = Some(q);
                        moved += 1;
                    }
                }
                if pt.is_some_and(|q| hav_km_ll(ll(q), ll(*c)) > CLOSEUP_FAR_KM) {
                    far += 1;
                    in_city = false;
                }
            }
        }
        it.station_table[i].pt = pt.map(ll);
        it.station_table[i].city = if in_city {
            it.city_idx.get(&city).copied()
        } else {
            None
        };
    }
    println!("station places: {moved} moved to their city's homonym, {far} still over {CLOSEUP_FAR_KM} km from their city (left out of it)");
}

/// `data/closeup_stations.json` (optional): per origin city, stations always
/// in its close-up (`include`) or never (`exclude`), whatever the rules say.
#[derive(Deserialize, Default)]
struct CloseupOverrides {
    #[serde(default)]
    include: std::collections::BTreeMap<String, Vec<String>>,
    #[serde(default)]
    exclude: std::collections::BTreeMap<String, Vec<String>>,
}

/// The close-up stations of the origin cities (owner-approved rules,
/// 2026-10-27). A station of the city (placed, `city` set) at
/// CLOSEUP_MIN_TRAINS+ trains/day is major when it is named after the city,
/// or the city plus 东/西/南/北; else, at CLOSEUP_MIN_SHARE+ of the city's
/// station calls, when CLOSEUP_TERMINUS+ long-distance trains (not C / S)
/// start or end there, or CLOSEUP_HUB+ stop there from CLOSEUP_HUB_DIRS+
/// neighbouring stations. At most CLOSEUP_MAX, name / cardinal first, then
/// busiest; the overrides win over all of it. A city with fewer than two
/// splits into none.
fn closeup_stations(cx: &Ctx, origins: &[String], it: &mut Interner) {
    const CLOSEUP_MIN_TRAINS: u32 = 20;
    const CLOSEUP_MIN_SHARE: f64 = 0.03;
    const CLOSEUP_TERMINUS: u32 = 30;
    const CLOSEUP_HUB: u32 = 100;
    const CLOSEUP_HUB_DIRS: usize = 3;
    const CLOSEUP_MAX: usize = 8;
    let trains = &cx.inp.trains;
    let file = cx.inp.paths.data_dir.join("closeup_stations.json");
    let ov: CloseupOverrides = match fs::read_to_string(&file) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| panic!("{}: {e}", file.display())),
        Err(_) => CloseupOverrides::default(),
    };

    // Per station, over the pack's trains: all trains, long-distance trains,
    // long-distance trains starting or ending there, and the stations
    // long-distance trains come from or go to next.
    let (mut all, mut long, mut ends) = (
        HashMap::<&str, u32>::new(),
        HashMap::<&str, u32>::new(),
        HashMap::<&str, u32>::new(),
    );
    let mut dirs: HashMap<&str, HashSet<&str>> = HashMap::new();
    for &ti in &it.train_ti {
        let names = &cx.train_names[ti];
        let ld = !matches!(trains[ti].train_class.as_str(), "C" | "S");
        let mut seen = HashSet::new();
        for nm in names.iter().filter(|n| seen.insert(n.as_str())) {
            *all.entry(nm).or_default() += 1;
            if ld {
                *long.entry(nm).or_default() += 1;
            }
        }
        if !ld {
            continue;
        }
        if let (Some(a), Some(b)) = (names.first(), names.last()) {
            *ends.entry(a).or_default() += 1;
            *ends.entry(b).or_default() += 1;
        }
        for w in names.windows(2) {
            dirs.entry(&w[0]).or_default().insert(&w[1]);
            dirs.entry(&w[1]).or_default().insert(&w[0]);
        }
    }
    let get = |m: &HashMap<&str, u32>, k: &str| m.get(k).copied().unwrap_or(0);

    let mut by_city: HashMap<i64, Vec<usize>> = HashMap::new();
    for (i, s) in it.station_table.iter().enumerate() {
        if let (Some(c), Some(_)) = (s.city, s.pt) {
            by_city.entry(c).or_default().push(i);
        }
    }
    let (mut n_cities, mut n_stations) = (0usize, 0usize);
    let mut flagged: Vec<usize> = Vec::new();
    for city in origins {
        let Some(&ci) = it.city_idx.get(city) else {
            continue;
        };
        let list = by_city.get(&ci).cloned().unwrap_or_default();
        let total: u32 = list
            .iter()
            .map(|&i| get(&all, &it.station_table[i].zh))
            .sum();
        let inc = ov.include.get(city).cloned().unwrap_or_default();
        let exc = ov.exclude.get(city).cloned().unwrap_or_default();
        for nm in inc.iter().chain(exc.iter()) {
            assert!(
                list.iter().any(|&i| &it.station_table[i].zh == nm),
                "{}: {nm} is not a placed station of {city}",
                file.display()
            );
        }
        let rule = |zh: &str| -> Option<&'static str> {
            if inc.iter().any(|n| n == zh) {
                return Some("include");
            }
            if exc.iter().any(|n| n == zh) || get(&all, zh) < CLOSEUP_MIN_TRAINS {
                return None;
            }
            if zh == city {
                return Some("name");
            }
            if zh
                .strip_prefix(city.as_str())
                .is_some_and(|r| ["东", "西", "南", "北"].contains(&r))
            {
                return Some("cardinal");
            }
            if (get(&all, zh) as f64) < CLOSEUP_MIN_SHARE * total as f64 {
                return None;
            }
            if get(&ends, zh) >= CLOSEUP_TERMINUS {
                return Some("terminus");
            }
            if get(&long, zh) >= CLOSEUP_HUB
                && dirs.get(zh).map_or(0, |d| d.len()) >= CLOSEUP_HUB_DIRS
            {
                return Some("hub");
            }
            None
        };
        let mut keep: Vec<(usize, &str)> = list
            .iter()
            .filter_map(|&i| rule(&it.station_table[i].zh).map(|r| (i, r)))
            .collect();
        // rank: overrides, then name / cardinal, then busiest (name breaks ties)
        let rank = |r: &str| match r {
            "include" => 0,
            "name" | "cardinal" => 1,
            _ => 2,
        };
        keep.sort_by(|a, b| {
            let (za, zb) = (&it.station_table[a.0].zh, &it.station_table[b.0].zh);
            rank(a.1)
                .cmp(&rank(b.1))
                .then(get(&all, zb).cmp(&get(&all, za)))
                .then(za.cmp(zb))
        });
        let n_inc = keep.iter().filter(|k| k.1 == "include").count();
        keep.truncate(CLOSEUP_MAX.max(n_inc));
        let split = keep.len() >= 2;
        let line: Vec<String> = keep
            .iter()
            .map(|(i, r)| {
                format!(
                    "{}({}, {r})",
                    it.station_table[*i].zh,
                    get(&all, &it.station_table[*i].zh)
                )
            })
            .collect();
        let mut dropped: Vec<&usize> = list
            .iter()
            .filter(|i| !keep.iter().any(|k| k.0 == **i))
            .collect();
        dropped.sort_by_key(|&&i| std::cmp::Reverse(get(&all, &it.station_table[i].zh)));
        let dl: Vec<String> = dropped
            .iter()
            .map(|&&i| {
                format!(
                    "{} {}",
                    it.station_table[i].zh,
                    get(&all, &it.station_table[i].zh)
                )
            })
            .collect();
        println!(
            "closeup {} {city}: {} | dropped: {}",
            if split { "SPLIT" } else { "one  " },
            line.join(" "),
            dl.join(" ")
        );
        if split {
            n_cities += 1;
            n_stations += keep.len();
            flagged.extend(keep.iter().map(|k| k.0));
        }
    }
    for i in flagged {
        it.station_table[i].closeup = Some(true);
    }
    println!(
        "closeups: {n_cities} of {} origin cities split, into {n_stations} stations",
        origins.len()
    );
}

fn main() {
    let inp = inputs::load();
    let out_path = env::var("ATLAS_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| inp.paths.files.join("china-flow-atlas-data.json"));
    let cx = Ctx::new(&inp);
    let selected = select_cities(&cx);
    let city_pt = principal_points(&cx);
    let corr = Corridor::build(&cx);
    let mut lc = LegCaches::default();
    let mut it = Interner::default();
    let out = outbound_works(&cx, &selected, &city_pt, &corr, &mut lc);
    let in_works = inbound_works(&cx, &selected, &city_pt, &corr);
    let in_throat_stations = resolve_inbound_legs(&cx, &out, &in_works, &corr, &mut lc);
    let leg_walks = orient_legs(&cx, &out.works, &in_works, &lc);
    let station_grid = throat_grid(&cx, &out.throat_stations);
    let in_station_grid = throat_grid(&cx, &in_throat_stations);
    let station_pts_all = section_station_points(&cx);
    let m = Model {
        cx: &cx,
        selected,
        city_pt,
        corr,
        lc,
        out,
        in_works,
        leg_walks,
        station_grid,
        in_station_grid,
        station_pts_all,
    };
    let (works, in_works) = (&m.out.works, &m.in_works);
    let os = sections(
        &m,
        &mut it,
        works.iter().map(|w| &w.train_leg_keys),
        works
            .iter()
            .flat_map(|w| &w.deps)
            .map(|d| (&d.leg_keys[..], &d.leg_fwd[..])),
        false,
    );
    let (nat_legs, mut national) = national_table(&m, &os);
    let is_ = sections(
        &m,
        &mut it,
        in_works.iter().map(|w| &w.train_leg_keys),
        in_works
            .iter()
            .flat_map(|w| &w.arrs)
            .map(|a| (&a.leg_keys[..], &a.leg_fwd[..])),
        true,
    );
    let asm = assemble_origins(&m, &os, &is_, &mut it);
    let (mut national_trains, extra_chains) =
        national_trains_phase(&m, &os, &nat_legs, &national, &asm, &it);
    let schedules = schedules_phase(&m, &mut it);
    let network = network_backdrop(&cx);
    let throat_geo = throat_geometry(&cx, &asm, &extra_chains, &mut national_trains, &os, &is_);
    let (about, calendar) = about_and_calendar(&cx);
    national_cities(&m, &asm, &mut national, &mut it);
    let national_index = national_index_phase(&m, &national, &it);
    station_places(&cx, &m.city_pt, &mut it);
    closeup_stations(&cx, &m.selected, &mut it);
    let mut stats: std::collections::BTreeMap<String, i64> = Default::default();
    stats.insert("origins".into(), asm.origins.len() as i64);
    stats.insert("sections".into(), os.sections.len() as i64);
    stats.insert("in_sections".into(), is_.sections.len() as i64);
    stats.insert("section_points".into(), os.total_sec_pts as i64);
    stats.insert("city_table".into(), it.city_table.len() as i64);
    stats.insert("station_table".into(), it.station_table.len() as i64);
    stats.insert("train_table".into(), it.train_table.len() as i64);
    stats.insert("network_polylines".into(), network.len() as i64);
    stats.insert("throats".into(), throat_geo.len() as i64);
    stats.insert("lines".into(), it.line_table.len() as i64);
    let out = AtlasOut {
        build: provenance::build_block(&inp),
        about,
        origins: asm.origins,
        sections: os.sections,
        in_sections: is_.sections,
        lines: it.line_table,
        throats: throat_geo,
        city_table: it.city_table,
        station_table: it.station_table,
        train_table: it.train_table,
        network,
        stats,
        schedules,
        national,
        national_trains,
        national_index,
        calendar,
    };

    let txt = serde_json::to_string(&out).unwrap();
    fs::write(&out_path, &txt).unwrap();
    println!(
        "wrote {} ({:.2} MB)",
        out_path.display(),
        txt.len() as f64 / 1e6
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leg_kmh_is_the_timetable_average_or_zero() {
        // 1318 km in 4h28 (G1 北京南 → 上海虹桥 nonstop shape)
        assert_eq!(leg_kmh(1318.0, Some(540), Some(808)), 295);
        // across midnight: minutes run from the first day
        assert_eq!(leg_kmh(100.0, Some(1430), Some(1490)), 100);
        assert_eq!(leg_kmh(-1.0, Some(0), Some(60)), 0, "unknown km");
        assert_eq!(leg_kmh(50.0, None, Some(60)), 0, "no departure");
        assert_eq!(leg_kmh(50.0, Some(60), Some(60)), 0, "no time");
        assert_eq!(
            leg_kmh(500.0, Some(0), Some(60)),
            0,
            "faster than any train"
        );
    }
}
