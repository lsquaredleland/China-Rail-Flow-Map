# China Rail — barebones handoff (v3, 2026-10-22)

The minimal continuation package for the China rail project: **all source
code, the irreplaceable raw timetable datasets, and complete instructions
to recreate every derived artifact.** Everything bulky was a build output
and has been removed; §3 is the recipe book that regenerates it.

Owner: Leland. Origin environment: Muse VM (Linux, 2 vCPU / 7 GB).
Standing engineering rules from the owner — carry them over:

- **All data-processing code is Rust**, state-of-the-art standard:
  `rustfmt`-formatted, `cargo clippy --all-targets` at **zero warnings**
  (fix properly or annotate with a justified `#[allow]`). Python only
  if essential.
- Cargo is not on PATH in fresh shells: `export PATH=$HOME/.cargo/bin:$PATH`.
- The flow atlas uses a **free basemap only** (no CARTO/API keys) and
  **MapLibre is permanently off the table** (owner decision) — its
  renderer is custom canvas/WebGL.
- **Staging discipline (owner requirement):** no version control exists,
  so algorithm changes build into a staging area first, live data is
  snapshotted before any swap, and nothing swaps without the owner's
  go-ahead. Judge rebuilds by **flow-identity** (per-origin summaries +
  atomic edge counts), never byte-identity — the pipeline has
  pre-existing run-to-run byte churn in section chaining.

---

## 1. What this project is

Two products from one pipeline:

1. **China Rail Flow Map** (web artifact `china-rail-flow-atlas`) —
   Minard-style flow map of China's top 100 rail cities by outbound and
   inbound trains/day; line width = exact count of distinct trains/day per
   shared track section (per-train dedupe, strictly proportional).
   Features Outbound + Inbound modes, exact per-train city-pair routing
   (clicking any station dot fades non-connecting trunks to ~18% opacity and
   draws the exact city-pair train volume at 100% opacity on top of the
   ghosted trunk width), 2-color HSR vs. conventional infrastructure overlay
   (`sections`: 4,274 HSR / 3,257 conv; `in_sections`: 4,146 HSR / 3,116 conv;
   `#0066cc`/`#4da3ff` HSR vs `#40231a`/`#ecdfc2` conv; 2-color legend key),
   8-class per-section flow breakdown (`G, D, C, S, Z, T, K, plain/普`) packing
   `[sec_idx, total, g, d, c, s, z, t, k, plain]` with interactive class
   filtering dynamically updating map flows, destination dots, and header
   stats, three interactive click-to-filter histograms (Hour, Distance, and
   1-hour Duration bins `0–1h` … `24h+` in `#1b9e77`), China Railway branding
   with network statistics subtitle (7,253 mapped daily services of >12,000
   nationwide across 48,000 km / 30,000 mi HSR network), sortable Duration &
   Distance columns, `—` for terminating stops, and automatic reachable
   city-pair search chips. Built into `china-rail-flow-map/`; data recreated
   by §3 step 5.
2. **Chengdu→Chongqing rail map** (artifact
   `chengdu-to-chongqing-rail-map`) — 126 trains, Tue 2026-10-20,
   corridor-classified; ground truth in
   `project/derived/chengdu-chongqing-trains.json` (included).

### 1.1 The 2026-10-22 v2+ enhancements to China Rail Flow Map

- **2-Color HSR vs. Conventional Infrastructure Overlay**: `sections` (4,274 HSR / 3,257 conv) and `in_sections` (4,146 HSR / 3,116 conv) carry `h: 1` when OSM ways have `highspeed=yes` or `maxspeed >= 200` km/h, rendered in `#0066cc` (light) / `#4da3ff` (dark) for HSR vs `#40231a` / `#ecdfc2` for conventional rail, with an interactive 2-color Infrastructure key in the legend card.
- **8-Class Per-Section Flow Breakdown (`G, D, C, S, Z, T, K, plain/普`)**: `flows` and `in_flows` rows pack `[sec_idx, total, g, d, c, s, z, t, k, plain]` (trailing zero counts stripped). Selecting any combination of classes in the map toolbar or table filter bar dynamically redraws the map's flow widths/colors, destination/source city dots, and header stats, while highlighting the selected classes as an overlay on top of the fixed background histograms.
- **Exact Per-Train Section Index (`dep_secs`, `arr_secs`, and per-call `sec_cnt`)**: `atlas-v2-out-tables.json` and `atlas-v2-in-tables.json` include each train's ordered section index list (`dep_secs` / `arr_secs`) and each call's stop-cutoff section count (`sec_cnt`). Clicking any station dot fades non-connecting trunks to ~18% opacity and draws the exact city-pair train count per section at 100% opacity on top of the ghosted full trunk width.
- **Three Interactive Histograms (Hour, Distance, Duration)**: Added the 3rd **Trains by journey time** histogram (1-hour bins `0–1h` … `24h+` in `#1b9e77`), hover count labels directly above every hovered bar, and click-to-filter on all three histograms.
- **Departures / Arrivals Table & Header Enhancements**: Added China Railway vector logo and concise subtitle (7,253 mapped daily services of >12,000 nationwide; 48,000 km / 30,000 mi HSR network), sortable **Duration** column on city-pair call tables, sortable **Distance** (`km`/`mi`) column on vanilla outbound/inbound tables, `—` for departure time on terminating stops, removed double-click camera reset, and added automatic city-pair matching ("Calling at" / "Arriving from" chip) when typing a reachable city name in `#depFilter`.

