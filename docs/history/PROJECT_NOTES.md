# China Rail — data pipeline & handoff

Everything here was built Oct 13–20, 2026 to answer one question: **what does
China's rail network actually look like, and where does each train really run?**
It has three layers:

1. **Network layer** — all Chinese railway track geometry from OpenStreetMap,
   as a filtered extract and as web-map tiles (`china-rail.pmtiles`).
2. **Timetable layer** — every long-distance train running on Wed 2026-10-21
   (5,530 discovered, 5,043 with full stop lists,
   59,074 legs), with each station resolved to OSM coordinates
   (1,963/1,963 stations matched).
3. **Routing layer** — track-accurate distances for all 11,502 unique
   consecutive stop pairs, computed by A\* over the OSM track graph, audited,
   repaired, and filled back into the timetable as `route_km_track`
   (4,561 of 5,043 trains fully routed; median track = 1.099 × straight-line).

**Start with `deliverable/china-rail-timetables-2026-10-21.json`** — that is
the finished product. Everything else is the machinery that produced it, plus
one regional case study (Chengdu ⇄ Chongqing) where trains were additionally
*drawn* on the track geometry.

Intended next step (design already worked out): draw the national trains on
the infrastructure the same way the regional map does — route **pairs** once,
store one simplified polyline per pair, stitch per train at view time. See
"Drawing trains nationally" at the bottom.

---

## Folder map

```
china-rail/
├── README.md                  ← this file
├── deliverable/
│   └── china-rail-timetables-2026-10-21.json   ★ THE deliverable (5.2 MB)
├── china-rail.pmtiles         network tiles for web maps (5.9 MB, 2,392 tiles)
│
├── filter/                    Rust: Geofabrik PBF → rail-only OSM XML
│   └── src/main.rs, src/bin/probe.rs
├── tiler/                     Rust: rail OSM XML → PMTiles (MVT encoding)
│   └── src/main.rs, src/bin/{stats,validate}.rs
│
├── data/                      12306 national timetable datasets + analysis inputs
│   ├── raw/
│   │   ├── trains.jsonl       5,530 discovered trains (raw input)
│   │   └── stops.jsonl        5,043 full stop lists (raw input)
│   ├── pair_distances.json    ★ routing result: 11,502 pairs, distances+status
│   ├── station_resolution.json, bad_stations.json, unmatched_stations.json
│   ├── osm_stations.json, stations.json, station_candidates.tsv, want_names.txt
│   └── analyze-rs/            Rust analyzer + router (the core program)
│       ├── src/main.rs        station resolution, deliverable build, --route, --fill-track
│       ├── src/graph.rs       graph build, A*, bounded Dijkstra
│       └── src/bin/{chainfill,gcheck,pairdiff}.rs
│
├── derived/                   Chengdu⇄Chongqing regional map data (JSON)
│   ├── rail-base.json             OSM track polylines for the region (faint base)
│   ├── stations.json              56 stations: name → lon/lat/English
│   ├── chengdu-chongqing-trains.json   126 forward trains w/ leg stops+times
│   ├── chongqing-chengdu-trains.json   132 reverse trains
│   ├── routed-train-paths.json    ★ forward trains drawn on track geometry
│   ├── routed-reverse-paths.json  ★ reverse trains drawn on track geometry
│   └── station-pair-stats.json    per-pair counts + fastest/avg/slowest
├── routing/                   regional track-routing workbench (Python)
│   ├── build_routed.py / build_routed_rev.py   regenerate the routed-paths files
│   ├── segment_paths.json     147 routed segments (raw graph node paths)
│   ├── route_v3.py            best-of-snap A* router (the good one)
│   ├── *_overpass.json        live-OSM patch geometry merged into the graph
│   └── fix_*.py, diag_*.py, route_*.py, *_log.txt   forensics, see "Lessons"
│
├── reverse/                   Chongqing→Chengdu reverse pull (Node)
│   └── pull.mjs               (a first same-day pull got only 60 trains —
│                               departed trains drop out; re-pull on a future date)
├── oldline/                   one-off study: does anything still use the old
│   └── check.mjs, segment.mjs 1952 Chengdu–Chongqing line? (Answer: no —
│                               12 conventional trains/day, all via Suining)
├── fresh/                     fresh-Geofabrik re-pull experiment (Oct 20)
│   └── out/                   re-run outputs; see "The fresh-pull verdict"
└── docs/
    └── 12306-realtime-SKILL.md   how the 12306 read-only APIs work
```

Not in this zip (too large, regenerable — see "Rebuilding from scratch"):
`china-latest.osm.pbf` (1.6 GB), `china-rail.osm` (513 MB),
`fresh/china-2026-10-20.osm.pbf` (1.6 GB), `fresh/china-rail-fresh.osm`
(538 MB), Rust `target/` dirs, and the `smt/` folder
(a dead-end investigation of the 盛名时刻表 app — only its notes file,
`smt/SMT-FORMAT-NOTES.md`, is included in `docs/`).

