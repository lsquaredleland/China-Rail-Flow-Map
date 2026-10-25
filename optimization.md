# China Rail 24h Flow Animation — Pipeline-First Optimization Plan (`optimization.md`)

_Revised 2026-10-23. Supersedes the earlier client-side chainer plan (summarized in Appendix A)._

## 0. Context

- **Active repository:** `/Users/leland/Downloads/china-rail-animation`, branch `explore/24h-train-flow-animation`
- **Handoff repository (keep clean):** `/Users/leland/Downloads/china-rail-handoff-v3`
- **Preview server:** `http://localhost:8090/` serving `web/dist`
- **Client checks:**
  ```bash
  npm --prefix /Users/leland/Downloads/china-rail-animation/web run typecheck
  npm --prefix /Users/leland/Downloads/china-rail-animation/web run build
  ```
- **Pipeline rebuild:** `docs/PIPELINE.md` §3 step 5 (corridor-v3 env vars `ATLAS_OVERRIDES` = empty file, `ATLAS_PAIR_PATHS`, `ATLAS_LEG_PATHS`), then `atlaspack`, then `audit`. Verify against the goldens in `docs/PIPELINE.md` §7.
- **Owner rule:** pipeline changes go through a **staged** rebuild, are verified, and are swapped live only with the owner's approval. Timetable inputs come from `data/raw/*.jsonl`. No new 12306 pulls.

## 1. Principle

> **Anything that depends only on static data is computed in the pipeline. Only things that depend on the clock (`t`) or on the user (filters, isolation, selection) are computed in the browser.**
> Precompute everything about a train once; at runtime, only work out where it is at time `t`.

The animation was added on top of a data model (2026-10-22) built for one static question: *which sections, with how many trains, connect origin X to city Y?* For that, a train's sections only needed to be a **set** plus a per-stop cutoff count (`sec_cnt`). Order and direction were never guaranteed. The browser then tried to reconstruct them from geometry. Every bug in §3 comes from that reconstruction, or from the browser rewriting shared train records in place to store it.

### Target split

| Computed | Today | Target |
|---|---|---|
| Corridor routing, track sections, flow counts | Pipeline | Pipeline (unchanged) |
| Each train's section order and direction | Client (guessed by chaining) | **Pipeline**: exact, signed encoding |
| `sec_cnt` stop cutoffs | Pipeline (on an unordered list) | **Pipeline**, defined on the true travel order |
| Stop positions along the route | Client (city centre snapped to nearest vertex) | **Derived exactly** from `sec_cnt` on the ordered path (no new data) |
| Calibrated city arrival times (`dest.arrTimes`) | Client (re-estimated) | **Gone**: equal to the timetable once stops are exact |
| Continuous path through stations | Missing (1.3 km cut at every station) | **Pipeline**: geometry-only station-throat stubs (Phase 3) |
| Per-train schedule (modal) | Committed file, no generator | **Pipeline**: generated from `data/raw`, audited |
| Section lengths, cumulative distances (`secStarts`) | Client | Client (one cheap pass; shipping costs more than it saves) |
| `secFlowSteps` (5-min flow growth) | Client | Client (≈7.5k sections × 288 steps per origin, too large to ship) |
| Position at time `t`, easing, dwells | Client | Client, through **one** shared `trainDistAt()` |
| Class / city-pair / isolation filters, caches | Client | Client |

---

## 2. Phases at a glance

| Phase | Where | Depends on | Ships |
|---|---|---|---|
| **0. Client fixes on current data** | `web/` | nothing | now, independently |
| **1. Ordered, oriented paths** | `atlas.rs`, `atlaspack.rs`, `audit.rs` | staged rebuild | with Phase 4 |
| **2. Generated schedules** | `atlas.rs` (or a new `schedules` bin), `audit.rs` | staged rebuild | with Phase 4 |
| **3. Station-throat stubs** (optional, visual) | `atlas.rs`, `atlaspack.rs` | Phase 1 | separately, or with Phase 4 |
| **4. Client cleanup on new data** | `web/` | Phases 1–2 live | together with the new assets |
| **5. Per-train path dedupe** (optional, size) | `atlas.rs`, `atlaspack.rs` | Phase 1; measure first | later |