## 2. What IS in this package (34 MB unpacked, ~6 MB zipped — the raw
timetable text compresses ~7×; everything else is code and docs)

```
README.md            top-level overview and data format specification
web/                 web front-end for China Rail Flow Map (React + Bun + Brotli)
  src/               full UI source, build scripts, components, and assets
  public/assets/     pre-computed compressed atlas datasets
pipeline/            Rust Cargo workspace for OSM & timetable processing
  analyze/           analyze-rs: timetable resolution, audit, atlas assembly & packing
  router/            corridor-v3 routing & speed scoring
  filter/            fast OSM PBF -> railway XML extractor
  tiler/             MVT / PMTiles vector tile encoder
  outline/           national border polyline generator
data/                stations, gazetteers, overrides, and raw inputs
  raw/               point-in-time timetable JSONL files (stops.jsonl, trains.jsonl, etc.)
  leg_overrides.json the corridor fix's override data (§4)
  city_en.json       gazetteer English names (gazetteer v2.2 in code)
docs/                pipeline guides, benchmarks, and research reports
```

## 3. Recreate everything

Prerequisites: Rust toolchain, Node 20+ (for web build), `brotli` CLI for packing.
All commands run from the package root unless stated. Timings are the origin VM's
benchmarks (logs in `docs/benchmarks/`).

### Step 1 — rail geometry + tiles (the base layer)
```bash
curl -O https://download.geofabrik.de/asia/china-latest.osm.pbf
cd pipeline/filter && cargo run --release -- ../../china-latest.osm.pbf ../../data/osm/china-rail.osm
#   → china-rail.osm (513 MB; 3,068,371 nodes, 499,557 ways)   [~156 s]
cd ../tiler && cargo run --release -- ../../data/osm/china-rail.osm ../../data/osm/china-rail.pmtiles
#   → china-rail.pmtiles (5.9 MB)                                [~139 s]
```

### Step 2 — timetable datasets
The included `data/raw/stops*.jsonl` and `data/raw/trains*.jsonl` files ARE the datasets
used for everything below. Schema details are documented in `README.md`.

### Step 3 — resolve, route, fill (the core deliverable)
```bash
cd pipeline/analyze && cargo build --release
./target/release/analyze-rs                    # timetables deliverable + audits
./target/release/analyze-rs --route            # → data/derived/pair_distances.json
./target/release/chainfill                     # via_chain post-pass
./target/release/analyze-rs --fill-track       # route_km_track into deliverable
# Intercity variant (produces china-rail-intercity-2026-10-28.json):
./target/release/analyze-rs --stops-in ../../data/raw/stops_cs.jsonl \
    --date 2026-10-28 --out-dir ../../data/derived/cs_out
```
Graph facts baked into the code: `railway=ferry` ways are graph edges
(Hainan crossing 徐闻↔海口 40.5 km, 海口↔湛江西 156.9 km, leg status
`"ferry"`); components stitch at ≤250 m closest-node gaps (11,939
connectors, 1,901 → 397 components); station resolution is snap-aware
(1,000 km-equiv penalty for non-snapping candidates). Trunk pair census
after this step: 11,497 pairs — ok 9,845 · via_chain 565 · bridged 944 ·
ferry 4 · flagged 139 · unroutable 0 · snap_fail 0.

