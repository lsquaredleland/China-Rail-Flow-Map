# Optimization progress log

Companion to `optimization.md` (the plan; phase and bug IDs refer to it). Update this file at the end of every work session.

## How to resume
1. `cd /Users/leland/Downloads/china-rail-animation && git status --short --branch`: must be `explore/24h-train-flow-animation`.
2. Read the **Status** table and the newest **Session** entry below.
3. Continue with the first phase not marked done. Never write into `/Users/leland/Downloads/china-rail-handoff-v3`.

## Status (end of session 1, 2026-10-24)

| Phase | State | Notes |
|---|---|---|
| 0. Client fixes on current data | done; owner browser check OK | |
| 1. Ordered, oriented paths (pipeline) | done in staging; full audit + goldens PASS; 0 changed edges vs live | retrace fix in; >35 km jumps outside chord legs = 0 (live old chainer: 5,804 rows) |
| 2. Generated schedules (pipeline) | done in staging; schedules audit PASS | indexed by `t`; client switched |
| Goldens gate | `pipeline/goldens.json` + `audit` gate (exact / max counters, `--update-goldens`) | dropped chains / flow lost gated only in full audit, not `--pack-only` |
| 3. Throat stubs | backlog O1 | |
| 4. Client on new data | done (4.1–4.6, virtual crow-flies spans for chord legs); owner browser check OK | live assets swapped |
| 5. Path dedupe | backlog O6 | |

## Session 1 outcome (committed 2026-10-24)
- Phases 0, 1, 2, 4.1–4.5, goldens gate, staged pack swapped into `web/public/assets/` (owner verified in browser: equivalent to pre-port). At commit: typecheck, build and `node staging/scripts/check_client_decode.mjs` pass.
- **Finished after the usage-limit interruption:** (a) Phase 4.6 cleanup sweep: done (unused locals, 6 `as any` removed). (b) `docs/PIPELINE.md`: done (§3 step 5 live recipe + fmt-3 format; §7 now points to `pipeline/goldens.json`).

