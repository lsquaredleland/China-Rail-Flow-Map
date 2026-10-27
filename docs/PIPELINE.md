# Data pipeline: rebuilding the pack

How the data pack in `web/public/assets/` is built from OpenStreetMap and a
timetable, and how to check a rebuild. The maintained parts are **§3 (the
recipe, especially step 5)** and **§7 (the goldens)**. Binaries:
`pipeline/analyze/src/bin/{atlas,atlaspack,audit,chainfill,legclass,osm_export,paths,secdiff}.rs`
plus `analyze-rs` (main), `pipeline/filter` (main, `probe`), `pipeline/router`
(main, `cordcheck`, `splitcheck`) and `pipeline/outline` (main).

Engineering rules:

- **All data-processing code is Rust**: `rustfmt`-formatted, `cargo clippy
  --all-targets` at **zero warnings** (fix properly or annotate with a
  justified `#[allow]`). Python only if essential.
- **Staged rebuilds.** Algorithm changes build into a scratch directory
  first, never over `web/public/assets/`; a new pack lands in its own PR
  after `audit` passes against the goldens (§7) and `secdiff` explains every
  changed flow. Judge rebuilds by **flow identity** (per-origin summaries and
  atomic edge counts); since O17/O18 the build is also byte-reproducible.

---

## 1. What the pipeline produces

The atlas behind the flow map: for each of the 102 origin cities, the
distinct trains/day on every shared track section, outbound and inbound, plus
per-train paths, stops and schedules for the tables and the animation, and the
national files for national mode. A train that re-covers the same track (e.g.
土溪→平昌→达州) counts once in the static flows while the animation shows each
pass, so static < animated there by design (成都 out, 达州 side: static 1,
animated 2). What the web app does with it is in `README.md`.

## 2. Inputs

Tracked in git: the curated `data/*.json` files (stations, gazetteers, English
names, `leg_overrides.json`, `pair_path_fixes.json`, `station_fixes.json`) and
`pipeline/router/recipe.toml`. **Not** tracked: the OpenStreetMap China extract
(`data/osm/`, from Geofabrik, §3 step 1), the timetables (`data/raw/`: the
12306 `stops*.jsonl` / `trains*.jsonl` snapshots and the train export
`train-exports-2026-10-25/`) and everything derived (`data/derived/`, build
directories). Their formats are in `README.md`.

## 3. Recreate everything

Prerequisites: Rust toolchain, Node 22+ (for the web build), `brotli` CLI for packing.
All commands run from the repo root unless stated. Timings are rough, from a
2-vCPU Linux VM.

### Step 1 — rail geometry (the base layer)
```bash
curl -O https://download.geofabrik.de/asia/china-latest.osm.pbf
cd pipeline/filter && cargo run --release -- ../../china-latest.osm.pbf ../../data/osm/china-rail.osm
#   → china-rail.osm (513 MB; 3,068,371 nodes, 499,557 ways)   [~156 s]
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
strip 12306's space-typeset names) are handled in `osm_export.rs`.

### Step 5 — the flow-atlas dataset (what the live artifact serves)
**Since 2026-10-22 the live atlas is the corridor-v3 build** (owner's
go-ahead; `docs/corridor-v3-report.md`): per-train corridor
routing + double track merged into one corridor. The router's two outputs
live in `data/derived/corridor-v3/` (or regenerate with `pipeline/router`,
~20 s; modules, `--config` TOML thresholds and how to plug in another
schedule or OSM network: `pipeline/router/README.md`). The live pack is built WITH `data/leg_overrides.json` (see "Actual
live recipe" below); an empty-overrides build does not reproduce it. A bare
`atlas` run loads `leg_overrides.json` (§4) by default.
```bash
./target/release/atlas        # → china-flow-atlas-data.json (v1 combined)
./target/release/atlaspack    # → the v2 pack + combined v2:
#   atlas-v2-{shared,out-map,out-tables,in-map,in-tables,schedules}.json(.br)
#   atlas-v2-{out-tables,in-tables}.safetensors(.br)  (the tables as integer columns)
#   atlas-v2-{national,national-trains,national-entries,national-index}.json(.br)
#   china-flow-atlas-data-v2.json(.br)  (original section numbering)
./target/release/audit        # the audit gate — must report:
                              # dropped chains 0, flow lost 0
