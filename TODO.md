# TODO: deepening work

From a codebase-design survey (2026-10-28). Terms: a **module** is anything
with an interface; it is **deep** when a lot of behaviour sits behind a small
interface. A **seam** is where that interface lives. No changes have been made
yet.

Rules that apply to everything below:

- Data and pipeline changes go through a PR. The `audit` + goldens gate must
  pass unchanged, and `secdiff` must show no section diff.
- Web changes must keep the client dumb: lookups, sums and lerps only.
  `bun test` must pass.
- Token estimates are for delegating each item to a Sonnet agent. Input
  tokens are mostly cache reads.

## Status (2026-10-29)

Everything below is in **PR #158** (`deepening/swap`), which also carries
the rebuilt pack. #152–#157 are subsets of it; close them once #158 merges.

| Item | Outcome |
|---|---|
| 1a | Done: `analyze_rs::legwalk`. Pack byte-identical. |
| 1b | Done: one `sections()` (Opus rewrite, net −16 lines). The works and assemble pairs are genuinely different and stay. |
| 2 | Done: `pack::Entry` etc.; audit and packdiff output identical. |
| 3 | Dropped: the JSON tables adapter has real users. |
| 4 | Done for `filter.ts`; the departures components stay separate. |
| 5 | Narrowed: `natState(…, out)` replaces the exported `nat` global. |
| 6 | Done: `train_table[].ci` from the pipeline; client `classIndex` deleted; audit check. Pack data swap. |
| 7 | Narrowed: splitcheck only; the other copies use different formulas. |
| 8 | Decided: keep. `analyze-rs` / `paths` produce the router's baseline (documented in PIPELINE.md). |
| C | Done: audit `main` 782 → 40 lines; deterministic log. |
| F | Done: `flow_len` uses `pack::flow_count`; `sections()` input rule documented. |

## Follow-ups

- [ ] **Make `outline` deterministic.** Three runs on the same PBF gave
  391 / 390 / 388 rings (HashMap order when chaining ways into rings,
  `pipeline/outline/src/main.rs` ~line 185). The shipped
  `china-outline.json.br` is one such draw. Same fix as C: sort before
  chaining.
- [x] Commit a pack rebuild script: `scripts/rebuild_pack.sh` and
  `scripts/cmp_pack.mjs` (PIPELINE.md step 5 points to them).
- [ ] Optional, from the second review: `useAtlasData` returns 22 fields
  (one `Resource<T>` per file would be about 8); `row_path` takes 11
  parameters; router `graph::build` (399 lines) is worth splitting into
  stages if another OSM network or schedule source is on the roadmap.

## Priority 1: pipeline

- [ ] **3. Drop the web JSON tables decoder** (~1M in / ~10k out)
  - Production only reads safetensors (`web/src/data.ts:26-28`).
    `expandOutTables` and `expandInTables` live on only for
    `tests/fixture.ts` and `tests/columns.test.ts`.
  - Steps:
    - Move the fixture to `expandOutColumns`.
    - Keep the JSON-vs-columns equivalence check on the pipeline side only
      (`audit::check_columns`).
    - Drop the JSON exports from `web/src/lib/index.ts`.
  - Separate decision: whether to stop shipping
    `atlas-v2-*-tables.json.br`.

- [ ] **1a. Move leg walking from `atlas.rs` into a lib module** (2–3M in / 20–30k out)
  - `greedy_walk`, `orient_leg`, `Throats`, `row_path`, `partial_runs`,
    `chain_cuts` and `walk_edges` (`pipeline/analyze/src/bin/atlas.rs:263-740`)
    are pure functions sitting in a binary.
  - Move them to `analyze_rs::legwalk`. The `sec_of` closure parameter is
    already the seam the inline tests use (`atlas.rs:3585`, `:3634`), so move
    those tests with the code.

- [ ] **2. Typed pack reader** (10–18M in / 60–100k out)
  - The fmt-6 path encoding is: `s` = a section in stored order, `!s` = the
    reverse direction, an id `>= n` = a throat.
  - `atlaspack.rs` writes it. `audit.rs` decodes it again with untyped
    `serde_json::Value` helpers (`arr`, `int`, `ints`, `sec_of`), and
    `packdiff.rs` and `web/src/lib/decode.ts` decode it too.
  - Deepen `pack.rs`, which today only does file IO, into
    `Pack::load(dir)` returning typed tables and paths of
    `Step::Flow { sec, rev } | Step::Throat(id)`. Port `audit` and `packdiff`
    to it.
  - Settle the `Step`/`Pack` interface before delegating.