---

## The deliverable

`deliverable/china-rail-timetables-2026-10-21.json`:

```json
{ "date": "2026-10-21",
  "source": "12306 (leftTicket + czxx/queryByTrainNo)",
  "trains_discovered": 5530, "stop_lists": 5043, "station_match_rate": 1.0,
  "route_km_track": { "pairs_audited": 11340, "pairs_total": 11502,
                      "trains_fully_routed": 4561, "about": "…" },
  "trains": [ { "train_no", "code", "class", "origin", "destination",
                "date_used", "stops": [{ "no", "name", "arrive", "depart" }],
                "route_km_track": 1310.7,            // or null
                "route_km_track_legs_audited": 6,
                "route_km_track_legs_total": 6 } ] }
```

- `route_km_track` is the sum of audited per-pair track distances — present
  only when **every** leg of the train has an audited pair distance,
  otherwise `null` (never a partial sum pretending to be a total). The two
  `legs_*` fields give coverage for the nulls. 482 trains are null; 434 of
  them are blocked by exactly **one** leg.
- Station coordinates are not in the deliverable stops; they live in
  `data/station_resolution.json` (per-name chosen cluster) and the
  resolution logic in `analyze-rs`.

## pair_distances.json — the routing layer

`data/derived/pair_distances.json`: one entry per unique geographic consecutive
stop pair: `{ from, to, chord_km, track_km, ratio, status, flags, gap_km,
classes, uses, fastest_leg_min }` (+ `chain_*` evidence on `via_chain` pairs).

| status | n | meaning |
|---|---|---|
| `ok` | 9,772 | direct A\* passed audits (ratio ∈ [0.97, 1.40], fastest scheduled leg ≤ 355 km/h) |
| `bridged` | 994 | A\* failed, but the gap between the two Dijkstra frontiers was ≤ 10 km and the bridged distance passed the same audits — an estimate across unmapped/unjoined track; `gap_km` says how big the hole is |
| `via_chain` | 574 | distance summed over the routed sub-pairs of the fastest *stopping* service between the same endpoints (its corridor is the one fast trains actually use); `prev_status` keeps the original |
| `flagged` | 140 | routed but failed an audit — mostly ratio 1.5–1.7; some genuinely circuitous mountain lines, some graph holes |
| `unroutable` | 13 | no path in the graph (incl. 海口⇄徐闻/湛江西 — trains cross the Qiongzhou Strait by ferry; there is no track) |
| `snap_fail` | 9 | a station point sits > 6 km from any graph node — all involve 泉州东 (Fuxia HSR) |

Biggest single blockers (trains that would gain a `route_km_track`):
西安东↔西安北 (flagged, ratio 1.90, 54 trains), 汉口↔武汉 (1.66, 52),
义乌↔横店 (1.71, 33), 镇江↔扬州东 (ratio **7.56** — a clear graph hole at the
Yangtze crossing, A\* detours via Nanjing; 25 trains), 泉州东→厦门北 (11).

## Pipeline — how each stage was produced

Working rule (user's standing directive): **Rust wherever possible**; Python only in the
regional routing workbench, which predates the rule.

1. **Extract.** Download `china-latest.osm.pbf` from Geofabrik
   (https://download.geofabrik.de/asia/china-latest.osm.pbf), run `filter/`
   → `china-rail.osm` (railway ways/relations + stations; 3,068,371 nodes,
   499,557 ways; metadata dropped, tags kept).
2. **Tile.** `tiler/` reads `china-rail.osm` → `china-rail.pmtiles`
   (MVT in PMTiles; consumed by a custom workerless WebGL renderer — MapLibre
   is off the table in that environment, its zero-worker mode throws).
3. **Timetables.** Pre-collected timetable snapshot data is loaded from
   `data/raw/` (`trains.jsonl` and `stops.jsonl`).
4. **Resolve + build deliverable.** `analyze-rs` (no flags): streams
   `china-rail.osm`, collects station candidates (nodes *and* station ways —
   榆社西 and 马兰 exist only as footprint polygons; names matched on
   `name:zh`, `name`, `name:zh-Hans`), drops subway points, clusters points
   within 3 km, then per train picks the candidate combination minimizing
   total leg distance (DP over the stop sequence) with timetable hop times
   as a cross-check. Emits the deliverable + resolution audit.
   `--emit-distances` adds the straight-line fields `od_km` /
   `route_km_straight_sum` (off by default — they were deliberately stripped;
   the chord sum understates track distance by ~10% median).
5. **Route.** `analyze-rs --route`: builds the national graph
   (2,230,513 nodes / 2,317,695 edges from 419,342 `railway=rail` ways),
   snaps stations (≤ 6 km), A\* per pair (~22 s), audits, then gap-bridging
   (bounded Dijkstra from both ends; full run ~66 s) → `pair_distances.json`.
   `gcheck` is the connectivity diagnostic used to localize holes.
6. **Chainfill.** `analyze-rs` bin `chainfill` post-processes
   `pair_distances.json`: for nonstop pairs, take the fastest stopping
   service's already-routed sub-pairs (sanity: ratio ∈ [0.97, 1.45],
   implied speed ≤ 355, stopping duration ≤ 1.6 × nonstop + 30 min).
7. **Fill.** `analyze-rs --fill-track`: loads `pair_distances.json` and adds
   `route_km_track` + leg-coverage fields to the deliverable. Matching is
   geographic, not just by name: a leg's own haversine chord must match the
   pair entry's `chord_km` (≤ 0.6 km), which disambiguates the 9 name pairs
   that exist twice with different endpoints （平顶山西/泉州东 area); lookup
   keys are whitespace-stripped because some 12306 stop lists typeset names
   with internal spaces ("青  岛北").