```

**Asset swap (deploying a rebuilt pack).** `web/public/assets/` carries only
the `.json.br` files the web app fetches: `atlas-v2-{shared,out-map,out-tables,in-map,in-tables,schedules}.json.br`,
the national files `atlas-v2-{national,national-trains,national-entries}.json.br`
(fetched only in national mode; shipped since 2026-10-25) and
`china-outline.json.br`, plus `atlas-v2-{out-tables,in-tables}.safetensors.br`. Copy just those.
The client loads the tables from the `.safetensors.br` twins (integer columns,
`docs/PACK_FORMAT.md`); the two `*-tables.json.br` stay in the
directory for `audit`, the tests and the tools, and `bundle.mjs` leaves them
out of `dist/`. `audit` fails a pack whose `.safetensors` does not decode to its JSON. The combined `atlas-v2-{out,in}.json.br`
and the plain `.json` copies (`atlas-v2-schedules.json`, `china-outline.json`)
are not fetched by the app (it loads `<url>.br`, with a plain `.json` fallback
that is not deployed) and only add to the deploy size.
Format (fmt 6, current pack of 2026-10-26, 11,248 trains): shared + per-direction map/tables
files (`atlas-v2-{shared,out-map,out-tables,in-map,in-tables}.json(.br)`) plus the schedules and
national files above, array rows, integer-minute times, geometry at 1e4. The out-map carries
102 origin cities; the busiest is 广州 with 1,498 outbound trains/day, and the smallest in the
file are 宜昌 174, 香港 110 and 拉萨 12. (The earlier 12306-era pack was a strict top-100 cut,
#1 广州 1,201/day … #100 麻城 137/day.)
- **Infrastructure (`atlas-v2-shared.json`)**: `sections` (4,519 HSR / 4,587 conv, current pack; 12306-era: 4,274 / 3,257) and `in_sections` (4,495 HSR / 4,560 conv; 12306-era: 4,146 / 3,116) carry `h: 1` when OSM ways have `highspeed=yes` or `maxspeed >= 200` km/h.
- **8-Class Flow Breakdown (`out-map` / `in-map`)**: `flows` and `in_flows` rows pack `[sec_idx, total, g, d, c, s, z, t, k, plain]` (trailing zero counts stripped).
- **National table (`atlas-v2-national.json`, P3.1; shipped since 2026-10-25)**: `{fmt, trains, total, by_class}`, arrays parallel to `sections`: distinct trains/day per section, every train counted once nationally, split into the same 8 classes. Format and rule: `atlaspack.rs` header and `docs/history/DECKGL_MIGRATION.md` (P3.1 as built).
- **Per-Train Section Indices (`out-tables` / `in-tables`)**: packs ordered section index lists (`dep_secs` / `arr_secs`) and per-call section cutoff counts (`sec_cnt`), allowing the client to highlight exact city-pair train corridors at 100% opacity over ~18% ghosted trunks.
**Actual live recipe (verified 2026-10-25: the train-export pack).** The
committed pack is built from the train export (`data/raw/train-exports-2026-10-25`,
see "Train export" below) with PR #55's atlas and router fixes, and
WITH `data/leg_overrides.json` (44 variant legs). Build it from a clean
export of the committed tree (`git archive HEAD | tar -x` into a scratch dir,
then `cargo build --release` there), so `shared.build.pipeline_tree` is the
committed `pipeline/` tree and there is no `dirty` key; outside a git checkout
pass `CRFM_PIPELINE_TREE=$(git rev-parse HEAD:pipeline)`. Make every
`pipeline/` commit (goldens included) before the build that ships, because
any of them changes the tree hash. Rebuild staged:
```bash
# staging/ is a local, git-ignored scratch area. env.sh exports CRFM_DATA_DIR and
# CRFM_OUTPUT_DIR (a copy of data/ and of the GTFS output, staging/inputs/{data,output}),
# ATLAS_OVERRIDES=staging/inputs/data/leg_overrides.json, ATLAS_PAIR_PATHS, ATLAS_LEG_PATHS
source ../staging/env.sh
X=$PWD/../data/raw/train-exports-2026-10-25
export CRFM_SCHEDULE=$X/trains-all.json
export CRFM_SCHEDULE_SUPPLEMENTS=$X/train-operating-days.json
# Router inputs (since O17, 2026-10-24): one full, deterministic corridor-router
# run; no splice. recipe.toml selects `[schedule] source = "export"` (paths
# relative to --files). ~25 s; byte-identical run to run and across --threads,
# apart from timings in summary.json:
R=$PWD/../staging/swap-11k/run1/router
../pipeline/target/release/corridor-router --data ../data --files $X --out $R \
    --station-fixes ../data/station_fixes.json --config ../pipeline/router/recipe.toml
