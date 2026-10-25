# China Rail — barebones handoff (v3, 2026-10-22)

> **Status (read first).** The live, maintained parts of this document are
> **§3 (recipe, especially step 5 and the O9 router inputs)** and **§7 (goldens)**.
> §1 (project description), §5 (what was removed from the v3 handoff zip) and
> §8 (provenance) are **handoff-era history**, kept for context only; their
> paths (`project/`, `deliverable/`) and package contents no longer match this
> repo. Binaries that exist today: `pipeline/analyze/src/bin/{atlas,atlaspack,audit,chainfill,legclass,osm_export,paths,secdiff}.rs`
> plus `analyze-rs` (main), `pipeline/filter` (main, `probe`), `pipeline/router`
> (main, `cordcheck`, `splitcheck`), `pipeline/tiler` (main, `stats`, `validate`)
> and `pipeline/outline` (main).


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

## 1. What this project is (history: handoff-era)

Two products from one pipeline:

1. **China Rail Flow Map** (web artifact `china-rail-flow-atlas`) —
   Minard-style flow map of China's top 100 rail cities by outbound and
   inbound trains/day; line width = exact count of distinct trains/day per
   shared track section (per-train dedupe, strictly proportional).
   A train that re-covers the same track (e.g. 土溪→平昌→达州) counts once in the
   static flows while the animation shows each pass, so static < animated there
   by design (成都 out, 达州 side: static 1, animated 2).
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
routing + double track merged into one corridor. The router's two outputs
live in `data/derived/corridor-v3/` (or regenerate with `pipeline/router`,
~20 s; modules, `--config` TOML thresholds and how to plug in another
schedule or OSM network: `pipeline/router/README.md`). The live pack is built WITH `data/leg_overrides.json` (see "Actual
live recipe" below); an empty-overrides build does not reproduce it. A bare
`atlas` run loads `leg_overrides.json` (§4) by default.
Pre-v3 data: `snapshots/pre-corridor-v3-2026-10-22/` (checksummed).
```bash
./target/release/atlas        # → china-flow-atlas-data.json (v1 combined)
./target/release/atlaspack    # → the v2 five-file pack + combined v2:
#   atlas-v2-{shared,out-map,out-tables,in-map,in-tables}.json(.br)
#   china-flow-atlas-data-v2.json(.br)  (original section numbering)
./target/release/audit        # the audit gate — must report:
                              # dropped chains 0, flow lost 0
```

**Asset swap (deploying a rebuilt pack).** `web/public/assets/` carries only
the `.json.br` files the web app fetches: `atlas-v2-{shared,out-map,out-tables,in-map,in-tables,schedules}.json.br`
and `china-outline.json.br`. Copy just those. The combined `atlas-v2-{out,in}.json.br`
and the plain `.json` copies (`atlas-v2-schedules.json`, `china-outline.json`)
are not fetched by the app (it loads `<url>.br`, with a plain `.json` fallback
that is not deployed) and only add to the deploy size.
Format: shared + per-direction map/tables files (`atlas-v2-{shared,out-map,out-tables,in-map,in-tables}.json(.br)`),
array rows, integer-minute times, geometry at 1e4. Top-100 cut: #1 广州 1,201/day …
#100 麻城 137/day.
- **Infrastructure (`atlas-v2-shared.json`)**: `sections` (4,274 HSR / 3,257 conv) and `in_sections` (4,146 HSR / 3,116 conv) carry `h: 1` when OSM ways have `highspeed=yes` or `maxspeed >= 200` km/h.
- **8-Class Flow Breakdown (`out-map` / `in-map`)**: `flows` and `in_flows` rows pack `[sec_idx, total, g, d, c, s, z, t, k, plain]` (trailing zero counts stripped).
- **National table (`atlas-v2-national.json`, P3.1; staged, not yet in `web/public/assets`)**: `{fmt, trains, total, by_class}`, arrays parallel to `sections`: distinct trains/day per section, every train counted once nationally, split into the same 8 classes. Format and rule: `atlaspack.rs` header and `docs/DECKGL_MIGRATION.md` (P3.1 as built).
- **Per-Train Section Indices (`out-tables` / `in-tables`)**: packs ordered section index lists (`dep_secs` / `arr_secs`) and per-call section cutoff counts (`sec_cnt`), allowing the client to highlight exact city-pair train corridors at 100% opacity over ~18% ghosted trunks.
**Actual live recipe (verified 2026-10-24).** The live pack reproduces only
WITH `data/leg_overrides.json` (44 variant legs); an
empty-overrides build matches Chengdu's goldens but differs on 93,072
edges elsewhere. In this repo, rebuild staged:
```bash
source ../staging/env.sh   # CRFM_DATA_DIR/CRFM_OUTPUT_DIR -> staging/inputs (cp -c clones of
                           # handoff-v3 inputs), ATLAS_PAIR_PATHS, ATLAS_LEG_PATHS,
                           # ATLAS_OVERRIDES=staging/inputs/data/leg_overrides.json
# Router inputs (since O17, 2026-10-24): one full, deterministic corridor-router
# run; no splice. The build reads exactly these files:
#   ATLAS_LEG_PATHS  = staging/inputs/data/derived/corridor-v3-hybrid/leg_paths.json
#   ATLAS_PAIR_PATHS = data/pair_path_fixes.json,
#                      staging/inputs/data/derived/corridor-v3-hybrid/pair_paths_canonical.json
# Regenerate corridor-v3-hybrid/ (~25 s; byte-identical run to run and across
# --threads, apart from timings in summary.json):
#   ../pipeline/target/release/corridor-router --data ../data \
#       --files ../staging/inputs/output \
#       --out ../staging/inputs/data/derived/corridor-v3-hybrid \
#       --station-fixes ../data/station_fixes.json \
#       --config ../pipeline/router/recipe.toml
# recipe.toml sets the canonical pair geometry to `[canon] mode = "hybrid"`
# (production's path unless the pair's timetable favours another one; the
# rule and its margins are in pipeline/router/README.md, PR #23).
# The committed pack is this hybrid build (swapped 2026-10-24, PR #23). The
# previous default-config build (canonical = shortest) came from
# corridor-v3-o17 without --config; it differs by ~1.01M fine edges.
# pair_path_fixes.json goes FIRST (first record per pair wins): pairs whose
# station snapped to a homonym (禹州, 郏县; 恩平/江门–阳江, which the router
# leaves bridged). Regenerate with scripts/o9_fix_paths.py (header has the
# inputs). 聊城西–菏泽东 stays a chord (京港高速线 is unjoined at 菏泽东 in OSM;
# owner: no synthetic connector). The pre-O17 corridor-v3-o9/ splice
# (scripts/o9_splice_router.py, removed in PR #15; in git history) is retired.
C=$PWD/../staging/inputs/data/derived/corridor-v3-hybrid
export ATLAS_LEG_PATHS=$C/leg_paths.json
export ATLAS_PAIR_PATHS=$PWD/../data/pair_path_fixes.json,$C/pair_paths_canonical.json
O=$PWD/../staging/corridor-v3-ordered
ATLAS_OUT=$O/china-flow-atlas-data.json ./target/release/atlas
./target/release/atlaspack --in $O/china-flow-atlas-data.json --out-dir $O
AUDIT_PACK_DIR=$O ./target/release/audit          # full audit + pack gates + goldens
# audit reads <name>.json.br when present, else <name>.json, so this audits the
# committed pack too (what the CI `pack-audit` job does):
#   AUDIT_PACK_DIR=../web/public/assets ./target/release/audit --pack-only --goldens goldens.json
# --pack-only cannot gate dropped_chains / flow_lost: they need the OSM extract
# (a dropped chain never reaches the pack), so only the full run enforces them.
./target/release/secdiff --old ../staging/swap-hybrid/china-flow-atlas-data.json \
    --new $O/china-flow-atlas-data.json --edges   # must report 0 changed edges
./target/release/secdiff --old ... --new ... --classes   # per-edge class columns (8 classes)
# router, atlas and atlaspack are deterministic: identical inputs give a
# byte-identical pack (O17, O18), so `cmp` the .br files against web/public/assets.
```
The `--old` baseline is the build behind the committed pack (its `.br` files
are byte-identical to `web/public/assets`). Always set `CRFM_OUTPUT_DIR` /
`ATLAS_OUT` / `--out-dir` so a build never overwrites `output/` or
`web/public/assets`.

**Pack format `fmt: 6`** (every one of shared / out-map / in-map /
out-tables / in-tables carries `fmt: 6`; the client refuses anything else.
Documented in the `atlaspack.rs` header; 5 = 4 plus renumbered sections, delta
map flows and per-train paths, O15 + O6; 6 = 5 plus station throats in the
paths, O1). The *decoded* per-row meaning is fmt 4's plus the throats:
- **Section ids** are renumbered "long paths first", per direction
  (`sections` for outbound, `in_sections` for inbound, independently).
- **Map flows** (`flows`, `in_flows`) are sorted by section id; column 0 is
  the delta to the previous row's section id, the other columns are unchanged.
- **Per-train paths:** tables carry `paths[t]` (the longest row of train `t`,
  raw signed ids). Out rows are suffixes `paths[t][dep_off[i]..]`, in rows are
  prefixes `paths[t][..arr_len[i]]`; out-tables also carry `stop_pos[t]` and
  both carry `chords` (`[[t, legs]]`) in full-path coordinates, from which the
  per-row `dep_chord_legs` / `dep_stop_pos` / `arr_chord_legs` below are
  rebuilt exactly. `atlaspack` hard-asserts every row is such a slice.
- `atlas-v2-{out,in}.json` are no longer written.
- **Station throats (O1, fmt 6):** `throats` in the shared file is a list of
  polylines (geometry only). `near_station` keeps the track within 1.3 km of
  every stop out of the flow sections; each maximal run of those edges inside
  one leg is a throat (deduped globally, simplified like the sections). Path
  entry `n + j` (`~(n + j)` when reversed), with `n` = that direction's
  section count, is throat `j`. Throats are never flows: no map flow rows, no
  `sec_cnt`, no flow counting. Removing them from a path gives the fmt 5 path
  exactly (`scripts/check_pack_roundtrip.mjs` proves it on a whole pack).

Decoded per-row fields (what `lib.ts` `expandOutTables` / `expandInTables`
rebuild, and what `audit` expands to):
- `dep_secs` / `arr_secs` are in **travel order**; an entry `~s` (= `-(s+1)`)
  means section `s` is travelled against its stored point order. A train
  that runs back over track it already used repeats those sections; only
  back-to-back duplicates collapse (of the same signed section, also across
  throats in between). Flow counting still dedupes per train. Entries `>= n`
  are throats (above).
- Positions (`dep_chord_legs`, `arr_chord_legs`, `dep_stop_pos`, and
  `dep_off` / `arr_len`) index the whole path, throats included; `sec_cnt`
  counts flow sections only.
- `sec_cnt`: outbound = prefix count (origin → stop); inbound = trailing
  count (boarding stop → arrival).
- `dep_chord_legs` / `arr_chord_legs`: `[stop, s0, s1]` per leg with no
  track geometry. `stop` is the schedule index of the departing stop;
  `[s0, s1)` is the half-open range of path positions the leg produced.
  The track either side of the gap is at positions `s0-1` and `s1`.
- `dep_stop_pos`: per dep row, one entry per stop after boarding (station
  level; city calls keep only the first station of each city): the number
  of `dep_secs` entries before that stop. The stop sits at the start of the
  departing leg's first entry, i.e. its throat at the station, so dwells sit
  at the station (not 1.3 km down the line). The terminus is at the path end.
  The stops are `schedules[t][len - stops ..]`, which give stations and
  times; the client builds its dwells from these (O14).
- `atlas-v2-schedules.json` is generated from `data/raw/stops*.jsonl`,
  indexed by train `t`, with rows `[stIdx, arrMins, depMins, dayOff, legKm]`
  and station names normalized.

**Provenance (`shared.build`).** `atlas` records, and `atlaspack` copies into
`atlas-v2-shared.json`, `build = { pipeline_tree, osm_sha256, leg_paths_sha256,
pair_paths_sha256, overrides_sha256 }` (plus `dirty: true`, only when
`pipeline/` has uncommitted changes); `audit` prints it. `pipeline_tree` is the
tree hash of `pipeline/` at HEAD (`CRFM_PIPELINE_TREE` overrides it), so it
changes only when pipeline code does: a docs-only commit leaves every pack
byte unchanged and the rebuild still `cmp`s against `web/public/assets`.
The hashes are SHA-256 of the input files as read (`pair_paths_sha256`: the
`ATLAS_PAIR_PATHS` files concatenated in priority order); `null` when an input
is absent. The client ignores it. Two clean rebuilds give a byte-identical
`shared`. To
compare two packs use `secdiff --packs <old_dir> <new_dir>`, which ignores
`build`: it takes two directories of `.json.br` (or `.json`) pack files and
prints a Markdown summary (per-file sizes and whether the content changed, the
provenance fields that differ, shared-geometry counts, per-direction flow-row
changes matched by section polyline since ids are renumbered per pack, with the
largest changes, changed per-train paths and schedules). The CI `pack-diff` job
runs it on PRs that change `web/public/assets/atlas-v2-*.json.br` and posts the
result as a PR comment (updated in place; skipped when the pack is unchanged).

**`analyze` crate layout.** `atlas` (builder), `atlaspack` (packer) and
`audit` share the library in `pipeline/analyze/src/`: `inputs` (env-driven
recipe paths, loaded once), `legs` (pair paths, router leg paths, overrides,
leg resolution, `dijkstra_chain`), `osm` (node coordinates, way classes),
`timetable`, `geo`, `polyline`, `names`, `model`, `chains`. Everything China-
or 12306-specific is under `cn/`: the city gazetteer and its corrections
(`cn::gazetteer`), English names (`cn::station_en`), train-class letters
(`cn::classes`) and the dated input file names (`cn::files`). `audit` shares
only parsing and helpers with the build (plus `chains`, as before); it still
recounts independently, in its own copy of the per-edge / per-city train
counting: dropped chains and flow lost, the per-chain dedup recount, the
junction-flag check and the variant-leg tally, and, on the pack, its own
fmt-6 decode with the path / stop / chord / schedule invariants and the
goldens gate. None of that reads the build's final aggregation.

**Verify against the goldens (§7) before trusting any rebuild.** The country outline comes from the
`outline` crate (`pipeline/outline`) → `china-outline.json`. (The old `flowmap` / `flowstations`
binaries no longer exist in this repo.)

### Step 6 — spreadsheets + Chengdu workbook (removed)
The `citypairs` and `chengdu` binaries that produced the city-pair and
Chengdu spreadsheets are not in this repo; this step is history and cannot be
rerun from here.

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

## 5. What is NOT in v3, and where its recipe lives (history: handoff-era)

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

**Since 2026-10-24 the machine-checked baseline is `pipeline/goldens.json`.**
`audit` fails on any `exact` counter that changes or `max` counter that rises.
Rebase deliberately with `audit --update-goldens`. Dropped chains / flow lost
are enforced only in the full audit, not `--pack-only`. Current key values:
- 102 origins (incl. 香港); Chengdu outbound 564 trains / widest 144 /
  564 fully tracked; Chengdu inbound widest 105
- chord-leg rows 1,850 (1,587 inbound-only legs, 263 real geometry gaps;
  the 13,420 router-coordinate rows were fixed by O4)
- 49 trains with non-monotone `sec_cnt` (gated as the `max` counter
  `nonmonotone_sec_cnt_trains`)
- rows with a >35 km jump: 0 inside or outside chord legs (old client
  chainer: 5,804)
- continuity gaps (joins outside chord legs, throats included since O1):
  43 in (3, 6] km and 149 over 6 km (before O1: 64,852 and 391), 103,390
  over 0.1 km (gated as `continuity_gaps_gt100m`). Most of the rest are
  0.1–1 km hops at a stop where the arriving and departing legs' geometry end
  on different station nodes.
- station-level stops (O14): 235,264 `dep_stop_pos` entries; 11,951 dep
  rows have stations without a city call of their own
- known gaps: inbound-only legs stay unresolved; flows still trim 1.3 km
  around stations (paths bridge them with throats, O1; see
  `optimization-progress.md`)

The list below is the **historical** 2026-10-22 origin-environment build. It
matches neither the live pack nor any build reproducible from disk; kept
for provenance only.

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

## 8. Provenance (history: handoff-era)

Built 2026-10-13 → 2026-10-22 (origin main chat + "China rail project"
side chat). Day logs: `docs/session-notes/`. This v3 supersedes the v1
(10.5 MB, 2026-10-21) and v2 (111 → 74.6 MB, 2026-10-22) handoff zips;
packing script: `~/workspace/your_files/build-handoff-v3.sh` (origin
environment). Data sources: OpenStreetMap contributors (ODbL) via
Geofabrik; timetables from live 12306 queries. Distances are computed
from OSM geometry — engineering estimates, not official CR kilometrage.