## Regional case study: Chengdu ⇄ Chongqing drawn on track

`derived/` + `routing/` built the "Chengdu to Chongqing Rail Map": a faint
OSM base for the region, then 126 forward + 132 reverse trains drawn along
the actual track geometry through their stops, colored by corridor
(Chengyu / Suiyu / South / Loop), with a station-pair summary table.

Method (all in `routing/`, Python): build a haversine graph from the
regional OSM ways, A\* every consecutive stop pair with **best-of-10×10
snap-pair selection** (taking the first connecting snap inflated legs —
e.g. 内江北→隆昌北 83 km for a 28 km hop), simplify to ~20 m with every stop
coordinate pinned. Nonstop trains: distance-only routing sends
Chengdu→Chongqing North via Suiyu, but the ~1 h 20 timings rule that out —
they were routed via 内江北 on the Chengyu alignment and drawn dashed,
labeled "alignment inferred, stops exact". This is the same insight
`chainfill` later generalized nationally.

## Lessons / gotchas (expensive ones, pre-paid)

- **OSM China data is broad but imperfectly joined.** The dominant defect is
  connectivity breaks *inside* the source data (ways drawn but not
  node-joined at junctions), then freshness lag on very new lines, then rare
  genuinely unmapped stretches (~6.7 km of 绵泸高速线 south of 白马北 is
  unmapped even in live OSM; the regional map bridges it with a smooth curve
  and says so on the train's panel).
- **The fresh-pull verdict (Oct 20):** a brand-new Geofabrik pull re-routed
  to `fresh/out/pair_distances.json` changed almost nothing (ok 9,771 vs
  9,772; flagged 141 vs 140). Re-pulling does **not** fix the holes — they
  are in upstream OSM itself. Fixes come from targeted live-OSM (Overpass)
  merges per hole site, like `routing/*_overpass.json`. (Overpass needs a
  custom `User-Agent` header or it returns 406.)
  Earlier write-ups blamed our PBF filter for dropping ways; a probe of the
  original PBF disproved that (0 ways missing at the hole sites).
- **HSR is not better documented than conventional** where it matters:
  pre-repair failure rates were 11.4% (HSR-only pairs) vs 10.6%
  (conventional-only).
- **Same station name ≠ same station.** Duplicate-name traps handled by the
  DP/cluster logic and the chord check: 璧山 HSR vs metro namesake 12 km
  away; a stale `was:railway` point for 重庆西; subway stations polluting
  name matches （嘉兴 had an 84-train, 2,264 km spread before filtering).
