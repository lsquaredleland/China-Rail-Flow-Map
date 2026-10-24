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
| 4. Client on new data | done (4.1–4.5; 4.6 sweep pending, virtual crow-flies spans for chord legs); owner browser check OK | live assets swapped |
| 5. Path dedupe | backlog O6 | |

## Session 1 outcome (committed 2026-10-24)
- Phases 0, 1, 2, 4.1–4.5, goldens gate, staged pack swapped into `web/public/assets/` (owner verified in browser: equivalent to pre-port). At commit: typecheck, build and `node staging/scripts/check_client_decode.mjs` pass.
- **NOT done (agents hit the usage limit mid-task, 2026-10-24):** (a) Phase 4.6 cleanup sweep: may be partially applied, but the committed tree passes all checks; redo the sweep (dead code, stale chainer/calibration comments, unneeded `as any`). (b) `docs/PIPELINE.md`: done (§3 step 5 live recipe + fmt-3 format; §7 now points to `pipeline/goldens.json`).

## Backlog: optional improvements (not started)
| # | Item | Changes flows? | Notes |
|---|---|---|---|
| O1 | Phase 3 station-throat stubs | no | removes the 61,807 gaps of ≤6 km at stations (trains hop a few km at stations today); ~728 distinct joins, ~2k points, ~62k path refs; then tighten the continuity gate |
| O2 | Triage the 417 continuity gaps over 6 km | no | 69 orientation-fixable, rest unexplained (e.g. K237 69.7 km); scripts in `staging/scripts/` |
| O3 | Chord legs at a path end | no | no virtual span there, so the dot waits, then appears; use the stop/city point as the far end |
| O4 | Fix router `#cv3` node coordinates in `atlas.rs` | **yes**: owner approval + staged diff | 13,420 chord rows / 223 legs (e.g. K118 成都西→广元) |
| O5 | Resolve inbound-only legs | **yes**: owner approval | 1,587 chord rows / 304 legs; after O4+O5 only ~5 real gap legs remain |
| O6 | Phase 5 per-train path dedupe | no | 29,871 rows for ~7,253 trains; measure the brotli saving first |
| O7 | 48 inbound loop trains with non-monotone `sec_cnt` | no | documented quirk (cutoff clamps to 0); decide whether to fix |
| O8 | Gate `dropped chains` / `flow lost` in `--pack-only` audits too | no | currently only the full audit enforces them |
| O9 | Fill real OSM geometry gaps (平昌→达州, 南京→扬州, …) | yes | data work, prerequisite noted in PIPELINE.md §4 |

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