- [ ] **1b. Merge the outbound/inbound pairs in `atlas.rs`** (8–15M in / 40–80k out; use Fable, not Sonnet)
  - The pairs are `outbound_works`/`inbound_works`,
    `out_sections`/`in_sections` and `assemble_outbound`/`assemble_inbound`
    (~175 lines each).
  - First write down exactly what differs between the two directions. About
    194 lines still differ after stripping the direction words.
  - Then use one direction-parameterised implementation with two adapters
    (out and in).

## Priority 2: found in the second pass

- [ ] **4. Out/in duplication on the web side too** (~2–3M in / ~20k out)
  - `web/src/lib/filter.ts:148-200`: the per-section recount for deps and
    arrs is the same block written twice. Extract `countSections(rows)`.
  - `components/departures/`: `outCalls`/`inCalls` (261/268 lines) and
    `outDepartures`/`inArrivals` (204/216) are near-mirror pairs. Look at
    them after the filter fix, and merge only where the columns really match.

- [ ] **5. One train motion model, not two** (~2M in / ~15k out)
  - `timeline.ts` `trainState` (per-origin) and `national.ts` `natState`
    implement the same dwell-at-stops / linear-leg model on two data layouts.
    `national.ts:127` says so.
  - Both write to module-level scratch objects (`nat`, and the scratch in
    `timeline.ts:70`), so callers read hidden output.
    `labelsOverlay.ts:195-196` and `natTrain.ts:31-68` depend on that
    ordering.
  - Fix: one `motionAt(arr, dep, dist, t, out)` over stop arrays, with an
    explicit out-param. That keeps the allocation-free per-frame behaviour
    while making the output visible at the call site.
  - Check that the animation perf numbers (`web/tools/perf`) are unchanged.

- [ ] **6. The train-class table exists three times** (~1–2M in / ~10k out)
  - `pipeline/analyze/src/cn/classes.rs`: 7 classes, plus caps and groups.
  - `pipeline/router/src/classes.rs`: its own `class_index`.
  - `web/src/lib/origin.ts`: `FLOW_CLASSES` + `classIndex`, 8 buckets
    including `plain`. It is called from `filter.ts`, `useSelection.ts`,
    `DeparturesTable.tsx` and `useNationalTable.ts`.
  - Dumb-client fix: have the pipeline emit the bucket index per row
    (alongside or instead of `cls`). The client then only does lookups, and
    the class table lives in one Rust place shared by analyze and router.
  - This is a pack-format change, so it needs a fmt bump.

- [ ] **7. Haversine written seven times** (small; ~0.5M in)
  - The copies are `analyze/graph.rs:5`, `analyze/geo.rs:14`,
    `analyze/entries.rs:34`, `analyze/bin/legclass.rs:91`,
    `router/graph.rs:27`, `router/bin/splitcheck.rs:47` and
    `outline/main.rs:81`.
  - Within `analyze`, route all of them through `geo.rs`.
  - Check that the Earth radius and argument order match first. A different
    radius would move goldens, and that would need explaining, not
    accepting.

- [ ] **8. Two rail-graph builders: decide whether one is retired** (needs owner decision first)
  - `pipeline/analyze/src/graph.rs`: OSM parse, A*, Dijkstra. Used by
    `analyze-rs` main, `paths` and `osm_export`, which are PIPELINE.md
    steps 2–4.
  - `pipeline/router/src/graph.rs`: the corridor router's graph, behind
    `NetworkConfig`.
  - The atlas now takes leg paths from the router (`ATLAS_LEG_PATHS`).
  - If steps 2–4 no longer feed the live pack, retire `analyze/graph.rs` and
    the old `analyze-rs` port (`main.rs`, 1,580 lines). If they do, build
    them on the router's graph so there is one OSM to graph adapter.

## Leave alone (healthy)

- **Router.** `ScheduleSource` has two implementations (the timetable JSON
  loader in `china.rs`, and `export.rs`), so the seam is real.
- **`web/src/lib/mapModel.ts`.** Pure functions of `ModelState`, with
  dedicated tests.
- **`web/src/lib/nationalIndex.ts`.** Small functions over the shipped
  index, with a test file.

## Suggested order

3 → 1a → 2 → 1b, then 7 → 4 → 5 → 6. Item 8 waits on the owner's decision.
Each step makes the next agent's context smaller.