### Step 4 — pair paths, OSM service layer, GTFS
```bash
./target/release/paths        # → data/derived/pair_paths.json (53 MB)
./target/release/osm_export   # → output/china-rail-services-2026-10-21.osm
                              #   (gzip it → the 19 MB .osm.gz deliverable)
                              #   + output/gtfs-2026-10-21/ (zip → gtfs deliverable)
```
Service layer: 5,043 PTv2 `route=train` relations on real OSM ids
(58,406/59,074 legs with way members; bridged/unroutable legs carry an
honest `note`). GTFS: 5,043 trips, 64,117 stop_times, 1,955 stops,
single-day `calendar_dates`. Gotchas (self-closing `<node/>` coords;
station points from the streamed elements, not `osm_stations.json`;
strip 12306's space-typeset names) are documented in origin project notes.

### Step 5 — the flow-atlas dataset (what the live artifact serves)
**Since 2026-10-22 the live atlas is the corridor-v3 build** (owner's
go-ahead; `docs/corridor-v3-report.md`): per-train corridor
routing + double track merged into one corridor. Build it with the
router's two outputs (kept in `data/derived/corridor-v3/`, or
regenerated by `pipeline/router`, ~20 s) and NO
legclass overrides — a plain `atlas` run would load the rejected
`leg_overrides.json` (§4):
```bash
echo '[]' > ../no_overrides.json
export ATLAS_OVERRIDES=$PWD/../no_overrides.json \
       ATLAS_PAIR_PATHS=$PWD/../corridor-v3/pair_paths_canonical.json \
       ATLAS_LEG_PATHS=$PWD/../corridor-v3/leg_paths.json
```
Pre-v3 data: `snapshots/pre-corridor-v3-2026-10-22/` (checksummed).
```bash
./target/release/atlas        # → china-flow-atlas-data.json (v1 combined)
./target/release/atlaspack    # → the v2 five-file pack + combined v2:
#   atlas-v2-{shared,out-map,out-tables,in-map,in-tables}.json(.br)
#   atlas-v2-{out,in}.json(.br), china-flow-atlas-data-v2.json(.br)
./target/release/audit        # the audit gate — must report:
                              # dropped chains 0, flow lost 0
```
Format: shared + per-direction map/tables files (`atlas-v2-{shared,out-map,out-tables,in-map,in-tables}.json(.br)`),
array rows, integer-minute times, geometry at 1e4. Top-100 cut: #1 广州 1,201/day …
#100 麻城 137/day.
- **Infrastructure (`atlas-v2-shared.json`)**: `sections` (4,274 HSR / 3,257 conv) and `in_sections` (4,146 HSR / 3,116 conv) carry `h: 1` when OSM ways have `highspeed=yes` or `maxspeed >= 200` km/h.
- **8-Class Flow Breakdown (`out-map` / `in-map`)**: `flows` and `in_flows` rows pack `[sec_idx, total, g, d, c, s, z, t, k, plain]` (trailing zero counts stripped).
- **Per-Train Section Indices (`out-tables` / `in-tables`)**: packs ordered section index lists (`dep_secs` / `arr_secs`) and per-call section cutoff counts (`sec_cnt`), allowing the client to highlight exact city-pair train corridors at 100% opacity over ~18% ghosted trunks.
**Verify against the goldens (§7) before trusting any rebuild.** Supporting datasets: `./target/release/flowmap` →
`chengdu-flow-data.json`; `./target/release/flowstations` →
`china-flow-stations-data.json`; the country outline comes from the
`outline` crate in `project/outline/` → `china-outline.json`.

### Step 6 — spreadsheets + Chengdu workbook
```bash
./target/release/citypairs    # → china-city-pairs-2026-10-21.xlsx
                              #   (gazetteer v2.2; combined +intercity
                              #    edition: 10,072 pairs ≥10 trains)
./target/release/chengdu      # → chengdu-direct-destinations.xlsx
                              #   (610 cities direct from Chengdu)
```

### Step 7 — the corridor-routing fix (§4) as a STAGED rebuild
```bash
./target/release/legclass     # requires the GTFS stops from step 4;
#   → data/leg_overrides.json (365 overrides; identical copy included
#     in this package at data/leg_overrides.json) + legclass-report.json
ATLAS_OVERRIDES=../../data/leg_overrides.json ATLAS_OUT=<staging-dir>/atlas-fixed.json \
  ./target/release/atlas      # staged v1-format atlas
./target/release/audit        # gate on the staged build (same env vars)
#   then atlaspack against the staged file → the staged five-file pack
./target/release/secdiff      # flow-diff staged vs shipped: expect
                              # changes ONLY on overridden corridors
```