- **12306 same-day queries drop already-departed trains** — timetables
  must always be queried for future dates (the first reverse pull's 60 trains vs the real ~132).
- Cross-check between the two G8711 routings: regional (hand-patched graph)
  406.1 km vs national (bridged) 399.5 km for the same 9 stops — the ~6.6 km
  delta *is* the unmapped 绵泸 stretch; the national bridge runs tighter
  than the real S-curve.

## Drawing trains nationally (the planned next step)

1. Extend the router with parent-pointer A\* to emit `pair_paths.json`
   (one simplified polyline per pair, stops pinned) **in the same run** as
   `pair_distances.json`, so drawn length = `route_km_track` by
   construction.
2. Draw rules by status: `ok` → path as-is; `via_chain` → stitch the chain's
   sub-pair paths; `bridged` → real track to both frontiers + dashed labeled
   gap; `flagged` / `unroutable` / `snap_fail` → dashed chord, never the A\*
   detour.
3. Patch the high-leverage holes first （镇江–扬州东， 兴文， 义乌–横店） via
   Overpass merges verified with `gcheck` — don't expect a re-pull to help.
4. Render as an overlay on the existing PMTiles/WebGL national map; ship
   pair geometry as an indexed store fetched per train (~10–15 KB/view),
   not as one page-load payload.

## Rebuilding from scratch

```bash
# 0. prerequisites: Rust (cargo), Node 20+
# 1. extract
curl -O https://download.geofabrik.de/asia/china-latest.osm.pbf
cd pipeline/filter && cargo run --release -- ../../china-latest.osm.pbf ../../data/osm/china-rail.osm
# 2. tile
cd ../tiler && cargo run --release -- ../../data/osm/china-rail.osm ../../data/osm/china-rail.pmtiles
# 3. resolve + deliverable, route, chainfill, fill (using pre-compiled data/raw/ datasets)
cd ../analyze && cargo build --release
./target/release/analyze-rs                    # deliverable + audits
./target/release/analyze-rs --route            # pair_distances.json
./target/release/chainfill                     # via_chain post-pass
./target/release/analyze-rs --fill-track       # route_km_track into deliverable
#    (--out-dir <dir> redirects all outputs for a test run)
# 4. service layer (OSM PTv2 relations) + GTFS
./target/release/paths                         # pair_paths.json: OSM node-id path per pair
./target/release/osm_export                    # china-rail-services-2026-10-21.osm + gtfs-2026-10-21/
```

## Service layer + GTFS (2026-10-20)

`paths` (analyze-rs/src/bin/paths.rs) extends the router with parent-pointer
recovery: ok pairs → A* path, bridged → Dijkstra frontier paths from both
ends (2 segments, gap recorded), via_chain → stitched sub-pair segments.
Output `pair_paths.json`: 11,479 pairs, 11,318 with paths,
4.78M path nodes. Residual length mismatches vs pair_distances: 105
(mostly chain-candidate selection among same-name duplicate pairs).

`osm_export` (analyze-rs/src/bin/osm_export.rs) converts the deliverable
into an OSM PTv2 service layer + a GTFS feed:

- `files/china-rail-services-2026-10-21.osm.gz` (19 MB gz, 268 MB raw):
  5,043 `type=route, route=train` relations (one per train/direction) +
  3,132 `route_master` relations (number pairs). Members reference REAL
  OSM ids: station nodes/ways as role=stop (0 missing), railway=rail ways
  derived from pair paths (58,406/59,074 legs; 4,442 trains complete).
  Relations with bridged/unroutable legs carry a `note` tag — way members
  are honestly incomplete there. Overlay file: merge with infrastructure
  in JOSM before any use/upload (an osm.org import would additionally
  need a community proposal + a 12306 source-license check).
- OSM has NO timetable fields: the `departures` proposal was rejected;
  only `duration` (set, from the snapshot day), `interval`, and
  `opening_hours` exist. The schedule itself ships as GTFS:
  `files/gtfs-2026-10-21.zip` — 5,043 trips, 64,117 stop_times,
  1,955 stops (telecode ids), single-day service via calendar_dates.
- Gotchas honored: self-closing `<node/>` elements carry the coords
  (missing them silently breaks station-way centroids + pair scoring);
  station points must come from the streamed station elements, NOT
  osm_stations.json (partial snapshot — lacks 榆社西/马兰/香港西九龙);
  12306's space-typeset names ("青  岛北") are whitespace-stripped
  before every lookup.

Intercity timetable dataset (2026-10-28, 89 corridors): DONE and assembled —
5,502 trains discovered; stop lists for 1,590 C-class AND 620 S-class
trains (2,210 total). The S class matters: several bureaus renumbered
intercity services from C to S （成都 成灌/成雅 S5xxx, 长株潭 S6xxx,
广州局 S47xx), and a C-only phase-2 filter silently drops them — the
single biggest accuracy trap in this pipeline. Deliverable:
`files/china-rail-intercity-2026-10-28.json` (735 stations, 100% OSM
match, 2,082/2,210 trains fully track-routed via cs_out pipeline).
Combined spreadsheet `files/china-city-pairs-2026-10-21-plus-intercity-2026-10-28.xlsx`
(10,072 pairs ≥10 trains; gazetteer v2.1/v2.2 folds intercity district
stations — 广州东环/长株潭/成灌 urban stops — into their cities).
Verified non-gaps: 武咸城际 runs 0 dedicated trains on 2026-10-28 and
武孝 ~1 (services withdrawn; live-checked) — their pair counts are
through G/D/K trains. 上海金山铁路 remains omitted (no telecodes).

Data sources: OpenStreetMap contributors (ODbL) via Geofabrik; timetables
from 12306 live queries for 2026-10-21. Distances are computed from OSM
geometry — they are engineering estimates, not official CR kilometrage
(G1 北京南→上海虹桥 computes 1,310.7 km vs the official 1,318 km).