The web app and the assets live in the same repo and ship together. The client **requires** the new format, with no dual code path, so the chainer can be deleted outright rather than kept as a fallback.

---

## 3. Bug ledger: every known bug, and where it gets fixed

Line numbers are as of commit `a8b9f00` plus the uncommitted `App.tsx`/`types.ts` changes.

| ID | Bug | Location | Root cause | Fixed in |
|---|---|---|---|---|
| **B1** | False teleports: 4,599 / 28,507 connected trains (16.1%) jump >35 km (`K678` 1,176 km, `D1804` 245 km) | `web/src/lib.ts:1071-1113` (greedy walk) | `atlas.rs:2672-2687` emits `dep_secs` in **stored (min, max) direction** per leg, not travel direction (`leg_key3`, `atlas.rs:1317`) | **Phase 1** (root cause), **Phase 4.1** (delete chainer) |
| **B2** | Wrong city-pair section counts once the timeline exists: `secCnt` (an index into the pipeline's order) slices the browser's reordered `dep.secs` | `web/src/components/MapCanvas.tsx:593` (`getDestSectionCounts`) | `buildDayTimeline` overwrites `train.secs` in place (`lib.ts:1185`) | **Phase 0.1** (stop mutating), then exact by construction in **Phase 1** |
| **B3** | City-pair highlight depends on click order: `destSecCountsCache` may hold counts computed before or after the reorder | `MapCanvas.tsx:571-583` | same as B2 | **Phase 0.1** |
| **B4** | Fallback arrival time indexes reordered `secStarts` with raw `secCnt` | `lib.ts:1341-1346` | same as B2 | **Phase 0.1** (stopgap), deleted in **Phase 4.3** |
| **B5** | City-pair corridor lighting isn't locked to the dots: whole-journey linear time, ignoring dwells and easing; also uses `secCnt` on reordered secs | `MapCanvas.tsx:624-655` (`getActiveDestSectionCounts`) | approximate kinematics duplicated outside the timeline | **Phase 4.4** |
| **B6** | Three different position models: dots (stop-aware + `trainEase`), `secFlowSteps` (stop-aware, no easing), corridor lighting (whole-journey linear) | `lib.ts:1424-1486`, `lib.ts:1264-1290`, `MapCanvas.tsx:624-655` | no shared position function | **Phase 4.4** (`trainDistAt`) |
| **B7** | Stop positions are approximate: city centre snapped to the nearest route vertex (wrong for multi-station cities); O(calls × vertices) per train | `lib.ts:1194-1242` | the pipeline knows leg boundaries but doesn't expose them on an ordered path | **Phase 1** (data), **Phase 4.2** (client) |
| **B8** | Trains stall or jump ~2.6 km at every station (throat gaps); also the source of the "throat-splice" class of B1 | `atlas.rs:2287-2301` (`near_station` < 1.3 km) applied at `atlas.rs:2324` | trimming suits flow widths but leaves per-train paths discontinuous | **Phase 3** |
| **B9** | Filtered city pulses fire at the scheduled `call.arrMins`, unfiltered ones at the calibrated `dest.arrTimes`: inconsistent | `MapCanvas.tsx:1206-1268` (`getCityAllowedArrivalTimes`) | two sources of truth for arrival | **Phase 4.3** (one source) + **Phase 0.3** (cache) |
| **B10** | `drawStations`: each dot builds a new Set, runs `cur.dests.find` twice (O(D²) per frame) and sorts, at 60 FPS | `MapCanvas.tsx:1418-1419` | per-dot recomputation | **Phase 0.3** |
| **B11** | `getAllowedTrainCodes()` rebuilt several times per frame | `MapCanvas.tsx:1279`, `:1418`, `:1957`, `:2314` | no per-frame or per-selection cache | **Phase 0.3** |
| **B12** | `getAnimState` counts use `DepVM` times rather than the `PrepTrain` times the dots use (minor; *not* a duplicate `getActiveTrains` call as the old plan claimed) | `MapCanvas.tsx:1957-1970` | — | **Phase 0.4** |
| **B13** | Schedule modal anchor: `isArrVM` is always false (`ArrVM` also has `depMins`), so inbound trains anchor on the wrong end | `web/src/components/TrainScheduleModal.tsx:154` | type check by field presence | **Phase 0.5** |
| **B14** | The inbound timeline is still built in outbound mode: `filterOriginByClasses` reads the lazy `cur.inTimeline` getter; ~8 MapCanvas sites pick `cur.inTimeline` in inbound mode | `lib.ts:1843`; `MapCanvas.tsx:698, 1061, 1110, 1240, 1272, 1406, 1950, 2007…` | lazy getter triggered by copies and direction ternaries | **Phase 0.2** |
| **B15** | Inbound animation gating incomplete: modal "Isolate" controls still shown; duplicated inbound handling (`setDirection` + new `useEffect`) | `web/src/App.tsx:675-700`, `TrainScheduleModal.tsx` | partial Task A | **Phase 0.2** |
| **B16** | (Would-be bug) the old plan's chainer guard `isOut` + unconditional `train.secs = routeSecs` would set every `ArrVM.secs` to `[]` and break inbound highlighting | old plan Task B | — | **Avoided**: chainer is never written |
| **B17** | (Would-be bug) the old plan's throat-splice matched one endpoint only, so it could splice long sections and create new teleports | old plan Task B | — | **Avoided**: chainer is never written |
| **B18** | Inbound `arr_secs` has the same stored-direction problem as B1 (built with `.rev()` over canonical sequences) | `atlas.rs:2829-2841` | same as B1 | **Phase 1** |
| **B19** | `atlas-v2-schedules.json` has no generator in the repo (not audited, not in the goldens); `extra_stations` holds unnormalized 12306 names (`"沈  阳北"`, `"重  庆西"`), so they miss the station table; keyed by train code only | `web/public/assets/atlas-v2-schedules.json`, `lib.ts:1855-1890` | one-off file outside the pipeline | **Phase 2** |
| **B20** | Chord-only legs (no track geometry: 平昌→达州, 南京→扬州) animate as straight-line jumps | data gap (`PIPELINE.md` §4) | missing OSM geometry | **Phase 1.4** (flag), visual treatment in **Phase 4.5**; real fix = fill geometry (out of scope) |
| **B21** | Lazy timeline build and repeated rebuilds read already-mutated `train.secs` (`lib.ts:1064`) | `lib.ts:1064` | in-place mutation | **Phase 0.1** |

---

## 4. Phase 0: client fixes on the current data (ship now)

These don't depend on the pipeline and are kept minimal so Phase 4 can delete most of what they touch.

### 0.1 Stop mutating shared train records (B2, B3, B4, B21)
- `web/src/lib.ts:1185-1188`: remove the writes to `train.secs`, `train.secStarts`, `train.secRevs`, `train.totalDist`. The reordered data already lives on `PrepTrain` (`secs`, `secStarts`, `secRevs`, `totalDist`).
- Find every reader of `DepVM.secStarts/secRevs/totalDist` (at least `MapCanvas.tsx:624-655`) and switch it to `timeline.getPrepTrain(code)`, or leave it on raw `dep.secs` where it only needs the **set** (as `getDestSectionCounts` does).
- Remove `rawSecs?`, `secStarts?`, `secRevs?`, `totalDist?` from `DepVM` in `web/src/types.ts:269-273`. This drops the uncommitted `rawSecs` addition.
- B4 stopgap (`lib.ts:1341-1346`): compute `distToC` as the largest route position among `rawSecs[0..secCnt)` (one Set plus a scan), not `secStarts[secCnt]`. Phase 4.3 deletes this block.
- **Verify:** for one origin and one destination, `getDestSectionCounts()` returns identical maps before and after `cur.timeline` is first accessed.

### 0.2 Never build the inbound timeline (B14, B15)
- `lib.ts:1843` (`filterOriginByClasses`): don't copy `inTimeline: cur.inTimeline`. Either drop the field or make the getter return `undefined`.
- Make the `inTimeline` getter (`lib.ts:818-830`) return `undefined` and delete the `"in"` branches of `buildDayTimeline` (`lib.ts:995-1058`, `1114-1160`, `1361-1395`). This is safe only because 0.1 has removed the in-place mutation.
- Replace the direction ternaries in MapCanvas with one helper, `activeTimeline()`, that returns `undefined` when `direction === "in"`.
- `App.tsx:675-700`: keep the inbound reset (collapse, un-isolate, pause, disable) in **one** place: the `useEffect` on `direction`, which also covers loading straight into inbound mode from storage. Remove the copy in `setDirection`.
- `TrainScheduleModal.tsx`: hide the Isolate / live-jump controls when `direction === "in"` (pass `direction` in as a prop).

### 0.3 Per-selection caches in `drawStations` (B9 partial, B10, B11)
- Add `S.current.selCache = { cur, panelDest, iso, dir, allowedCodes, cityTimes: Map<cityIdx, number[]> }`, rebuilt only when one of those keys changes.
- When building it, index `cur.dests` / `cur.srcs` by `idx` once (a Map) instead of calling `find` per dot.
- `drawDot` reads `selCache.cityTimes.get(c.idx)`: no allocation, no sort. The other per-frame callers (`MapCanvas.tsx:1279`, `:1957`, `:2314`) read `selCache.allowedCodes`.
- Source of the times: for now, same as today. Phase 4.3 makes filtered and unfiltered use the same source.

### 0.4 `getAnimState` (B12)
- `MapCanvas.tsx:1957-1970`: iterate `selCache.allowedCodes` and look up `tl.getPrepTrain(code)`; count `t >= pt.depMins` / `t >= pt.arrMins`.

### 0.5 Schedule modal anchor (B13)
- `TrainScheduleModal.tsx:154`: `const isArrVM = "fcIdx" in trainVM;`

---

## 5. Phase 1: pipeline emits ordered, oriented paths (B1, B7, B18, B20)

All changes are in `pipeline/analyze/src/bin/`. Flow counts and section geometry **must not change**: this phase only changes the order and sign of `dep_secs` / `arr_secs`.

### 1.1 Remember each leg's travel direction
- Train legs are built at `atlas.rs:1959-1969` (outbound) and `atlas.rs:2166-2176` (inbound) via `leg_key3(…, &a, &b)` with `a, b` in **travel order**. The key is canonicalized to `(min, max)`, losing direction.
- Keep the canonical key for `leg_count` and the path caches, but store direction alongside it: `legs: Vec<(LegKey, bool /* fwd = a < b */)>` (or a parallel `leg_fwd: Vec<bool>`) in `DepRaw` / `ArrRaw` (`leg_keys` at `atlas.rs:1924`, `2122`).
- **Assert once per run** that a stored pair path really runs `key.0 → key.1`: the first vertex of `seqs[0]` is nearer `key.0`'s station than `key.1`'s. Also check the `via` overrides, which `leg_key3` reverses when flipping. Fail loudly if not; the whole phase relies on this.

### 1.2 Record each section's vertex direction
- Section chains are built at `atlas.rs:2373-2416` and registered at `atlas.rs:2458-2460` with an **undirected** `edge_to_sec`.
- Keep `edge_to_sec` for flows. Add a directed map `edge_dir_to_sec: HashMap<(i64, i64), (usize, bool)>`, inserting `(chain[i], chain[i+1]) → (sec, false)` and `(chain[i+1], chain[i]) → (sec, true)`. The section's stored polyline (`simp`) follows `chain` order, so `true` means "travelled against stored point order". Do the same for `in_edge_to_sec` (`atlas.rs:2625`).
- Build this map **inside** the section loop (`atlas.rs:2436-2460`), next to `edge_to_sec.insert`. Don't look orientation up later via `section_chains[sidx]`: `sec_idx` is `sections.len()`, and chains with fewer than 2 resolvable or simplified points are skipped (`continue`), so `section_chains` indices drift from section indices after the first skip. Note: the Gemini review (the Gemini review, deleted in PR #10; see git history) §4.1A does exactly that lookup, and also uses `position()` scans, which are O(chain length) per edge.

### 1.3 Emit paths in travel order with a sign bit
- `atlas.rs:2668-2690` (outbound): for each leg, if `!fwd`, iterate `seqs` in reverse **and** each `s.windows(2)` in reverse. Look up the **directed** window in `edge_dir_to_sec`, and push `sec` if `!rev`, else `!sec` (that is, `-(sec + 1)`, so section 0 can also be reversed). Keep the `seen_s` dedupe (first-seen = travel order), and keep `prefix_cnt` exactly as now. `sec_cnt` keeps its meaning but is now defined on the true travel order.
- `atlas.rs:2826-2844` (inbound): same fix. Emit `arr_secs` in **travel order** (source → arrival city) and change `suffix_cnt` to count from the end, keeping its meaning ("sections from boarding stop to arrival").
  - Alternative: keep today's arrival-first order, so the client's `startK = len - secCnt` logic is unchanged, but then sign bits mean "reversed relative to arrival-first". Pick one and document it in the `atlaspack.rs` header; travel order is recommended for symmetry with outbound.
- Encoding alternative: a parallel `dep_revs` / `arr_revs` array of 0/1 (as the Gemini review §4.1C proposes) is equivalent and more readable, at the cost of 1.71M more integers before compression. Either is fine; pick one, and keep the client decode in one function.
- `atlaspack.rs:184-185, 306-307`: pass through unchanged (the values are now signed). Add `"fmt": 3` to `out-tables` / `in-tables` so the client can refuse stale assets.

### 1.4 Flag chord legs (B20)
- For legs whose status is `bridged` or chord-only (no geometry), emit the leg index in a per-train `chord_legs` list. Alternatively, put a sentinel in the path, e.g. `null`, between the sections on either side. The client renders these spans differently (Phase 4.5) instead of animating a fake straight run.

### 1.5 Audit gate additions (`audit.rs`)
- **Flows unchanged:** the staged `flows` / `in_flows` / `sections` must be byte-identical to the live pack (run `secdiff`: zero changed sections).
- **Path continuity:** for every `dep_secs` / `arr_secs` path, the gap between consecutive oriented sections (exit point of `k` to entry point of `k+1`) must be ≤ 3.0 km, except at `chord_legs`. Report the count and the worst 20 offenders. Target: **0** outside chord legs. This replaces the unreproducible "4,599 → 104" measurement with a gate anyone can rerun.
- **Cutoffs monotone:** within each train, the `sec_cnt` values from its calls, sorted by time, never decrease.
- Add the continuity count and the chord-leg count to the goldens in `docs/PIPELINE.md` §7.

### 1.6 Cost
- Sign bits: about 0 bytes (the same 1.71M integers; a minus sign on roughly half of them, mostly absorbed by brotli). `chord_legs`: small. No other new fields.

---

## 6. Phase 2: generate the schedules file in the pipeline (B19)

- Add an emitter to `atlas.rs` (it already loads stops and interns stations), or a small new bin. It writes `atlas-v2-schedules.json` from `data/raw/stops.jsonl` + `stops_cs.jsonl` (+ `stops_c` / `stops_s` as used by the live build). **No 12306 queries.**
- Normalize station names the same way as everywhere else (strip 12306's space-typeset names: `clean()`, `atlas.rs:559`) **before** interning. Stations then resolve into `station_table`, and `extra_stations` should become empty or near-empty.
- Key by the train table index `t` (already present in `deps` / `arrs` rows; `intern_train`, `atlas.rs:3099`) rather than by bare code, so identical codes can't collide.
- Keep the row shape `[stIdx, arrMins, depMins, dayOff, legKm]`. Compute `legKm` from the same leg lengths used for `km`, so the modal and the tables agree.
- Audit: every dep/arr row's train has a schedule; every schedule's stop count matches `stops` on the row.
- Remove the hand-committed `atlas-v2-schedules.json` from `web/public/assets/` in favour of the generated one (same filename, so `App.tsx:60` is unchanged).

---

## 7. Phase 3: station-throat stubs for continuous paths (B8, optional)

- Edges dropped by `near_station` (`atlas.rs:2324`) still exist in each train's `seqs`. Collect them into **geometry-only** `throats`: maximal chains of consecutive trimmed edges on train paths, deduped globally, with polylines simplified like sections (`dp_keep`, `round_pt`).
- Pack them into `atlas-v2-shared.json` as `throats` (same encoding as `sections`), with ids in a separate range (e.g. `sections.len() + j`), so the flow renderer never sees them.
- During path emission (1.3), include throat ids in travel order, with sign bits. Throats are **not** counted in `prefix_cnt`: `sec_cnt` stays a count of flow sections. Instead emit, per train, a `stop_pos` list giving the path index of the throat where each stop sits. Phase 4.2 then puts the stop point at the station itself.
- Measure the size (added geometry points and path refs) in the staged pack before committing to it. If it's too large, skip Phase 3: Phase 1 already removes all large jumps, and what's left is a ~2.6 km hop at stations.
- Audit: with throats included, the continuity gate tightens from 3.0 km to 0.1 km.

---

## 8. Phase 4: client cleanup on the new data

### 4.1 Delete the chainer (B1)
- `lib.ts:1068-1161`: replace with a decode. `rev = s < 0 ? 1 : 0; sec = s < 0 ? ~s : s`. Build `PrepTrain.secs` / `secRevs` / `secStarts` directly. Refuse to load assets without `fmt: 3`.

### 4.2 Exact stop positions (B7)
- Replace the vertex-snapping loop (`lib.ts:1194-1242`) with `stop.dist = secStarts[call.secCnt]` (or `totalDist` when `secCnt >= secs.length`). With Phase 3, use the throat position from `stop_pos`.
- `callsByTrain` (`lib.ts:970-994`) stays: the calls are the per-train stop list.
- **Don't ship pipeline track-km per stop** (the `call.track_km` in the Gemini review §4.1B). That km is measured on raw OSM geometry, including the trimmed station throats. The client's `secStarts` are measured on simplified, 1e-4-rounded section geometry **without** the throats (~2.6 km lost per station). The two scales drift apart along the route (tens of km after 20 stops), so dots would dwell short of their stations. `secStarts[secCnt]` is in the client's own distance scale, so it's correct by construction and costs no bytes. If a km value is wanted for display (the modal), use the schedules file's `legKm` (Phase 2), not the animation.

### 4.3 One source for arrival times (B4, B9)
- With exact stop positions, a dot reaches each city at that stop's timetabled arrival time. Delete the calibration block (`lib.ts:1320-1395`), including the B4 fallback. `dest.arrTimes` comes straight from the calls (`c[3] * 1440 + c[1]`), as built at load time.
- `selCache.cityTimes` (Phase 0.3) uses the same call times, filtered by `allowedCodes`. Filtered and unfiltered pulses then agree.

### 4.4 One position function (B5, B6)
- Extract `trainDistAt(pt: PrepTrain, t: number): number` from `getActiveTrains` (`lib.ts:1424-1486`: before departure → 0; after arrival → `totalDist`; dwelling → `stop.dist`; otherwise per-leg `trainEase`). Export it from `lib.ts`.
- `getActiveTrains` calls it. `secFlowSteps` (`lib.ts:1264-1308`) inverts it per section entry, by binary search on `t` within the leg, so lighting includes easing.
- `getActiveDestSectionCounts` (`MapCanvas.tsx:624-655`): per `(cur, dest)`, cache for each call the list `[(secId, routePos)]` for `secs[0..secCnt)` (built once with `selCache`). Per frame: `d = trainDistAt(pt, t)` for each call; light every cached section with `secStarts[routePos] <= d`. No per-frame Sets; sections light exactly when the dot enters them and hold during dwells.

### 4.5 Chord legs (B20)
- For spans in `chord_legs`: draw the dot as a dashed or faded marker along the chord (or hide it until the leg ends), and show "no track geometry" in the inspector tooltip.

### 4.6 Remove leftovers
- Remove: `getSecGeometry`'s use for stop snapping (keep it for `secStarts`), the `PrepTrainStop.dist` heuristics, any `rawSecs` references, and the inbound branches already removed in Phase 0.2.
- Check the changed files for TODOs, stubs and `as any` casts introduced along the way.

---

## 9. Phase 5: per-train path dedupe (optional, size)

- Today `out-tables` repeats each train once per origin it serves: 29,871 rows for ~7,253 trains, 1.71M section refs (14.1 MB raw / 1.67 MB brotli), only 22,558 distinct lists.
- Option: emit one full ordered path per train `t` in a shared `paths` table, and give each origin's dep row `p0` = the path index where it boards. `sec_cnt` becomes relative to `p0`. Only worth doing if the staged measurement shows a meaningful brotli saving; it changes nothing functionally.

---

## 10. Verification checklist

| Step | Check |
|---|---|
| Phase 0 | `typecheck` + `build` pass; B2/B3 check (counts identical before and after the timeline build); switching to inbound never calls `buildDayTimeline(…, "in")` (log or breakpoint); class-filter change in outbound doesn't build the inbound timeline; frame time in `drawStations` with a city selected (Performance panel, before vs after) |
| Phase 1–2 (staged) | 1.1 direction assertion passes; `audit`: dropped chains 0, flow lost 0, `secdiff` 0 changed sections, continuity violations 0 (outside chord legs), cutoffs monotone; goldens §7 unchanged except the new continuity/chord counts; schedules audit passes, `extra_stations` ≈ empty |
| Phase 4 | `typecheck` + `build`; `curl -sI http://localhost:8090/` returns 200; isolate `G1580` and scrub to 34% (11:44): the highlight behind the dot is solid, with no gap and no reverse-drawn segment (exercises `secRevs` in `traceInto` / `tracePartialSec`); spot-check `K678` (Guangzhou), `D1804` (Chengdu East), a Chengdu→Chongqing D train with stops: no jumps, dwells at the right stations, corridor lighting matches the dot, city pulse fires when the dot arrives; with a city-pair filter active, pulse times match the unfiltered ones for the same trains |
| Swap | Owner approval, then copy the staged pack into `web/public/assets/` alongside the Phase 4 client in one commit |

---

## Appendix A: what happened to the earlier plan

| Earlier task | Status |
|---|---|
| A. Disable inbound animation | Kept, completed in **Phase 0.2** (plus never building `inTimeline`) |
| B. Bidirectional + throat-splice chainer (4,599 → 104 false jumps) | **Dropped.** Root cause fixed in the pipeline (Phase 1, target 0). The draft also had B16/B17. The empirical root-cause analysis (canonicalized leg keys, 1.3 km throat trimming) still stands and motivates Phases 1 and 3 |
| C. Cache per-frame station calls | Kept as **Phase 0.3** |
| D. Stop-aware city-pair lighting | Kept, moved to **Phase 4.4** on the shared `trainDistAt` |
| E1. `getAnimState` counts | Kept as **Phase 0.4** (the "duplicate `getActiveTrains`" premise was incorrect) |
| E2. Modal `isArrVM` | Kept as **Phase 0.5** |
| `rawSecs` preservation | **Dropped**: replaced by not mutating `DepVM` (Phase 0.1) |