## 4. The corridor-routing fix — a verified PROPOSAL, not applied

**Problem.** Nonstop legs were drawn on unconstrained shortest-path
geometry; on parallel corridors that misroutes trains (Chengdu–Chongqing
nonstops drawn via Suining — northern geometry 302.0 km — when every true
nonstop runs the Chengyu HSR via Neijiang North, 323.4 km). Ground truth
(`research/report.md`; live 12306, 2026-10-23): **all nonstop
Chengdu–Chongqing trains use Chengyu; northern services are D-only to
Chongqing North and always stop ≥ once** (fastest 1 h 53 with stops vs
1 h 02 nonstop).

**The rule (`legclass.rs`).** Each nonstop leg is classified from its own
evidence — minutes, class, terminal. Candidate corridors per pair come
from real stopping services' stop chains + graph tilings, guarded
(monotone progress ≤3 km regression; overshoot ≤ dist+12 km; detour
≤1.45×+15 km). Chains within 4.5% form a family; a family's floor = sum
of per-segment fastest demonstrated direct-leg minutes (the segment's
theoretical best — the owner's framing). Flags: **F1** nonstop slower
than the fastest stopping service; **F4** drawn geometry matches no
corridor while a family fits; **F5** ≥25 min faster than the drawn
family's floor. Assignment needs floor error ≤ max(12 min, 12%), margin
≥8 min, implied speed ∈ [55, 320] km/h. Overrides are (pair + via-chain)
keys; if any sub-pair fails to resolve, the leg falls back to base
geometry — an override can never make a leg worse than shipped.

**Staged results** (regenerate via §3 step 7): 1,564 pairs flagged;
4,538 flagged legs correctly untouched; **365 legs re-routed** (364 by
rule + G2450 hand-adjudicated — `corridor-fix/MANUAL_OVERRIDES.md`).
Largest: 唐山→秦皇岛 28 G + 24 back (Tianjin–Qinhuangdao HSR, 37–42 min,
drawn on the conventional line, floor 103); 合肥↔芜湖 27; 西宁↔兰州 26.
Chengdu–Chongqing: D951/D2208/D5128 + five westbound north;
G2445/G2446/G2447/G2450 via Chongqing West; D846/D862 (+D848/D864 back)
south loop. Control run (empty overrides) is **flow-identical** to
shipped — zero changed atomic edges, all 100 origins, both directions.

**Owner's decision (2026-10-22): DO NOT APPLY. Live v1 stays.** From the
before/after previews (`docs/previews/`), v2 looked less viable: the
network data has real **geometry gaps** — pairs with no track geometry
at all, existing only as chords: （平昌→达州）, （南京→扬州）. Two
overrides could not take effect even staged (fallback, no regression):
**K531 成都西→达州** and **K284 南京→上海**. Filling those gaps is a
prerequisite for any future v2.

**Open: G3355** （成都东→重庆西 109 min). Classifier: south loop (fits
the segment-floor sum; fits neither Chengyu's ~86 floor nor the north
~137). Counter: no demonstrated south-loop through service beats 2 h 07;
the audit + small map kept it on Chengyu. Decide with fresh evidence
(a live stop-list pull) before any swap.

## 5. What is NOT in v3, and where its recipe lives

| Removed artifact | Recreate |
|---|---|
| `china-rail.osm`, Geofabrik PBF | §3 step 1 |
| `china-rail.pmtiles` | §3 step 1 |
| Atlas datasets (five-file v2 pack, combined v1/v2, per-direction) | §3 step 5 |
| Staged corridor-fix pack + staged atlas + pre-swap backup | §3 step 7 |
| OSM service layer `.osm.gz` (19 MB) | §3 step 4 |
| GTFS zip | §3 step 4 |
| `pair_paths.json`, `pair_distances.json`, `cs_out/`, `c_out/` | §3 steps 3–4 |
| Spreadsheets (city pairs ×2, Chengdu workbook) | §3 step 6 |
| `chengdu-flow-data.json`, `china-flow-stations-data.json`, `china-outline.json`, `china-rail-timetables-*.json`, `china-rail-intercity-*.json`, `beijing-shanghai-raw-trains.json` | §3 steps 3, 5 |
| `legclass-report.json`, secdiff dumps, build logs | §3 step 7 (conclusions in §4) |
| Pre-gapfix snapshots | Not recreatable — regression role spent; results in §4 + session notes |
| Operating-days crawl state (221 MB) | Belongs to the separate workstream (§6), still in the origin workspace |
| `project/smt/` (57 MB) | A third-party timetable app — not project work; left in the origin workspace |