## Backlog: optional improvements (not started)
| # | Item | Changes flows? | Notes |
|---|---|---|---|
| O1 | Phase 3 station-throat stubs | no | removes the 61,807 gaps of ≤6 km at stations (trains hop a few km at stations today); ~728 distinct joins, ~2k points, ~62k path refs; then tighten the continuity gate |
| O2 | Triage the 417 continuity gaps over 6 km | no | 69 orientation-fixable, rest unexplained (e.g. K237 69.7 km); scripts in `staging/scripts/` |
| O3 | Chord legs at a path end | no | no virtual span there, so the dot waits, then appears; use the stop/city point as the far end |
| O4 | ✅ DONE (PR #2, merged 2026-10-24): fix router `#cv3` node coordinates in `atlas.rs` | **yes**: owner approval + staged diff | 13,420 chord rows / 223 legs (e.g. K118 成都西→广元) |
| O5 | Resolve inbound-only legs | **yes**: owner approval | 1,587 chord rows / 304 legs; after O4+O5 only ~5 real gap legs remain |
| O6 | Phase 5 per-train path dedupe | no | 29,871 rows for ~7,253 trains; measure the brotli saving first |
| O7 | 48 inbound loop trains with non-monotone `sec_cnt` | no | documented quirk (cutoff clamps to 0); decide whether to fix |
| O8 | Gate `dropped chains` / `flow lost` in `--pack-only` audits too | no | currently only the full audit enforces them |
| O9 | Fill real OSM geometry gaps (平昌→达州, 南京→扬州, …) | yes | data work, prerequisite noted in PIPELINE.md §4 |
| O10 | Move the client city-coordinate patches (lib.ts `prepAtlas`: 铜仁, 兰溪, 溆浦) into the pipeline gazetteer | no flows; dest points + `distKm` change | from the PR #1 review (B); the pipeline should be the source of truth |
| O11 | ~~U-turn overlap fix~~ | — | **Won't do** (owner 2026-10-24): a train reversing over track at a station is acceptable behaviour |
| O12 | CI pack audit: run `audit --pack-only` on committed `web/public/assets` against `pipeline/goldens.json`; PR job diffs the PR's pack vs main's at edge level (like `secdiff`) and posts a summary comment | no | CI can't rebuild (needs 513 MB OSM + handoff inputs), so audit the committed pack; catches bad asset swaps and surfaces flow changes like O4 at review time |
| O13 | Client regression tests (`bun test` in `web/tests/`): promote `staging/scripts/check_client_decode.mjs` + `check_filter_animation.mjs`; invariants on real assets (trainDistAt monotone, dwell == stop.dist, final-step flows == static flows with/without filters, animated trains ⊆ filter, 0 jumps outside chord legs) + snapshot tests (per-hour departed/arrived, per-section flow at fixed times for 2–3 origins) | no | wire into CI's web job |
| O14 | ✅ DONE (PR #5, open): dwell at every station, not just one per city (G3764: 重庆东 → 江北机场 → 重庆北) | no | `dep_stop_pos` (fmt 4) + client dwells from the schedule; see #### O14 |

Rule for every item: staged rebuild → `audit` (goldens must pass or be deliberately rebased with `--update-goldens`) → `secdiff --edges` vs live → owner approval → swap.

## Decisions made
- Keep building WITH `data/leg_overrides.json` (reproduces live; `[]` differs by 93,072 edges).
- 香港 is origin 102.
- Chord legs (15,270 rows) are pre-existing (0 / 59,765 rows differ from live), not a regression.

## Sessions

### Session 1 (2026-10-23)
- Plan written (`optimization.md`), reviewed against `optimizations-gemini.md` (see the plan's notes in 1.2, 1.3, 4.2).
- Started Phase 0 and Phases 1–2 in parallel with subagents. Results are appended below by each agent.

#### Phase 0 result (client-phase0)
Files changed (all under `web/src/`):
- `lib.ts`: `buildDayTimeline` is outbound-only (no `dir` param, "in" branches deleted); no longer writes `train.secs/secStarts/secRevs/totalDist`; `inTimeline` getter removed and no longer copied in `filterOriginByClasses`; B4 stopgap (largest route position among raw `secs[0..secCnt)`); unused `Direction` import dropped.
- `types.ts`: removed `rawSecs?/secStarts?/secRevs?/totalDist?` from `DepVM`, `secStarts?/secRevs?/totalDist?` from `ArrVM`, `inTimeline?` from `OriginVM`.
- `components/MapCanvas.tsx`: `activeTimeline()` helper replaces all direction ternaries; `getActiveDestSectionCounts` and the isolation highlight read `getPrepTrain(code)` (per-selection cache for the former); `selCache` (cur, panelDest, iso, dir -> allowedCodes + cityIdx->sorted times) used by `drawStations`/`drawDot` and the other `getAllowedTrainCodes()` callers; `getAnimState` counts via `getPrepTrain`.
- `App.tsx`: inbound reset only in the `useEffect` on `direction` (removed from `setDirection`).
- `components/TrainScheduleModal.tsx`: `"fcIdx" in trainVM` anchor; Isolate, Jump and live-progress controls hidden when `direction === "in"`.

Fixed: B2, B3, B4 (stopgap), B9 (partial: cache only), B10, B11, B12, B13, B14, B15, B21.
Checks: `npm --prefix web run typecheck` pass; `npm --prefix web run build` pass; `curl -sI :8090` 200; no new TODO/stub/`as any`.
Notes: inbound city pulse times now use only the board-time fallback (no inbound prep stops); `getAnimState` yields no filtered counts without a timeline; `getDestSectionCounts` inbound branch untouched.
Browser checks still needed (plan section 10, Phase 0): B2/B3 counts identical before and after first `cur.timeline` access; switching to inbound never builds an inbound timeline; class-filter change in outbound doesn't build it; `drawStations` frame time with a city selected; isolate a train and check highlight and city-pair corridor still render.

#### Phase 1–2 result (pipeline-phase12)
Files changed (nothing committed; no `web/`, `docs/`, `output/` or live-asset writes):
- `pipeline/analyze/src/bin/atlas.rs`: per-leg `leg_fwd`/`leg_stop` on dep/arr rows; legs oriented key.0→key.1 from coordinates (`orient_leg`, greedy over segments, both ends) with a hard assert that base pair paths are key-ordered; directed `edge_dir_to_sec` / `in_edge_dir_to_sec` built inside the section loops; `dep_secs`/`arr_secs` in travel order, `!sec` = reversed; inbound `sec_cnt` = trailing count; per-train `dep_chord_legs`/`arr_chord_legs` `[stop, s0, s1]`; `schedules` (indexed by `t`) from `data/raw/stops.jsonl` + `stops_cs.jsonl`, names `clean()`ed, `legKm` from `leg_km`.
- `pipeline/analyze/src/bin/atlaspack.rs`: header documents the encoding; passes chord legs through; `"fmt": 3` on out-/in-tables; writes `atlas-v2-schedules.json` (`extra_stations: []`).
- `pipeline/analyze/src/bin/audit.rs`: `AUDIT_PACK_DIR=<pack> audit [--pack-only]` gates: fmt, path continuity outside chord legs (count + worst 20, throat tier), sec_cnt monotone, schedule coverage/consistency.
- `.gitignore`: `staging/`.

Rerun (from `pipeline/`, after `cargo build --release`; 0 warnings workspace-wide):
```bash
source ../staging/env.sh     # CRFM_DATA_DIR/CRFM_OUTPUT_DIR -> staging/inputs, ATLAS_PAIR_PATHS=canonical,
                             # ATLAS_LEG_PATHS=leg_paths, ATLAS_OVERRIDES=staging/inputs/data/leg_overrides.json
O=$PWD/../staging/corridor-v3-ordered
ATLAS_OUT=$O/china-flow-atlas-data.json ./target/release/atlas      # ~75 s
./target/release/atlaspack --in $O/china-flow-atlas-data.json --out-dir $O
AUDIT_PACK_DIR=$O ./target/release/audit                            # add --pack-only to skip the legacy part
./target/release/secdiff --old ../staging/live-v1/china-flow-atlas-data.json --new $O/china-flow-atlas-data.json --edges
```
Staged inputs (APFS clones `cp -c`, read-only from the handoff; H=`/Users/leland/Downloads/china-rail-handoff-v3`):
- `H/data/osm/china-rail.osm` → `staging/inputs/data/osm/`
- `H/data/derived/corridor-v3/{pair_paths_canonical,leg_paths}.json` → `staging/inputs/data/derived/corridor-v3/`
- `H/data/derived/pair_paths.json`, `H/data/derived/cs_out/pair_paths.json` → `staging/inputs/data/derived/` (only used if `ATLAS_PAIR_PATHS` is unset; a test run showed the result is identical)
- `H/output/china-rail-timetables-2026-10-21.json`, `H/output/china-rail-intercity-2026-10-28.json`, `H/output/gtfs-2026-10-21/stops.txt` → `staging/inputs/output/`
- `H/output/china-flow-atlas-data.json` → `staging/live-v1/` (live v1 reference for secdiff)
- From this repo (byte-identical to H/data): `data/{city_en,osm_stations,leg_overrides}.json`, `data/raw/{stops,stops_cs}.jsonl` → `staging/inputs/data/`
Always set `CRFM_OUTPUT_DIR`/`ATLAS_OUT`/`--out-dir`: this repo's `output/` is a symlink into `china-rail-handoff-v3/output`. Inputs in `staging/inputs/` are APFS clones of the handoff files.

Results:
- Direction assertion: PASS. Pair paths 5,987 key-ordered, 0 reversed (16 unchecked: homonym station points, e.g. 先锋); router legs 1,610 as stored (27 unchecked); via-variant legs 13 as stored, 32 mixed (stitched sub-pairs), normalized by the walk.
- Flows: `secdiff --edges` vs live = 0 changed edges; per-train section sets identical to an unmodified-code control run (`staging/control-unmodified-code/`). Indices are not byte-identical to live because atlas iterates HashMaps (section order and chain direction change every run, flows don't), so the staged tables only work with the staged shared/map files. Ship the whole pack.
- Legacy audit: dropped chains 0, flow lost 0.
- Chord legs: 15,270 on 10,717 train rows (out 6,879, in 8,391).
- Continuity: 63,418 gaps > 3 km in 3.15 M joins. 62,290 are ≤ 6 km (station-throat trims, B8 → Phase 3); 1,128 are > 6 km (worst 117 km, Z332/K502). Gate FAIL against the plan's 3 km target.
- sec_cnt: 48 trains non-monotone (probably the documented loop trains); 0 cutoffs beyond the path.
- Schedules: 7,157 trains (all train_table rows), 0 missing, 0 inconsistent with dep/arr rows, `extra_stations` 0 (3 stations appended to station_table: 新龙, 大洋, 乌海南). Compared with the hand-committed file: 68 trains have different day offsets (the old file is wrong, e.g. K535 益阳 06:25 marked day 0), and `legKm` now matches the `km` column.
- Goldens: staged = live (Chengdu 564/610/widest 144/fully 564/0 chords; in 558/627/widest 105; CD↔CQ 136 (53 term) / 136 (54 orig), 62 min; 广州 21 6:54, 上海 17 10:06, 北京 13 7:30, 香港 1 8:18, 拉萨 1 34:38). These are NOT the §7 values (145 / 561 / 4 chords / 108): §7 is stale relative to the live pack.

Open issues:
1. The live pack was built WITH `data/leg_overrides.json` (44 variant legs), not the `[]` that PIPELINE.md §3 step 5 prescribes; the staged build reproduces live only that way. Owner decision needed.
2. Staged output has 102 origins (adds 香港); live has 101. Current code adds HK, so the live pack predates it.
3. Pre-existing atlas bug: the coordinates parse (`needed`) only covers pair-path nodes, so router-only (`#cv3`) nodes have no coordinates. Those stretches carry no flow and become chord legs (e.g. K118 成都西→广元). Fixing it changes flows, so it needs its own staged change and approval.
4. Inbound-only legs stay unresolved (known deferred behaviour), which inflates inbound chord legs.
5. Continuity: Phase 3 throat stubs needed; the > 6 km class (1,128) and 538 orientation-fixable gaps need a look. Suggested §7 goldens once accepted: chord legs 15,270; continuity > 6 km: 1,128.
6. `docs/PIPELINE.md` not edited (out of scope): §3 step 5 env, §7 goldens, `audit` pack-gate usage.

Client implications (Phase 4):
- Refuse tables without `fmt === 3`. Decode with `s < 0 ? (~s, reversed) : (s, forward)`; the path is in travel order, so delete the chainer.
- Outbound: `secs.slice(0, secCnt)`. Inbound: `secs.slice(len - secCnt)` (travel order now, not arrival-first).
- Chord legs: `[stop, s0, s1]` (stop indexes the schedule); render spans `s0..s1` as chords.
- Schedules: `schedules` is now an ARRAY indexed by `t`. `DepVM`/`ArrVM` need `t` (decoded at `lib.ts:544` / `681` but not kept); `formatScheduleStops` and `TrainScheduleModal` must take `t` instead of `code`; `SchedulesData.schedules` type becomes `[number, number, number, number, number][][]`; `legKm` -1 = unknown (none at present); `App.tsx` loader unchanged (same URL).

#### Phase 4a result (client-phase0)
**The client now REQUIRES the staged fmt-3 pack.** `web/public/assets` must be swapped together with this code (owner approval). The current branch built against the old assets shows the fmt error overlay.
- `types.ts`: `ChordLeg`; `fmt` on tables types; `DepVM`/`ArrVM` gain `t`, `secRevs`, `chordLegs`; `SchedulesData.schedules` is an array indexed by `t`.
- `lib.ts`: `decodeSecs` (`~s` = reversed) at load; chainer deleted (PrepTrain secs/secRevs straight from the data); `stop.dist = secStarts[secCnt]` (or `totalDist`), vertex snapping removed; B4 stopgap replaced by `secStarts[secCnt]`; `formatScheduleStops` takes `t`.
- `App.tsx`: `requireFmt3` (console.error, `loadError`); tables fetch failures now set `loadError`. `MapCanvas.tsx` overlay shows `loadError` even when the map has painted. `TrainScheduleModal.tsx` takes `trainT`.
- Inbound slicing: `getDestSectionCounts` already used `slice(len - secCnt)`; no change needed.
- Chord legs only parsed/stored; no rendering change. 4.3/4.4/4.5 untouched.
Checks: typecheck pass, build pass. Staged pack copied over `web/dist/assets/` only (`curl :8090` 200, serves fmt 3). `staging/scripts/check_client_decode.mjs`: K678 (广州) max consecutive-section gap 5.09 km, D1804 (成都) 3.19 km, outside chord legs (throat trims, B8).
Browser checks pending: no teleports for K678/D1804, dwell at stations, inbound view and schedule modal (names/times) on the staged pack.

#### Investigation (pipeline-phase12)
Read-only, nothing that changes flows. Scripts are in `staging/scripts/` (run from that directory with `python3 <script> <pack dir>`): `jumps.py` (Q2), `gaps.py` (Q3, output in `gaps-result.txt`), `monotone.py` (Q4), `goldens.py`, `packlib.py`. `atlasdiag/` is a separate cargo crate: a copy of `atlas.rs` with a per-leg dump (`ATLAS_DIAG=<jsonl>`, `DIAG_TRAIN`/`DIAG_ORIGIN`), output in `diag/legs.jsonl`. `staging/live-pack/` holds the decompressed `web/public/assets` packs.

1. **Chord legs (15,270) are pre-existing, now counted.** By cause (out / in rows; distinct legs):
   (a) no pair path: 0 / 0. (b) all edges trimmed by near_station: not counted as chords (non-chord zero-section legs: 844 / 350). (c) all sections already seen: not chords (38 / 84). (d) router `#cv3` nodes without coordinates: **6,744 / 6,676 (223 legs)**. (e) inbound-only unresolved: 0 / 1,587 (304 legs). (f) real segment gap (pair status bridged ×4, via_chain ×1): 135 / 128 (5 legs).
   Per-train section sets are identical to the unmodified-code control (0 of 59,765 rows differ), and the control equals live at edge level (secdiff `--edges` 0). So these legs carry the same (missing) sections in live; only the label is new. Proposal: keep the current definition (unresolved, or a hole/gap > 3 km), because (b)/(c) are already excluded. Fix (d) by adding LEG_PATHS nodes to atlas `needed`, and (e) by resolving inbound-only legs. Both add flow that is missing today, so they need a staged change and owner approval. After them, chords would be about 5 legs / 263 rows.
2. **>35 km jumps, outbound dep rows:** live pack with the HEAD client chainer: **5,804 / 29,870 (19.4%)**. Staged pipeline order: **1,222 (4.1%)**, of which **1,209 only inside chord legs** and **13 outside**.
3. **Continuity.** ≤ 6 km (62,290): all are station throats. 13,163 have both ends within 1.5 km of a station point, 49,001 have a station within 1.5 km of the gap midpoint (pass-through), 126 within 3 km. > 6 km (1,128): 642 are retraces (the train re-runs track it already used, e.g. Z332 石门县北→宜昌东→石门县北; `seen_s` keeps only the first pass), 27 are adjacent to a chord leg, 69 orientation-fixable, and 390 other. Of those 390, 361 have both ends near stations (e.g. K237 69.7 km, G1892 33 km, K1067 26 km); not yet explained per leg.
   Proposed fix: (i) dedupe only for flows and allow repeat visits in the path (stops the retraces; flows unaffected, sec_cnt values shift); (ii) Phase 3 throat stubs, about 728 distinct section-to-section joins (2–3 points each, so about 2k points) and 62,290 path refs. A cheaper alternative is a gate rule exempting gaps ≤ 6 km with a station within 1.5 km of the gap; the client then interpolates.
4. **48 non-monotone sec_cnt:** all inbound loop trains (e.g. G3193 into 郑州, boarding at 新郑机场). The source boards after the arr row's arrival (cd_in, the first home-city stop), so `leg_start` clamps to cd_in and sec_cnt becomes 0. This is the documented loop-train quirk and pre-existing semantics, not an ordering bug.
5. **Goldens / overrides.** handoff-v3 `output/` and `web/public/assets` are the same build: the 5 split packs are byte-identical, and handoff has no schedules file. Live = current code + `leg_overrides.json` (44 variant legs) − 香港 (101 origins). The `[]` build (`staging/corridor-v3-ordered-nooverrides/`) differs from live by 93,072 edges, but its Chengdu goldens equal live's: 564 / 610 / widest 144 / fully 564 / 0 chords; in 558 / 627 / widest 105; CD↔CQ 136 (53) / 136 (54), 62 min; 广州 21 6:54, 上海 17 10:06, 北京 13 7:30, 香港 1 8:18, 拉萨 1 34:38. §7's 145 / 561 / 4 chords / 108 match **neither**. §7 describes the 2026-10-22 origin-environment build (memory: `project/harvest` inputs, no longer on disk), which can't be rebuilt from handoff-v3. Owner decision: keep overrides (= live) or `[]` (= the documented recipe). Both staged builds have 香港 as origin 102.
6. **Regression baseline proposal:** a committed `pipeline/goldens.json` per build config. `audit` compares each counter and fails on any increase, unless it runs with `--update-goldens` (a deliberate, reviewed diff). Current values (overrides build):
   `origins 102; sections 8054/7923; chord_rows {d:13420, e:1587, f:263}; chord_legs_distinct {d:223, e:304, f:5}; continuity {le6:62290, gt6:1128, gt6_retrace:642}; jumps35_outside_chords 13; nonmonotone_sec_cnt 48; orientation {pair_reversed:0, mixed_variant:32}; schedules {missing:0, inconsistent:0, extra_stations:0}; dropped_chains 0; flow_lost 0; chengdu {out:564, dests:610, widest:144, fully:564, chords:0, in:558, srcs:627, widest_in:105, cq_out:136, cq_in:136, cq_fastest:62}`.
   `[]` build: chord_rows in 8,372, continuity le6 62,203 / gt6 1,075; the rest the same.

#### Regression checks (pipeline-phase12, narrowed scope)
- (1) Chord legs pre-existing: **yes**. Per-train section sets (matched by section geometry) are identical to the live pack and to the unmodified-code control: 0 of 59,765 dep/arr rows differ in either comparison (`staging/scripts/setcmp.py`). The 15,270 chord-leg rows (13,420 router nodes without coordinates, 1,587 inbound-only unresolved, 263 real gaps) carry exactly the sections live already has; only the label is new.
- (2) Outbound dep rows with any >35 km jump: live + HEAD client greedy chainer **5,804 / 29,870 (19.4%)**; staged pipeline order **1,222 (4.1%)**: **1,209 inside chord legs only, 13 outside** (`staging/scripts/jumps.py`).
- (6) Baseline: `staging/goldens-proposal.json`. Counters under `exact` must match; counters under `max` must not rise. Audit would exit 1 otherwise, and the baseline changes only via `audit --update-goldens` (a reviewed diff). Not implemented.

#### Phase 4b result (client-phase0)
- 4.3: calibration block deleted from `buildDayTimeline`; `dest.arrTimes` and `selCache` city times both come from the call times.
- 4.4: `trainDistAt(pt, t)` exported from `lib.ts` (shared `trainState`, used by `getActiveTrains`). `secFlowSteps` entry times come from `timeAtDist` (bisection within the leg). `getActiveDestSectionCounts` caches `(pt, [(sec, routePos)])` per (cur, dest) and calls `trainDistAt` per frame.
- Repeat-safe: each section counts once per train in `secFlowSteps`, `getDestSectionCounts` (both directions), `getActiveDestSectionCounts` and the `filterOrigin` flow tallies.
- 4.5: `PrepTrain.chordSpans` (route span `s0..s1` entries, straight line between its end points); the dot is drawn at 45% alpha with no tail; the tooltip says "No track geometry on this leg". Interpretation of `[stop, s0, s1]` as inclusive path entries is mine: verify against K678 (2 chord legs) in the browser.
- Checks: typecheck pass, build pass (the build re-copies `public/assets` into dist, so the staged pack was copied over `web/dist/assets/` afterwards; `curl :8090` 200, fmt 3). `staging/scripts/check_client_decode.mjs` bundles the real `lib.ts`: K678, G1580, Z384, K230 (广州), D1804, D1995, C760 (成都): `trainDistAt` monotone, equals `stop.dist` during all dwell samples.
- Not done: 4.6 sweep (`secCumLens`/`getSecGeometry` still needed for dot position).

#### Goldens gate + retrace paths (pipeline-phase12)
- `pipeline/goldens.json` (new) holds `exact` counters (origins, sections, in_sections, schedules_trains, Chengdu goldens) and `max` counters (chord_leg_rows, continuity tiers, >35 km jump rows inside/outside chord legs, non-monotone sec_cnt). `audit.rs`: `audit_pack` returns the counters; `gate_goldens` fails on any exact change or max increase and prints "improved" lines when a counter drops. To rebase: `AUDIT_PACK_DIR=<pack> audit [--pack-only] [--goldens <path>] --update-goldens` (the path defaults to `./goldens.json`; run from `pipeline/`). The pack's hard checks (fmt, cutoffs, schedules) still fail the run on their own. dropped chains / flow lost are still only printed by the legacy part, not in goldens. The pre-retrace baseline is kept in `staging/goldens-pre-retrace.json`.
- Retrace fix (`atlas.rs`): the paths drop the `seen_s` first-seen dedupe and collapse only consecutive identical signed entries, so a train that runs back over track lists those sections again. Flows are counted from per-train edge sets, so they are untouched; `sec_cnt` remains a prefix count of the emitted path.
- Rebuilt `staging/corridor-v3-ordered/` (overrides config, 102 origins). Gates: secdiff `--edges` vs live **0**; full audit dropped chains 0 / flow lost 0; hard checks PASS; goldens PASS (then rebased).
- Before → after: continuity > 6 km **1,128 → 417**, ≤ 6 km 62,290 → 61,807; >35 km jump rows outside chord legs **13 → 0**, inside only 1,209 → 1,191; chord-leg rows 15,270 and non-monotone 48 unchanged. `staging/goldens-proposal.json` = the rebased `pipeline/goldens.json`.
- Client note (Phase 4): paths can now contain a section more than once, so build any per-path sets from the `Set` of `|s|`.
- Re-verified 4a/4b on the rebuilt staged pack: max non-chord gap K678 5.09 km, D1804 3.19 km; trainDistAt monotone and equal to stop.dist in dwells on all 7 trains; no code changes.
- chord_legs `[stop, s0, s1]` definition (also in the `atlaspack.rs` header): `stop` = schedule index of the leg's departing stop. s0/s1 are POSITIONS in the emitted dep_secs/arr_secs (not section ids), half-open `[s0, s1)` = the entries the leg itself produced (path length before/after the leg, computed on the retrace-aware path). The gap may be at any join k in `s0..=s1` (join k = between entries k-1 and k), so entries s0-1 and s1 are the neighbours on either side. `s0 == s1` means the leg produced nothing and the gap is the single join s0. NOT "inclusive path entries".
- chord_legs fixed to half-open [s0,s1) (span = exit of entry s0-1 to entry of s1, clamped at path ends; s0==s1 gives a zero-distance span, not drawn). K678 spans end 1.2/10.5/9.7/9.2 km from the nearest station or city centre; typecheck, build and trainDistAt checks pass.
- goldens: `dropped_chains` = 0 and `flow_lost` = 0 are now `exact` counters, gated at the end of a full `audit` run (exit 1 on breach). `--pack-only` skips them and says so. Full audit on the staged pack: hard checks PASS, goldens PASS, exit 0.
- Virtual chord length: each chord leg adds a crow-flies span at its widest join in [s0,s1] (not a section: no flows or counts); `secStarts`/`totalDist`/stop dists shift. K678 steps across chord spans max 1.58 km/min; whole trip max 5.72 km/min (t=543, not on a chord: throat gap + cruise); `trainDistAt` monotone, typecheck and build pass.
- 4.6 sweep: removed 3 unused `cur` locals in MapCanvas and 6 `as any` casts in lib.ts (net -9 lines); no stale chainer/calibration comments, TODOs or debug logs remained; typecheck, build and decode checks pass.

#### Merge with main (merger)
Merged `origin/main` (a783d37: rustfmt/lint, feature 2 histograms + filter pill bar, proportional filtered bands + shift-click hours/trains, 8e9f4ff animation removal) into `explore/24h-train-flow-animation`. The branch's animation is kept; main's deletions of animation code are not taken.

Conflicts and resolution:
- `TimelineScrubber.tsx` (modify/delete): kept the branch file.
- `types.ts`: kept `ActiveTrainVM`, `ScheduleStop`, `SchedulesData`, `PrepTrain*`, `ChordSpan`, `DayTimelineVM`, `OriginVM.timeline`; main's multi-select `OriginFilterCriteria` (hours/distBins/durBins/trainCodes) auto-merged. New: `DayTimelineVM.subset(codes)`.
- `lib.ts`: kept the branch's timeline/decoder block and the `timeline` getter in `buildOrigin` (the auto-merge had turned `const res: OriginVM = {` back into `return {`; restored); main's multi-bin `filterOrigin` taken. Imports: `ActiveTrainVM`/`DayTimelineVM` restored (auto-merge had dropped them), `DistBinFilter` added, unused `Direction` dropped.
- `MapCanvas.tsx`: kept `AnimState`, anim state, `drawTrains`, selection caches and the anim controls. Several 8e9f4ff deletions had auto-merged without conflict and were restored by hand: the `MapApi` anim methods, `drawTrains` call in `draw()`, the api object entries, the rAF cleanup effect and three `notifyAnimListeners()` calls. `drawFlows`/`drawChords` combine both sides (below).
- `App.tsx`: kept the TimelineScrubber/TrainScheduleModal imports and state, the isolation pill, the collapsed-timeline button; added main's `ActiveFilterBar`; `DeparturesTable` gets both prop sets; `onClearFilter` also clears train codes (main). Removed the unused `filterOriginByClasses` import.
- `DeparturesTable.tsx`: both prop sets. `TrainCell` now stops click propagation, so clicking a train number opens the schedule without also toggling main's row train filter.
- Pipeline: auto-merged; `cargo fmt --all` then two clippy fixes in branch code (`audit.rs` `.map(&arr)` → `.map(arr)` ×2; `atlas.rs` schedules loop `for tr in &train_table`). Token-level diff vs the branch: only formatting and those fixes; main's outline match-guard rewrite is equivalent (`_ => {}` fallthrough).
- `bun.lock`, `index.template.html`, `features.md`, `Histograms.tsx`: main's versions (no conflict).

Filter and animation integration:
- Bug fixed: `filterOrigin` copied `timeline: cur.timeline`, so a filtered view animated every train. It now has its own lazy `timeline` getter, cached per filtered VM (one per filter state through App's `useMemo`), built as `cur.timeline.subset(codes of filtered deps)`.
- `buildDayTimeline` records each train's (distinct section, entry minute) once. `assembleTimeline(trains, entries)` builds bar length, `secFlowSteps` (start-step counts plus a prefix sum, same numbers as the old per-step loop), `maxFlowSteps` and the queries. `subset` reruns it on the kept trains without rebuilding geometry. 广州: base build 44 ms; filter + subset 0.7–10.4 ms.
- With a filter: only filtered trains animate. `secFlowSteps` count only those trains, and the final step equals the filtered static flows. Counters and `getPrepTrain` cover only the filtered set. Bar length = the filtered trains' own span; `animTime` is clamped when a filter shortens it. Flows are drawn at the full origin's scale (`baseMaxN`) over the static faded full-origin background, as on main. Chords are faded context, not gated by time. Filtered `dests[].arrTimes` are rebuilt from the filtered calls (they used to be copied unfiltered), so pulses count only filtered trains. Isolation is intersected with the filter (a filtered-out isolated train draws nothing). The city-pair panel already used the filtered `panelCity`.
- No filter: `filterOrigin` returns the origin itself, and `isFilteredView()` is false, so every path is the branch's.

Verification:
- `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build`: pass.
- `node staging/scripts/check_client_decode.mjs`: pass (trainDistAt checks OK).
- `pipeline/`: `cargo fmt --all -- --check` OK, `cargo clippy --workspace --all-targets -- -D warnings` exit 0, `cargo test --workspace` all ok (9 tests).
- New `node staging/scripts/check_filter_animation.mjs` (real `lib.ts`): unfiltered 广州 timeline is identical to the pre-merge branch's (`git show HEAD^1:web/src/lib.ts`; set `BASE_REF` to compare against another ref): every `secFlowSteps`/`maxFlowSteps` array, sampled `getActiveTrains`, the counters, and final step = shipped flows on 4,517/4,517 sections. Filters tested: hours 08–09 + 500–1000 km (22 trains), hours 08–09 (162), class G (452), class K + ≤6 h (16). For each: drawn dots ⊆ filter, every drawable filtered train is drawn, final step = filtered flow n with no extra lit sections, monotone growth, counters, pulse times. Result: OK. Note: `staging/` is gitignored, so this script (like `check_client_decode.mjs`) is not in the commit.

Reviewer, look closely at:
- The bar length now shrinks to the filtered trains' span (e.g. class G 1,435 min vs 4,090). The alternative is to keep the full origin's span.
- Filtered views use the static full-origin scale (`baseMaxN`), not the per-step `maxFlowSteps`, so filtered bands start thin and grow into their final proportional width.
- The isolation pill (top centre) can overlap main's filter bar (top left) on narrow screens.
- Not browser-tested: the new filter/animation interplay and the train-number click vs row-select change.

#### O2/O4 investigation (pipeline-phase12)
Read-only on `pipeline/` (the merge is in progress). Tools: `staging/scripts/atlasdiag/` (HEAD `atlas.rs` copy plus dumps: `ATLAS_DIAG` per-leg causes, `ATLAS_ROWS` per-row leg prefixes, `DIAG_TRAIN`/`DIAG_ORIGIN` edge-level hit/trim/nocoord per leg), `staging/scripts/o2.py` (output in `o2-result.txt`). O4 prototype: `staging/o4-proto/` (separate crate) plus `staging/o4.patch`; build in `staging/o4-build/`.

**O2: the 417 gaps > 6 km** (out / in):
- **Dense-station trims, 225 (123 / 102).** Every point of the gap is within 2 km of a station, so `near_station` (1.3 km around every throat station) removes a whole run of consecutive edges. Example: Changsha S-line 观沙岭/开福寺/谷山, 11.3 km gap at (112.959, 28.232)→(112.845, 28.256) on Z332, K932, S7002… Fix: Phase 3 throat stubs for paths (flows keep trimming).
- **U-turn on one section, 127 (65 / 62).** The path holds S then !S at a leg join. A section is a constant-signature chain and can extend past where the train turns. Cases: (i) the next leg's geometry overlaps a few throat edges of the previous leg's section in reverse (K1160 新沂: the 邳州东–新沂 section is re-emitted reversed at the start of the 临沂东 leg → 25.9 km); (ii) real reversals that use only part of a section (K1297 同心→中卫→中宁, 9.7 km). This class is a side effect of the retrace change (before it, the repeat was deduped away). It is also what the earlier "69 orientation-fixable" were: not a sign bug (edge-direction lookups are exact) but partial traversal of a section. Fix (flow-neutral): count edges per run, and drop an immediately reversed repeat `!S` when it covers less than half of the edges of the preceding run of `S`.
- **Leg boundary, 55 (27 / 28).** The previous leg's geometry stops short of the station. Example: pair path 阳东–阳江 ends at (111.988, 21.813), 12 km from the 阳江 station point (111.877, 21.864); 茂名/电白–阳江 likewise (C69xx, G1575). These are data gaps in the pair paths (the endpoint is a junction, not the station).
- **Inside one leg, other, 10.** Not resolved.
- Previously listed "adjacent to chord leg" and "orientation-fixable" are now 0 as separate classes (they fold into the above).

**O4: router-only nodes have no coordinates.** Cause: `atlas.rs` (HEAD ~l.1736) builds `needed` only from `path_map.values()` (pair paths). `LEG_PATHS` segments (loaded earlier by `load_leg_paths`) are never added, so the OSM scan skips their nodes. Fix: also insert every `LEG_PATHS` segment node into `needed` (8 lines, `staging/o4.patch`). `audit.rs` has the same `needed` logic and needs the same change so its recount matches.
Prototype result (`staging/o4-build/`, overrides config + retrace): needed / resolved nodes 499,373 / 499,373. Chord rows **15,270 → 1,850** (all 13,420 cause-(d) rows gone; remaining: inbound-only 1,587 (304 legs) + real gaps 263 (5 legs)). >35 km jump rows: 0 outside chord legs, 0 inside. Sections 8,054 → 8,459, in_sections 7,923 → 8,325. Continuity > 6 km 417 → 436 and ≤ 6 km 61,807 → 64,399 (more geometry, more joins). Flows: secdiff `--edges` vs live = 178,238 changed edge entries: **173,847 added** (edges that had no flow), 2,817 up, 1,574 down/removed. No per-origin summary changed (outbound, fully tracked, dests, widest unchanged for every origin). Chengdu goldens unchanged (564 / 610 / 144 / 564 / 0; 558 / 627 / 105; CQ 136/53/62, 136/54/62). Added flow is concentrated on 宝成线 绵阳–广元 (105°E 32°N), 石太线 石家庄–太原 (113–114°E 38°N), Fujian (117–118°E 25°N), around Xi'an (109°E 34°N) and 渝怀/湘黔 (108°E 27°N): the switched router corridors that were drawn without track until now. Needs owner approval (flows change); goldens must be rebased (sections exact, continuity max).

**Other missing-track classes** (leg occurrences out / in; distinct pairs):
- bridged pair paths: 167 / 166 (7 pairs). 4 have a > 3 km hole and are chord legs: 平顶山西–禹州 154, 禹州–郏县 41, 恩平–阳江 40, 聊城西–菏泽东 20 rows (the real OSM gaps, O9).
- via_chain: 2,819 / 2,867 (106 pairs). One has a hole (江门–阳江, 8 chord rows).
- ferry: 71 / 67 (2 pairs, 徐闻–海口, 海口–湛江西). They have ferry-way geometry, so not chords.
- flagged: 7 / 5 (郏县–郑州东).
- inbound-only unresolved: 1,587 rows (304 legs), as above.
- leg geometry ending short of a station: the 55 boundary gaps above.

#### O2/O4 prototypes behind env flags (pipeline-phase12, after merge 7d8dbd0)
- Rebuilt `target/release` on the merged source; default staged build is unchanged: goldens PASS, hard checks PASS, dropped chains 0 / flow lost 0, secdiff `--edges` vs live 0.
- `atlas.rs`: `ATLAS_UTURN_TRIM=1` (flow-neutral): `trim_uturns` drops the shorter half of an immediate reversal `S, !S` when it covers under half the other run's edges, and remaps `prefix_cnt` and chord spans. `ATLAS_LEG_PATH_COORDS=1` (CHANGES FLOWS, O4): adds `LEG_PATHS` nodes to `needed`. The same flag is in `audit.rs`, so its recount matches. Both flags are off by default; uncommitted. `cargo fmt --all --check` clean; `cargo clippy --release --workspace --all-targets -- -D warnings` clean.
- `staging/uturn-build/` (U-turn trim only): secdiff 0; continuity > 6 km **417 → 345**, ≤ 6 km 61,807 → 61,865 (trimmed U-turns become throat-sized gaps); jumps > 35 km outside chords 0. The remaining U-turn gaps are real reversals with about equal runs (K1297 中卫 type).
- `staging/o4-build/` (both flags): needed nodes 471,960 → 499,373; chord rows 15,270 → 1,850; > 35 km jumps 0 / 0; sections 8,459 / 8,325; continuity > 6 km 364, ≤ 6 km 64,457; secdiff 178,238 changed edges (as in the O4 entry above). Chengdu goldens unchanged.
- To adopt: flip the flags to defaults (U-turn trim needs no approval beyond a goldens rebase; O4 needs owner approval), then `audit --update-goldens`.

#### PR #1 review fixes (merger)
- A. `DeparturesTable`: removed the effect that auto-pinned a city matched by the search box (main's behaviour: the matched city filters the table while typing, the rest of the query is the token, so "Chongqing G" works and "Shang" no longer pins 上海).
- F. `TrainCell`: shift/meta/ctrl clicks pass through to the row (range select, cmd-toggle); only a plain click stops propagation and opens the schedule.
- Scrubber: a filtered subset now keeps the full origin's span (`assembleTimeline(..., spanMins)`; same `totalMins`/`totalDays`/`numSteps` as `cur.timeline`), so ticks, slider mapping and needle stay put; the earlier clamp on filter change is gone. `TimelineScrubber` always uses the 75 % Day-1 split (`tot = max(1440, totalMins)`, empty tail when every train is in by 24:00), so the fixed ticks (188/375/562/750) and rush zones are correct for short origins too; `sliderToTime` clamps the empty tail to 24:00.
- C. Only the fmt-3 check (`FmtError`) sets `loadError` (full overlay); a tables-fetch failure leaves the map usable as on main. A successful tables fetch clears an error that came from that same URL.
- D. Hover hit-test for the isolated train uses `trainDistAt(isoPt, t)` instead of a linear time fraction.
- E. `drawHighlightSeg` for an isolated train highlights a section only once the train has reached it (`secStarts[k] <= trainDistAt`).
- G. City-pair sub-flows are capped by the section's total again: static `min(f.n, destN)`, animated `min(current section count, destN)`.
- H. `audit.rs gate_goldens`: a missing goldens file is a FAIL unless `--update-goldens` is given.
- Perf: `drawChords` uses a per-view map tcIdx → first departure (was O(chords × deps) per frame) and finds the isolated train once; `getActiveTrains` is memoised per (timeline, minute) via `activeTrainsAt`, shared by `drawTrains`, the isolated-corridor passes and the hover hit-test.
- B (client city-coordinate patches) unchanged, backlog O10.
- Checks: bun typecheck/build pass; `check_client_decode.mjs` OK; `check_filter_animation.mjs` OK (now asserts the subset span equals the full origin's; unfiltered still identical to the pre-merge branch); cargo fmt-check/clippy/test pass on a clean checkout of the commit (the working tree holds another agent's uncommitted O4 prototype in `atlas.rs`/`audit.rs`, not included).

#### O4 shipped on branch `fix/o4-router-coords` (pipeline-phase12)
- **Flow drops explained:** at the atomic level (OSM edge × origin, dumped by `staging/scripts/edgedump/`, a copy of atlas.rs; `staging/scripts/edges/`) the O4 build has **0 decreases and 0 increases on existing edges**; it only adds counts (553,101 outbound + 511,776 inbound edge×city entries that had none). The fix only adds node coordinates, and per-train edge sets can only grow. The 1,574 "down" and 2,817 "up" lines in secdiff `--edges` are representation churn: secdiff compares edges of the Douglas–Peucker-simplified section polylines, and the new flow splits section chains at new places, so simplified vertices move (top cells: 109°E 33°N, 117°E 34°N, 104°E 25°N, 109°E 24°N). Every change is a correction or neutral.
- **Examples (before → after):**
  - K118 成都 (成都西→广元 宝成线 router leg): 167 → 179 path sections, 1,957 → 2,150 path km, 2 → 0 chord legs.
  - K1807 南京 (石太线): 123 → 137 sections, 1,683 → 1,879 km, 1 → 0 chord legs.
  - C5225 福州 (漳平西→龙岩 router leg): 33 → 36 sections, 493 → 506 km, 1 → 0 chord legs.
- **Branch** (created from `4dbbfc7` in a separate worktree, `/Users/leland/Downloads/china-rail-o4`, so the shared checkout is untouched): commit `53d2129`, not pushed. `atlas.rs` and `audit.rs` add every `LEG_PATHS` node to `needed` (unconditional).
- **Rebuild** in `staging/o4-ship/`: hard checks PASS, dropped chains 0 / flow lost 0; after rebase, full audit goldens PASS (exit 0).
- **Goldens rebased:**
  - sections 8,054 → 8,459 and in_sections 7,923 → 8,325: new flow-bearing track creates new sections.
  - chord_leg_rows 15,270 → 1,850: the router-coordinate class is gone; 1,587 inbound-only + 263 real OSM gaps remain.
  - >35 km jumps inside chord legs 1,191 → 0; outside chord legs stays 0.
  - continuity ≤ 6 km 61,807 → 64,399 and > 6 km 417 → 436: joins checked grew 3.15 M → 3.36 M at the same throat-gap rate (~1.9%).
  - Chengdu / origins / schedules / non-monotone (48) unchanged.
- **Pack** copied into the branch's `web/public/assets/` (7 split `.br` + schedules json/br). typecheck pass, build pass, `check_client_decode.mjs staging/o4-ship` pass. `cargo fmt --check`, `clippy --workspace --all-targets -D warnings` and `cargo test --workspace` (9 tests) pass.
- The main checkout still has the uncommitted env-flag prototypes (`ATLAS_UTURN_TRIM`, `ATLAS_LEG_PATH_COORDS`) in atlas.rs/audit.rs. Drop the O4 flag when the branch merges.
- Cleanup: the env-flag prototypes were saved to `staging/o4-flags.patch` (regenerated against HEAD as a unified diff, pre-rustfmt; archival only) and `atlas.rs`/`audit.rs` were restored to HEAD in the shared checkout (the diff held only my hunks). `ATLAS_UTURN_TRIM` dropped by owner decision (U-turns acceptable; O11 won't-do). O4 lives only on `fix/o4-router-coords` (worktree `../china-rail-o4`, commit `53d2129`, unconditional, no flag).

#### Spot check G3764 (spotcheck)
Read-only; scripts and decoded live pack in `staging/spotcheck/` (`g1.py`, `g2.py`, `osmbox.py`, `match.py`, `national.py`, `dot.mjs`).
- **Observed dot reproduced** with the client code (`dot.mjs`, origin 长沙, t=932): 29.7406, 106.6843, progress 44%. Leg 重庆东 (dep 15:02) → 江北机场 (arr 15:48); live `dep_chord_legs` = `[[11, 37, 40]]`; the client chord span runs 29.6412,106.8078 → 29.7591,106.7206 (15.6 km straight line), crossed at about 15:20–15:30.
- **Not Line 3.** Every way under positions 31–45 is `railway=rail`: 渝厦高速线 (1132672414, 1132672368; `usage=main`, 350), 重庆东环线 (844060873, 844060856, 1492263317, 1333258637; `usage=main`, 160), 渝怀线 (537153705), 渝熊线 (844060868, 1492886008, 844060858; `usage=branch`). Line 3 monorail (52 ways, e.g. 174721848) lies in lon 106.499–106.664; section 757 is ≥10 km away from it. All three graph builders accept only `railway=rail|ferry` (`analyze/src/graph.rs:70`, `router/src/graph.rs:205`, `atlas.rs:1900`); `filter` keeps subway/monorail but they never enter a graph. National check of every pair path (7,698) and leg path (14,680) edge: 0 edges on subway/monorail/light_rail/tram/funicular/narrow_gauge ways, and 0 on the 28 metro-named `railway=rail` ways. Service track (yard/siding/crossover) is in most paths (station throats); `usage=industrial|military` bits sit in 56 pair and 17 leg paths, which is minor.
- **Route.** The stop list is 南川北 → 重庆东 → 江北机场 → 重庆北 → 荣昌北 → 内江北 → 成都东, so the train uses the southern 成渝高铁, and it is drawn that way (positions 44–74 via 永川, 荣昌, 内江). Nothing is drawn on 遂渝 or 合川. Entry is 渝厦高速线 (渝湘) from 南川北 into 重庆东 (29.4871,106.6692), coming from the 巴南/南岸 side; this is plausible. The northeast excursion is the 江北机场 stop: corridor-v3 `leg_paths` `#cv3:6017:1` (decision `filled`, 81.5 km, matching the 12306 81.4 km) loops 重庆东环线 茶园 → 鱼嘴 → 29.87,106.81 → 江北机场. G3764 has no `leg_overrides` entry. Station snapping is correct (rail stations, endpoints within 100 m).
- **Bug: O4.** The 47 km middle of that leg (path nodes 60–314, mostly 重庆东环线 ways such as 1492263269 and 844060904) is in no pair path, so it gets no coordinates (diag cause `d_missing_coords:router`). Because of the gap, the leg is emitted as a chord. The `staging/o4-build` pack (`ATLAS_LEG_PATH_COORDS=1`) has chord legs `[]` for G3764, and position 39 becomes a 46.6 km loop. Secondary client issue: the client anchors stops per city, so 江北机场 (15:48) and 重庆北 (16:05–16:11) are not anchors and the dot is already west of 重庆北 at 15:48.

#### O14 (station-level dwells)
- **Bug:** calls are emitted once per destination city (`seen_dest` in `atlas.rs`), and the client built its dwell stops from them, so later stations in a city were run through. Both suspected variants are confirmed:
  - (a) Stops in the home city after boarding never become calls (D2323 from 广州 runs through 广州东).
  - (b) At a multi-station terminus the `term` call sits on the first station of the city, and the client puts the path end there. G3764 from 长沙 reached the path end at 西安西 21:41 and then waited until its 21:56 arrival at 西安北.
- **Affected:** 11,951 of 29,925 dep rows (3,861 trains) have a station with no city call. By class (rows can be in several): home city 4,961, terminus city 3,603, intermediate city 6,473.
- **Pipeline** (`atlas.rs`, `atlaspack.rs`): out-tables `dep_stop_pos` (fmt 4) gives, per dep row, the path position (`prefix_cnt` at that stop) of every stop after boarding; the stops are `schedules[t][len - stops ..]`. This costs +198 KB brotli. Putting stations and times inline would have cost +725 KB, and schedule rows can't carry a single pathPos because paths are per (origin, train). City calls, city stats and flows are unchanged: secdiff `--edges` vs the main pack = 0.
- **Audit:** fmt 4. New checks per dep row: one position per schedule stop, monotone, ending at the path end. Every city call must match one station stop (same arrival minute and position): 0 misses. Times are monotone: 0 regressions. Goldens add exact `dep_stops_total` 235,264 and `dep_rows_with_uncalled_stations` 11,951, plus max `dep_stops_time_regressions` 0. Full audit PASS, dropped chains 0 / flow lost 0.
- **Client:**
  - `buildDayTimeline` builds PrepTrain stops from `schedules[t]` plus `dep_stop_pos`. Distance is `secStarts[pos]`; a stop that departs across a chord gap at its own join sits on the near side. Times are shifted into the boarding-day frame, and the terminus is the final schedule stop at the path end.
  - The calls-based stop builder is removed. City calls still drive stats, pulses, city-pair highlighting and filters.
  - `App.tsx`: the out-tables wait for the schedules asset (`loadSchedules`), and `applyOutTables` attaches it to the atlas. `requireFmt4`.
- **Evidence** (`staging/scripts/o14_before_after.mjs`): main lib: 21 stops, reaches the path end 21:41, no 江北机场/重庆北. Branch: 24 stops, 重庆东 14:59–15:02, 江北机场 15:48–15:50, 重庆北 16:05–16:11, 西安西 21:41–21:43, 西安北 21:56 at the path end.
- **Checks:**
  - `check_client_decode.mjs` gained a per-station dwell assertion (G3764 + 141 sampled rows: one stop per schedule stop, `dist` = `secStarts[pathPos]`, dot on the stop for the whole dwell, last stop = arrival): OK.
  - `check_filter_animation.mjs` (BASE_REF=HEAD): steps, counters and final-step flows equal; dot positions differ by design. OK.
  - typecheck/build pass; `cargo fmt --check`, `clippy --workspace --all-targets -D warnings` and `cargo test` (9) pass.
  - Build: `staging/o14-build/` (env.sh config). Scripts: in this worktree's `staging/scripts/` (untracked; O13 would promote them).