# recipe.toml sets the canonical pair geometry to `[canon] mode = "hybrid"`
# (production's path unless the pair's timetable favours another one; the
# rule and its margins are in pipeline/router/README.md, PR #23) and
# `[model] inner_reversal_penalty = 2.0` (PR #55).
# The 12306 pack (the committed pack until 2026-10-25): a copy of recipe.toml
# with `[schedule] source = "timetables"` (drop `export` / `supplements`),
# `--files ../staging/inputs/output`, and CRFM_SCHEDULE /
# CRFM_SCHEDULE_SUPPLEMENTS unset; its goldens are
# pipeline/goldens-12306fix.proposed.json.
# pair_path_fixes.json goes FIRST (first record per pair wins): pairs whose
# station snapped to a homonym (禹州, 郏县; 恩平/江门–阳江, which the router
# leaves bridged). Regenerate with scripts/o9_fix_paths.py (header has the
# inputs). 聊城西–菏泽东 stays a chord (京港高速线 is unjoined at 菏泽东 in OSM;
# owner: no synthetic connector). The pre-O17 corridor-v3-o9/ splice
# (scripts/o9_splice_router.py, removed in PR #15; in git history) is retired.
export ATLAS_LEG_PATHS=$R/leg_paths.json
export ATLAS_PAIR_PATHS=$PWD/../data/pair_path_fixes.json,$R/pair_paths_canonical.json
O=$PWD/../staging/swap-11k/run1
ATLAS_OUT=$O/china-flow-atlas-data.json ./target/release/atlas
./target/release/atlaspack --in $O/china-flow-atlas-data.json --out-dir $O
AUDIT_PACK_DIR=$O ./target/release/audit          # full audit + pack gates + goldens
# audit reads <name>.json.br when present, else <name>.json, so this audits the
# committed pack too (what the CI `pack-audit` job does):
#   AUDIT_PACK_DIR=../web/public/assets ./target/release/audit --pack-only --goldens goldens.json
# --pack-only cannot gate dropped_chains / flow_lost: they need the OSM extract
# (a dropped chain never reaches the pack), so only the full run enforces them.
./target/release/secdiff --old ../staging/swap-11k/run2/china-flow-atlas-data.json \
    --new $O/china-flow-atlas-data.json --edges   # must report 0 changed edges