Kept despite being derivable, deliberately: the `data/raw/stops*.jsonl` timetable datasets
(point-in-time; §2) and `data/leg_overrides.json` (365 records — the auditable
input of §4, 125 KB).

## 6. Other open work (deferred; none started)

1. **Inbound leg-resolution defect** (audit finding; owner deferred it —
   outbound first). `resolve_leg` is called at one site in `atlas.rs`
   (outbound); the inbound pass reads only the cache and skips misses.
   Chengdu measured: **70 legs dropped (89/3,822 occurrences), 66/558
   trains affected, ~10,100 train-km ≈ 2.9% of inbound geography**;
   undercounts e.g. 成都西 17 true vs 9 shipped. Totals/widest (111)
   unaffected. Fix: resolve on demand in the inbound pass — and in
   `audit.rs`, which copies the same behaviour and checks outbound only.
2. **Performance pass**: baselines first (first paint, per-file
   fetch+parse, origin-switch, frame cost; desktop + throttled), then
   staged parse, backdrop caching + viewport culling; goldens re-checked
   per change. Geometry coarsening ~500 m proposed, never approved.
   Sandbox timings ≠ the owner's phone (Oppo Find N6).
3. **Operating-days** (separate thread): per-train operating patterns
   for ~7,250 trains. Pilot passed (witness agreement 100% on 1,134
   train-days; 220/234 daily). Atlas integration deferred until
   the dataset lands.
4. **Delivered (2026-10-22 v2+)**: class filters (8 classes: G, D, C, S,
   Z, T, K, plain) with reactive flow/dot updates, 3 interactive click-to-filter
   histograms (Hour, Distance, Duration) with overlay highlights, 2-color
   HSR/conventional infrastructure overlay, and exact per-train city-pair
   section highlighting.
   **Parked**: filter optimisation (benchmarks were test-only); hour-of-day
   animation; same-corridor section merging (identified, never authorised).
   Small-map caveat: its reverse direction was verified structurally, never
   live-driven.

Reference numbers: renumbering is endemic — 31.1% of trunk services
carry >1 public code (parity flips at reversals; count physical services
by internal train_no, never by public code). Stopping patterns are
mostly unique (89.3% unique intermediate patterns in multi-train OD
groups — 梯次停站）. Trains 5611/5612 （内江↔江津， last pair on the old
Chengyu line) are in NO dataset: sold only at station windows / on
board, never on 12306 (`research/notes/train-5611-5612.md`).
Documented quirk: 392/214,167 inbound call rows are loop trains whose
source-relative arrival differs from the arrivals row — both true in
their own frame; the join is deliberately unchanged.

## 7. Goldens — verify every rebuild against these

- Chengdu outbound: **564 trains / 610 cities / widest 145 / 561 of 564
  fully tracked / 4 chord legs** (corridor-v3, live since 2026-10-22;
  pre-v3: widest 133 / 544 / 8 — double track was split, chords
  unrouted)
- Chengdu inbound: **558 arrivals / 627 sources / widest 108** (pre-v3
  111; five westbound D trains now on the northern route)
- Chengdu↔Chongqing: 136 out (53 terminating), 136 in (54 originating),
  fastest 62 min both ways
- Trunk pair census (§3 step 3); audit gate: dropped chains 0, flow
  lost 0; staged-vs-shipped secdiff touches only overridden corridors
- Chengdu direct: 重庆 136, 广州 21 (6:54), 上海 17 (10:06), 北京 13
  (7:30), 香港 1 (8:18), 拉萨 1 (34:38); 819 trains/day stop in Chengdu

## 8. Provenance

Built 2026-10-13 → 2026-10-22 (origin main chat + "China rail project"
side chat). Day logs: `docs/session-notes/`. This v3 supersedes the v1
(10.5 MB, 2026-10-21) and v2 (111 → 74.6 MB, 2026-10-22) handoff zips;
packing script: `~/workspace/your_files/build-handoff-v3.sh` (origin
environment). Data sources: OpenStreetMap contributors (ODbL) via
Geofabrik; timetables from live 12306 queries. Distances are computed
from OSM geometry — engineering estimates, not official CR kilometrage.