./target/release/secdiff --old ... --new ... --classes   # per-edge class columns (8 classes)
# router, atlas and atlaspack are deterministic: identical inputs give a
# byte-identical pack (O17, O18), so `cmp` the .br files against web/public/assets.
```
The `--old` baseline is the build behind the committed pack (its `.br` files
are byte-identical to `web/public/assets`). Always set `CRFM_OUTPUT_DIR` /
`ATLAS_OUT` / `--out-dir` so a build never overwrites `output/` or
`web/public/assets`.

**Train export (the committed pack since 2026-10-25).** The owner's merged
export (`trains-all.json`, 11,589 trains, window 2026-10-23 → 2026-11-06)
feeds the same recipe through a second schedule source. The 12306
deliverables are still the code default (`Config::default()`, CRFM_SCHEDULE
unset), and a timetables build is unchanged byte for byte.
- **Router:** `[schedule] source = "export"` in the `--config` file, with
  `export = "trains-all.json"` and
  `supplements = ["train-operating-days.json"]`, relative to `--files` (the
  export's directory). `recipe.toml` selects it (the 12306 recipe: above).
  Implementation: `pipeline/router/src/export.rs` (`TrainExport`, a
  `ScheduleSource`).
- **Atlas / audit:** `CRFM_SCHEDULE=<dir>/trains-all.json` and
  `CRFM_SCHEDULE_SUPPLEMENTS=<dir>/train-operating-days.json`
  (`pipeline/analyze/src/export.rs`). The export's own stop lists become the
  schedules, so `data/raw/stops*.jsonl` is not read. GTFS stop points
  (`CRFM_OUTPUT_DIR`) and `osm_stations.json` still place the stations.
- **Rules (the same in both crates):**
  - A stop list whose names are all empty is a placeholder. In this export,
    the 4,303 `discovered` / `phase2-discovery` trains carry only
    placeholders. They are filled by `train_no` from the supplement
    (`train-operating-days.json`), which holds those trains' czxx stop lists
    with the same stop count.
  - A train is kept when it has a stop list and runs on at least one date
    of its `run_dates`. This is the window's union, with each `train_no`
    counted once: 11,540 trains. Left out: 33 with no stop list and 16
    with stops but no run date.
- **Calendar in the pack:** only when `CRFM_SCHEDULE` is set. Shared then
  gains `calendar` (the window's dates), and every `train_table` row gains
  `days` (one '0'/'1' per date), `pattern` and `suspended: true` (listed
  suspended). `shared.build` gains `schedule_sha256`.
- **Train identity:** train_table rows are keyed by train (an index into the
  timetable), not by `(code, class)`. The export has 79 codes shared by two
  or more `train_no`s, which are date variants of one service.
- **Goldens:** `pipeline/goldens.json` is the export pack's baseline since
  the swap (regenerated with `audit --update-goldens` from the shipped
  build). The 12306 pack's baseline is kept as a reference in
  `pipeline/goldens-12306fix.proposed.json` (not gated in CI).

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

Decoded per-row fields (what `web/src/lib/decode.ts` `expandOutColumns` / `expandInColumns`
rebuild, and what `audit` expands to):
- `dep_secs` / `arr_secs` are in **travel order**; an entry `~s` (= `-(s+1)`)
  means section `s` is travelled against its stored point order. A train
  that runs back over track it already used repeats those sections; only
  back-to-back duplicates collapse (of the same signed section, also across
  throats in between). A leg that runs back over only part of a section the
  row also runs whole (a reversal at a station, a turn-back onto a branch)
  draws that stretch as a piece (an entry `>= n`, interned like a throat)
  instead of the whole section again, so the path stays continuous; the
  row's set of flow sections is unchanged. Flow counting still dedupes per
  train. Entries `>= n` are throats and such pieces (above).
- Sections are chains of edges with equal per-city counts. At a junction
  (3+ edges) a chain also needs both edges to carry the same trains, so two
  branches that only happen to carry equal counts are separate sections
  (`chains.rs`). Chains are also cut where a row's walk leaves or joins
  equal-count track mid-way (it stops, turns back, or turns off while the
  track goes on: a reversal at a station or a junction), so rows run whole
  sections (`atlas.rs` `chain_cuts`).
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

## 4. The corridor-routing fix (leg overrides)

**Status: applied.** The live pack is built with `data/leg_overrides.json`
(§3 step 5). The 2026-10-22 decision recorded at the end of this section was
reversed once the geometry gaps it names were filled (O5/O9, PR #7).

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
rule + G2450 hand-adjudicated — `docs/MANUAL_OVERRIDES.md`).
Largest: 唐山→秦皇岛 28 G + 24 back (Tianjin–Qinhuangdao HSR, 37–42 min,
drawn on the conventional line, floor 103); 合肥↔芜湖 27; 西宁↔兰州 26.
Chengdu–Chongqing: D951/D2208/D5128 + five westbound north;
G2445/G2446/G2447/G2450 via Chongqing West; D846/D862 (+D848/D864 back)
south loop. Control run (empty overrides) is **flow-identical** to
shipped — zero changed atomic edges, all 100 origins, both directions.

**Decision of 2026-10-22 (since reversed): do not apply yet.** From the
before/after previews, v2 looked less viable: the
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

## 5. Open work

- Pipeline backlog: O2 (triage the continuity gaps over 6 km), O3 (chord legs
  at a path end), O7 (inbound loop trains with non-monotone `sec_cnt`) and
  O19 (the 0.1–1 km joins at stops), in `docs/history/optimization-progress.md`.
- Moving the remaining data facts out of the client (pack manifest, ferry
  flag, class table, section lengths, boarding days): `docs/THIN_CLIENT.md`
  §4, tasks T1–T4.
- Done since the first version of this list: the inbound leg-resolution
  defect (O5, PR #7), the performance pass (the deck.gl renderer,
  `docs/history/DECKGL_MIGRATION.md`) and per-train operating days (the
  train export's calendar, §3 step 5).

## 6. Reference numbers

Renumbering is endemic — 31.1% of trunk services
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
are enforced only in the full audit, not `--pack-only`. Current key values
(the 11k train-export pack, since 2026-10-25; the 12306 pack's are in
`pipeline/goldens-12306fix.proposed.json`):
- 102 origins (incl. 香港); 11,248 national trains over 9,106 sections
  (in_sections 9,055); Chengdu outbound 801 trains / widest 176 / 801
  fully tracked; Chengdu inbound 784 / widest 148
- chord-leg rows 46 (`max`; unmatched Laos / 阿瓦提 stations and new chord legs)
- 76 trains with non-monotone `sec_cnt` (gated as the `max` counter
  `nonmonotone_sec_cnt_trains`)
- rows with a >35 km jump: 0 inside or outside chord legs (old client
  chainer: 5,804); 0 over 20 km since PR #55
- continuity gaps (joins outside chord legs, throats included since O1):
  44 in (3, 6] km and 0 over 6 km, 85,765 over 0.1 km (gated as
  `continuity_gaps_gt100m`). Most of the rest are 0.1–1 km hops at a stop
  where the arriving and departing legs' geometry end on different station
  nodes.
- station-level stops (O14): 267,428 `dep_stop_pos` entries; 14,570 dep
  rows have stations without a city call of their own
- known gaps: inbound-only legs stay unresolved; flows still trim 1.3 km
  around stations (paths bridge them with throats, O1; see
  `docs/history/optimization-progress.md`)

## 8. Data sources

Track geometry: OpenStreetMap contributors (ODbL), via Geofabrik. Timetables:
point-in-time 12306 snapshots and the 2026-10-25 train export (`README.md`).
Distances are computed from OSM geometry: engineering estimates, not official
China Railway kilometrage.
