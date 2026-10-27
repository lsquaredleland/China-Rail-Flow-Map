# Thin client: where the pipeline / client line should sit

Status (2026-10-27): **partly built.** Done: T0 (bench, `web/tools/bench`), the national
trains file (#16, PR #43), the 11k ingest (T5, on fmt 6) and the tables half of T4 (safetensors
columns, `docs/PACK_FORMAT.md`). Not started: T1 manifest, T2/T3 (the pipeline-owned facts:
ferry flag, class table, romanised names, section lengths, `boardAbs`, `firstVisit`) and the
geometry half of T4. The text below is the original audit. It reviews the
owner's "make the client as dumb as possible" premise (2026-10-25), sets out the target data
contract between the Rust pipeline and the web client, audits every client-side derivation on
`deckgl` @ `58426d1` against it, and sequences the moves against the deck.gl plan
(`docs/history/DECKGL_MIGRATION.md`, Phases 2–3, G-MAIN) and the incoming ≈ 12,000-train data.

Every number is tagged **[measured]** (this audit, bun 1.4.4 / node 22 on an M4 Max, scripts in
the session scratch directory `scratchpad/thinclient/bench/{measure,columnar}.ts`, not
committed) or **[estimate]** (with the arithmetic shown). Pack = the committed fmt 6 pack in
`web/public/assets` (7,157 trains, 102 origins, 7,922 sections).

---

## 1. Premise review

### 1.1 The premise and the four rules as stated

> "Ideally we should make the client as dumb as possible (there is a trade-off on how much data
> is loaded into the client, but we can assume the client can load a lot of data and we're not in
> a constrained environment)."

1. Same answer for every user (routing, geometry, counting, dedup, joins, whole-train paths,
   stop distances, classification) → Rust pipeline, with goldens.
2. Depends on interactive state (camera, selection, hover, labels, styling, animation time) → client.
3. Where they meet, the pipeline ships factored ingredients and the client does trivial
   reductions (lookup, sum over a factored dimension, lerp between keyframes). A client
   algorithm that encodes a rail rule is a smell.
4. Ship render-ready, section-parallel, pre-projected, `fmt`-versioned data; possibly binary.

### 1.2 What holds

- **Rule 1 holds for facts about the data, and the code already mostly obeys it.** Routing,
  section geometry, flow counts, per-train paths, stop positions, chord legs and the national
  table are all Rust (`pipeline/analyze/src/bin/atlas.rs`, `flows.rs train_edges` as the one
  counting rule). The client never routes or counts from scratch in the common path.
- **Rule 2 holds without qualification.** `lib/mapModel.ts`, `labels.ts`, `pick.ts`,
  `camera.ts`, `tooltip.ts` are functions of selection, camera and clock. None of it could be
  precomputed: the state space (camera × selection × filter × time) is unbounded.
- **Rule 3 is the right shape and is what justifies the biggest client computations.**
  `getDestSectionCounts` (`mapModel.ts:100-153`) is a count over shipped per-train paths cut at
  a shipped `secCnt`; `filterOrigin` (`filter.ts:144-212`) is a sum over shipped `byClass`
  columns or a recount over shipped paths; `stopEffects.ts` compares shipped minutes. Shipping
  these pre-reduced would be combinatorial (§1.3 (a)). Rule 3 is what keeps them legitimate.
- **Rule 4 holds, with the recommendation sharpened in §2.2:** the win from binary is parse
  time and heap, not transfer size.

### 1.3 Where "dumb client" goes too far, and what the measurements say

**(a) Combinatorial explosion is real for every selection-dependent reduction.** The animated
flow table alone is 4,286 sections × 818 steps × 2 B ≈ 7.0 MB for 广州 **[measured]**; over 102
origins ≈ 700 MB. Per-destination section counts are Σ over 210,196 call rows of the path
length to the stop, ≈ 10 M entries **[estimate: 210 k calls × ≈ 50 sections]**. Filtered views
(class × hour × distance bin × duration bin × train code × direction) are unbounded. None of
these can move. **Rule 3 is not an escape hatch; it is the main rule for the hot path.**

**(b) Latency on interaction is not the problem.** Every client derivation measured is cheap on
desktop: `buildOrigin` 3.8–9.7 ms, `buildDayTimeline` 33–37 ms, `filterOrigin` 1.3–2.2 ms and
its subset timeline 12–22 ms, `getActiveTrains` ≤ 1.4 ms, `buildNational` 17.8 ms,
`natPositions` 2.9 ms for 2,668 dots **[measured]**. Phones are 5–10× slower **[estimate]**,
which puts the timeline build at 0.2–0.4 s on an origin switch, acceptable. Moving computation
to Rust is **not** justified by speed; it is justified by (c) and (d).

**(c) Memory is the problem, and it is the JSON object heap, not the computation.**
Parsing the five JSON packs retains **≈ 120 MB** of JS heap (shared 4.9, out-map 25.2,
out-tables 29.8, in-map 25.1, in-tables 29.3, schedules 5.9) **[measured, bun]**, and
`expandOutTables` / `expandInTables` add **29.0 + 25.5 MB** of per-row copies on top
**[measured]**. The same out-tables content as typed-array columns is **4.25 MB** raw
**[measured, variant B below]**. At 12 k trains the JSON heap scales to ≈ 200 MB + 90 MB of
expansions **[estimate, ×1.68]**, against the deck plan's phone budgets (D8, M3). This is the
strongest argument for rule 4 and it has nothing to do with where logic lives.

**(d) Transfer size barely moves with binary.** Brotli q11 of out-tables **[measured]**:

| Encoding | raw | brotli | gzip |
|---|---:|---:|---:|
| Shipped JSON (`atlas-v2-out-tables.json.br`) | 9,747 KB | **1,602 KB** | — |
| A: int32 columns (paths, stop_pos u16, deps 9×i32, calls 6×i32) | 8,992 KB | 1,372 KB | 2,247 KB |
| B: narrow columns (paths i16, deps/calls u8/u16/i16) | 4,253 KB | **1,245 KB** | 1,857 KB |
| C: B + delta-coded paths (i16) and stop_pos (u8) | 4,186 KB | 1,236 KB | 1,807 KB |

Shared section geometry (7,922 polylines, 75,044 points) **[measured]**: polyline strings 194 KB
brotli; int32 absolute 1e4 224 KB; **int16 deltas + int32 first point 197 KB**; float32 307 KB.
So binary columnar saves ≈ 22 % of out-tables transfer and ≈ 0 % of geometry. Brotli already
removes the JSON syntax. The cost it does remove is the **19 ms parse + 30 MB heap per tables
file [measured]** that becomes a zero-copy view, and the 55 MB of `expand*Tables` copies that
become offset arithmetic. Any "binary for size" argument should be dropped from the premise;
"binary for memory and cold start" stands.

**(e) Pack churn is the real tax of rule 1 taken literally.** Every rule moved into the pipeline
becomes a pack rebuild, a goldens rebase and an **owner-approved swap** (`docs/PIPELINE.md` §3,
staging discipline). Today a client-side rule change ships on `main` with a bun test. The deck
plan already has three independent pack changes queued (P3.1 national flows, the P2.2 national
trains file, P1c.3 re-baseline). If presentation constants (ease curves, colour ramp, radius
curve, label tiers) were baked in the pipeline, the owner's "colour/copy tweaks go straight to
main" rule would stop working. **Hence the third category in §1.4.**

**(f) Testability cuts both ways.** Rust gets `audit`'s independent recount and `goldens.json`;
but the bun tests run against the real committed pack (`web/tests/fixture.ts`) and the timeline
snapshots (`snapshots.test.ts`) pin the per-section flow at four clock times per origin, so they
are goldens too. The gain from moving a rule is **one copy** of it (today `count once per
train` exists in Rust `flows.rs:21`, in `mapModel.ts:120-125`, `filter.ts:152`, `timeline.ts:440-451`
and `audit.rs`), not better tests.

**(g) The deck.gl binary-attribute path wants what rule 4 says, and already has half of it.**
`DecodedSet {pts: Float32Array, off, len}` (`types.ts:220-226`) is the GeoArrow LineString layout
(flat coordinates + offsets) and is uploaded once per set as `startIndices` (C19). The flow
pass builder `assemble()` (`deck/layers/flows.ts:96-140`) copies subsets per pass. The missing
piece is that the client still *decodes* into this layout from polyline strings (10.8 ms
`prepAtlas` **[measured]**) instead of receiving it.

**(h) Cold start, mobile, DPR and GPU.** The GPU side is solved (M4 after the P1c.1 fix: 14.7 MB
at DPR 2). The CPU side is the JSON heap in (c): on a 4 GB Android, 175 MB of JS heap for
both directions is the number that will show up as tab eviction, not frame time.

**(i) Cache and immutability on Vercel.** Packs are content-hashed under `/assets/` with
`immutable` (`web/bundle.mjs:10-25`, `web/vercel.json`). Binary files only need a
`Content-Type` header rule (today only `.json.br` gets `Content-Encoding: br`) and a
`staleReload.ts` pattern for the new extension. No architectural change.

**(j) The incoming ≈ 12 k trains** scale every per-train array by ≈ 1.68 (out path entries
670,796 → ≈ 1.13 M; national refs the same; out-tables JSON ≈ 2.7 MB brotli vs ≈ 2.1 MB
columnar; JSON heap ≈ 50 MB per tables file) **[estimate]**. Nothing breaks, but the 12 k pack
should be the first one born in the new container so there is one swap, not two (§4).

**(k) The OSM-portability plan is the strongest argument in the owner's favour, aimed at the
wrong target.** What stops this client from being applied to another network is not that it
computes too much; it is that it knows **China facts** that belong in the data:
the Qiongzhou ferry is a hard-coded lat/lon box (`lib/ferry.ts:6-27`); train classes and their
speed groups are literals in six places (`origin.ts:19-49`, `deck/layers/trains.ts:25-29`,
`tooltip.ts:122`, `national.ts:59`, `filter.ts:224/257`, `mapModel.ts:348`); romanisation fixes
live in `format.ts enName`; the default origin is `"广州"` (`useAtlasData.ts:263`); the label
format is `en · zh`. A clean data contract (§2) removes these; moving `flowPasses` to Rust would
not.

### 1.4 Refined principle: three categories, not two

The owner's rules split the world into facts and interaction. The audit needs a third bucket:

| Category | Definition | Lives in | Why |
|---|---|---|---|
| **Data fact** | Same answer for every user **and** independent of design choices: routing, geometry, per-edge counts, joins, paths, stop positions, distances along track, classification, place names | Pipeline, goldens | One copy; audited; portable to other networks |
| **Presentation function** | Same answer for every user **but** a design choice: easing curve, tail length, colour ramp, `stationR`, label tiers, 5-min step, 10/8-min boarding dwell, dim alphas | Client, pure `lib/*`, bun tests | Changes with design, must not cost a pack swap; needs no rail knowledge |
| **Interactive reduction** | Depends on camera / selection / filter / clock | Client, pure `lib/*` | Unbounded state space |

**Checkable rules (each with its reason):**

- **R1 Facts in Rust.** If a client function would give a different answer on another
  railway's data without any code change being *wanted*, it is a fact and belongs in the
  pipeline. *Reason:* portability (k) and one copy (f). *Check:* grep the client for literal
  coordinates, class letters, place names, kilometre constants. Must be zero outside tests.
- **R2 Presentation in the client, as pure functions of shipped numbers.** *Reason:* (e); the
  owner's direct-to-main rule for tweaks. *Check:* no presentation constant appears in
  `pipeline/`; `atlaspack` output contains no colours, pixel sizes, or easing parameters.
- **R3 Reductions only over shipped dimensions.** A client reduction may filter by equality on
  shipped ids, cut at a shipped count/position, sum or count shipped columns, and binary-search
  shipped monotone arrays. It may **not** dedupe, re-join by name, or re-derive a quantity the
  pipeline has. *Reason:* rule 3, sharpened so that "dedupe per train" (a counting rule) is
  caught. *Check:* every `new Set(` and `.find(... === ...zh)` in `web/src/lib` needs a comment
  naming the shipped field that makes it unnecessary, or a task to remove it.
- **R4 Ship the layout the renderer uploads.** Flat typed arrays + offsets, section-parallel,
  one numbering per pack. *Reason:* (c), (g). *Check:* no `JSON.parse` of a file over 1 MB; no
  per-row `slice()`/`map()` copies at load (`expandOutTables` is the counter-example).
- **R5 One pack identity, checked everywhere.** Every file carries `fmt` **and** a pack id; the
  client refuses mixed ids. *Reason:* section indices are only meaningful against one shared
  file (already the case; `fmt` alone cannot tell two fmt-6 packs apart after a partial swap).
- **R6 Every move is guarded twice.** A fact moved to Rust gets an exact golden in
  `goldens.json` **and** a client oracle test that compares the old client derivation to the
  shipped field on the committed pack before the client code is deleted (the P2.1 pattern).
  *Reason:* byte-identical-or-re-baseline discipline from `history/DECKGL_MIGRATION.md` §4.
- **R7 Pack changes are batched.** Additive fields ride together in one fmt bump and one swap.
  *Reason:* (e).

**Where the line actually sits:** everything that is a function of (schedule, OSM) alone goes
to Rust, including per-train cumulative distances and stop distances (today client), ferry
identification, class table, names; everything that is a function of (shipped numbers, design
constants) or of (shipped numbers, interaction) stays client, including the whole timeline
motion model, flow passes, labels, picking, histograms. The client becomes **a pure
interpreter of a self-describing pack**, not a dumb one.

---

## 2. SOTA target design

### 2.1 What we borrow, from where

| System | What it does | What we take | What we do not |
|---|---|---|---|
| **Vector tiles / MVT** | Build-time cut, render-ready, integer-quantised geometry per tile | Integer-quantised geometry (we are already at 1e4), render-ready attribute columns, nothing computed at load | Tiling: 7,922 sections / 75 k points fit in one buffer; tiles only pay off above ≈ 50 k sections or if 12 k trains bring per-train vertices |
| **PMTiles v3 / Protomaps** | One immutable archive on static hosting, HTTP range requests, small header first | Immutable hashed files (have), a small **manifest first** that names every other file and its byte size/hash (§2.3); later, optionally, one archive with ranges | Range requests now: Vercel + brotli per file already gives us per-file laziness |
| **Static-site generation** | All derivations at build, output is data | `atlas` → `atlaspack` → `audit` is exactly this; keep it the only place facts are computed | — |
| **deck.gl binary attributes / TripsLayer** | Typed arrays with `startIndices` uploaded once; trajectories as vertices + timestamps interpolated on the GPU | The flat-coordinates-plus-offsets layout as the **wire** format (not just the decoded one); per-train `pStart` cumulative distances shipped so position-at-distance is two binary searches | TripsLayer's per-vertex timestamps (180–400 MB GPU, D2 off) |
| **Arrow / GeoArrow / FlatGeobuf** | Columnar, typed, zero-copy; GeoArrow LineString = coordinates + offsets; FlatGeobuf adds a spatial index | The column model and offsets (our `DecodedSet` already is one); little-endian typed arrays described by a JSON header | The Arrow IPC container and Arrow JS (≈ 100 KB+ dependency, dictionary/validity machinery we do not need); FlatGeobuf's R-tree (whole network is always drawn) |
| **kepler.gl / DuckDB-WASM** (contrast) | Load raw tables, compute aggregates in the browser | Nothing structural; they are the right tool for ad-hoc analysis of unknown data | Their cost model: 5–10 MB of wasm/JS and a GB-class heap are fine for an analyst, wrong for a curated public map on phones |

### 2.2 Pack layout and format: recommendation

**Keep JSON for small, human-read, dictionary-shaped data; move every large numeric array to a
minimal binary-columnar container; keep brotli.**

Recommended container ("TA1", typed-array sidecar): one file per logical table, bytes =
`[u32 header length][JSON header][padding to 8][body]`, where the header is
`{fmt, pack, columns: [{name, type: "i16"|"u16"|"i32"|"u32"|"f32"|"u8", length, offset}]}` and
the body is the little-endian columns, each 8-byte aligned. The client does
`new Int16Array(buf, offset, length)` per column: zero copies, zero parse. Rust writes it with
`to_le_bytes`; `audit` and `scripts/check_pack_roundtrip.mjs` read it. Determinism is trivial
(no float formatting, no key order).

Why not Arrow IPC: interoperability with Arrow tooling is not a goal (no DuckDB, no Parquet),
Arrow JS adds a dependency and a parse step, and GeoArrow's deck.gl layers target MapLibre-style
lon/lat layers, while this map renders in its own `OrthographicView` with our own layer stack.
The TA1 header is < 2 KB and readable with `jq`; if Arrow interop ever matters, the body is
already Arrow-shaped and a converter is small. **Risk acknowledged:** a home-grown format is
one more thing to document; the mitigation is that the Rust writer and the TS reader are each
≈ 60 lines and the header is JSON.

Why keep brotli: measured ratios of 3.4–7.6× on the columns; Vercel serves `.br` with
`Content-Encoding` already (`web/vercel.json`); add a `Content-Type: application/octet-stream`
rule for the new extension.

**Target file set (fmt 7+; names indicative):**

| File | Format | Contents | Load |
|---|---|---|---|
| `atlas-manifest.json` | JSON, ≈ 2 KB | `pack` id (hash of inputs), `fmt`, file list with sizes/hashes, counts (sections, trains, origins), **class table** `{letter, label, speedGroup}` in flow-row order, `extent` (replaces `prepAtlas` padding), default origin index, `build` provenance, `defaults` (ferry style flags etc. as *data*, not style) | First |
| `atlas-shared.json` | JSON | `city_table`, `station_table`, `train_table` (names, `en` **already romanised**), origins' identity rows | First |
| `atlas-geometry.ta1` | TA1 | `sec`, `inSec`, `net`, `thr` as int16-delta coordinates + int32 first points + u32 offsets (decoded to Float32 in ≈ 1 ms), `hsr: u8`, `ferry: u8`, `secLenM: u32` (track length per section in metres from OSM, **not** from simplified geometry), `cumLen: u32` per vertex | First |
| `atlas-out-map.ta1` / `in-map.ta1` | TA1 | per origin: flows as section-parallel sparse `(s: u16, total: u16, byClass: 8×u16)` columns with origin offsets; dests/srcs as 8 columns; chords | First (active direction) |
| `atlas-out-tables.ta1` / `in-tables.ta1` | TA1 | paths (i16) + offsets; `pStart: f32` cumulative km per entry (**moved from client `prepTrainPath`**); `stop_pos` (u16) + offsets; stop distances; `firstVisit: u8` bitmask per entry (R3: removes client dedupe); deps/arrs 9 columns; calls 6 columns + list offsets; `dep_off` | Lazy, behind first paint (as today) |
| `atlas-schedules.ta1` | TA1 | rows as 5 columns + per-train offsets; minutes **absolute since the train's first-day midnight** so the frame shift (`timeline.ts:397-398`, `national.ts:72`) is a single shipped `boardAbs` subtraction | Lazy (with out-tables, as today, O16) |
| `atlas-national.ta1` | TA1 | P3.1 `total`, `by_class` as u16 columns (today 18.8 KB JSON brotli; fine either way) | National mode only |
| `atlas-national-trains.ta1` | TA1 | The in-progress Rust whole-train paths: paths, `pStart`, stop_pos, stop distances, chords, `extra` geometry, class index, `startAbs`/`endAbs` minutes | National mode only |

Estimated sizes **[estimate from the measured variant B and ratios]**: geometry ≈ 0.5 MB br
(4 sets), out-map ≈ 0.45 MB, out-tables ≈ 1.3 MB (+ `pStart` f32 ≈ 0.6 MB raw / ≈ 0.4 MB br),
schedules ≈ 0.35 MB. Total first paint ≈ 1.0 MB br (today 1.07 MB: shared + out-map + outline);
total session (both directions) ≈ 5.2 MB br (today 5.4 MB). Heap after both directions
≈ 25–30 MB of typed arrays **[estimate: Σ raw column sizes]** versus ≈ 175 MB JSON objects
**[measured]**. At 12 k trains: ≈ 45 MB vs ≈ 290 MB **[estimate]**.

### 2.3 Versioning and schema

- `fmt` stays the **breaking** version; every file carries it (as today, `requireFmt`).
- `pack` (new) is the identity of one build (hash of `shared.build` inputs + pipeline tree);
  every file carries it; the client refuses a file whose `pack` differs from the manifest's.
  This closes the partial-swap hole that `fmt` alone leaves.
- The manifest lists file names **with** their content hashes, so `bundle.mjs` can derive the
  hashed asset names from it instead of hashing at build (either works; the manifest makes the
  pack self-describing outside the web build, e.g. for `audit`).
- Schema documentation moves from the `atlaspack.rs` header comment to the header JSON itself
  (`columns[].doc` one-liners) plus `docs/PIPELINE.md`.
- Compatibility: the client supports exactly one `fmt`. A pack swap and the client that reads
  it deploy together (as today).

### 2.4 Loading strategy

| Phase | Files | Trigger | Today |
|---|---|---|---|
| 0 | manifest | page load | — (new; ≈ 2 KB, can be inlined in `index.html` by the build to save a round trip) |
| 1 | shared tables, geometry, active direction's map | with 0 | same (shared + out-map), first paint |
| 2 | active direction's tables + schedules | immediately behind 1 | same |
| 3 | other direction map, then tables | first flip | same |
| N | national flows, national trains | entering national mode (or `requestIdleCallback` prefetch after phase 2 on desktop; never on `saveData`) | national flows: `feat/national-lib` lazy loader; trains: not yet |

Binary files make phases 2–3 cheaper to hold (views, not objects), so the **12 k pack can keep
the same staging**. If first paint ever needs to shrink, the next lever is splitting the
`in`/`out` map files per origin (102 small files, PMTiles-style ranges) — not justified today.

### 2.5 What the client may and may not compute

| May (interactive or presentation) | May not (fact; ship it) |
|---|---|
| Flow passes, alphas, widths, colour ramp, dimming (`mapModel.flowPasses`) | Section lengths / cumulative distances along a path (`prepTrainPath`, `getSecGeometry`) |
| Destination window and stop effects (`stopEffects.ts`) | Which sections are ferries, where the water leg is (`ferry.ts`) |
| Position at a route distance, easing, dwell state, wrap-around (`trainState`, `natState`, `natXY`) | Class → speed group, class labels, class order |
| Label candidates and placement; tooltip text; picking priority | Romanisation / display names |
| Histogram bins, filter predicates, sorting, search haystack | Day-frame shifts of schedule minutes |
| Sums / counts over shipped per-train paths cut at shipped `secCnt` | Per-train "count once" dedupe (ship `firstVisit`) |
| Camera maths, fit, clamps, scale bar | Data extent (ship in manifest) |
| Decoding typed-array views; converting int16-delta geometry to Float32 | Polyline string decoding, JSON delta decoding of flow rows |

---

## 3. Audit inventory

Legend. **Class:** F = data fact, P = presentation function, I = interactive reduction, D =
decoding. **Verdict:** move = move to pipeline; keep = stays; shape = keep the logic, change
the data it reads. Size/memory are for the committed pack unless marked 12 k.

| # | file:function | What it computes | Class | Verdict | Size / memory impact | Risk | Guards (tests, goldens) |
|---|---|---|---|---|---|---|---|
| 1 | `lib/decode.ts:decodeFlat/decodeSet` (`prepAtlas`) | Polyline strings → `Float32Array` + offsets + bboxes + hsr | D | **shape**: geometry shipped as int16-delta columns; client does one delta pass to Float32 (≈ 1 ms **[estimate]** vs 10.8 ms **[measured]**) | transfer ≈ 0 (194 → 197 KB br **[measured]**); heap −4.9 MB JSON objects, same Float32 | Low: a lossless re-encoding; the 1e4 grid is unchanged | New `decode.test.ts` case: decoded Float32 byte-identical to today's for all four sets; `shots` zero-diff |
| 2 | `lib/decode.ts:decodeFlows` + `data.ts:fetchOutMap` | Undo delta coding of flow rows | D | **shape**: columns need no delta coding | — | Low | `decode.test.ts` existing rows |
| 3 | `lib/decode.ts:expandOutTables / expandInTables` | Per-row `dep_secs`, chord legs, `dep_stop_pos` as sliced copies of per-train paths | D | **shape → delete**: rows become `(t, dep_off)` lookups into the path columns; `DepVM.secs/path/stopPos` become views or `(off,len)` pairs | **−29.0 / −25.5 MB heap, −9.1 / −6.5 ms [measured]**; at 12 k −49 / −43 MB **[estimate]** | Medium: `DepVM.secs` is read in 9 places (`mapModel`, `filter`, `timeline`, `origin`, `interaction`); the type change is mechanical but wide | `audit.rs:expand_tables` already proves rows are slices; `snapshots.test.ts` (timeline) and `mapModel.test.ts` (dest counts) unchanged |
| 4 | `lib/decode.ts:decodeSecs` | Drop throats, split sign into `secs` + `revs` | D | keep as a view helper (throat ids ≥ n is a pack convention, documented) | — | Low | existing |
| 5 | `lib/origin.ts:buildOrigin` deps/arrs join | `train_table`/`station_table`/`city_table` joins, `fmtClock`, `hay`, `distKm` haversine fallback, `dayOff = floor((dep+dur)/1440)` for arrs | F (joins, `distKm`, `dayOff`) + P (`hay`, formatting) | **shape**: joins stay (lookups by shipped index are R3-legal); `distKm` fallback → ship crow km per row (`atlas.rs` has it); `dayOff` → ship (atlaspack dropped it, trivially recomputed; fine either way) | ≈ +60 KB br per tables file for crow km **[estimate: 30 k rows × u16]** | Low | `snapshots.test.ts`; new golden `rows_with_unrouted_km` |
| 6 | `lib/origin.ts:buildOrigin` flows → `FlowVM.byClass`, sort widest first | Expand 8 class columns, sort | I/P | keep (sort is paint order, presentation) | — | — | `mapModel.test.ts (a)` |
| 7 | `lib/origin.ts:buildOrigin` `nn` nearest-neighbour per dest (`origin.ts:181-191`, `325-335`) | O(n²) nearest dest distance in degrees for label ordering | F (geometry) used by P (labels) | **move** (cheap): ship `nn` per dest row, or compute once in Rust per origin; 600² per origin is fine on the client too, so low priority | ≈ 2 B × 60 k dest rows | Low | `labels.test.ts` placement unchanged |
| 8 | `lib/origin.ts:buildOrigin` `arrTimes` | Sorted absolute arrival minutes per dest | I (sort of shipped minutes) | keep | — | — | `mapModelStations.test.ts` |
| 9 | `lib/format.ts:enName` | Romanisation corrections to `en` names | **F (names)** | **move**: fix in the gazetteer (`cn::station_en`, `cn::gazetteer`) so the pack ships display names | 0 | Low; a one-time rename in data | New golden `city_en_fixed = 0` (no `enName` rewrites left); `tooltip.golden.json` |
| 10 | `lib/timeline.ts:getSecGeometry` | Haversine section lengths and per-vertex cumulative km from **simplified 1e4 geometry** | **F** | **move**: ship `secLenM` + per-vertex `cumLen` from the pipeline's OSM node geometry. Also fixes a latent inconsistency: the dot's distance space (simplified geometry) disagrees with the shipped `km` column (true track) | `cumLen` u32 per vertex: 75 k × 4 B = 300 KB raw, ≈ 120 KB br **[estimate]** | Low–medium: dot speeds change by the simplification error (sub-1 % **[estimate]**); animation shots re-baseline | Oracle test: client `getSecGeometry` vs shipped within 1 % before deletion; new golden `sec_len_sum_km` |
| 11 | `lib/timeline.ts:prepTrainPath` | Per-train cumulative start distance of every path entry (`pathStarts`, `secStarts`), chord virtual lengths (widest join rule), throat spans, stop distances (`virt`/`virtStop` rule) | **F** (the chord-gap and stop-position rules are rail rules) | **move**: ship `pStart: f32` per path entry and `stopDist: f32` per stop (both directions, and in the national trains file). Client keeps only the `ChordSpan`/`ThroatSpan` *views* (derivable by scanning `pId` and `pStart`) | +670,796 × 4 B = 2.7 MB raw, ≈ 0.6–1.0 MB br **[estimate; cumulative floats compress poorly; a u32 metre column with delta coding would be smaller]**; at 12 k ×1.68 | Medium: this is the single largest client rail rule; `national.ts:63` and `timeline.ts:366` both call it | P2.1 oracle pattern: shipped `pStart` vs client `prepTrainPath` ≤ 1e-6 km on all 7,157 trains; `snapshots.test.ts`; `national.test.ts (c)`; new goldens `path_total_km_sum`, `stop_dist_regressions = 0` |
| 12 | `lib/timeline.ts:buildDayTimeline` schedule frame shift (`rel`, lines 393-414) | Convert schedule minutes (train's first day) into the boarding day's frame | F (time arithmetic on shipped data) duplicated in `national.ts:72` | **shape**: ship schedule minutes absolute from first-day midnight and `boardAbs` per dep row; client subtracts once | ≈ 0 | Low | `animation.test.ts`, `snapshots.test.ts` |
| 13 | `lib/timeline.ts:trainState` | Motion model: linear legs (the ease was removed 2026-10-25), dwell detection, 10/8-min boarding/alighting | **P** | **keep** (owner may change the feel without a swap) | — | — | `animation.test.ts` |
| 14 | `lib/timeline.ts:buildDayTimeline` `trainEntries` / `secFlowSteps` (lines 438-497) | First-entry minute per (train, section) via `timeAtDist` (bisection on the ease curve); cumulative count per 5-min step | P (depends on the ease) + I (per filtered subset) + R3 dedupe (`seenSecs`) | **keep**, with the dedupe replaced by the shipped `firstVisit` flag (R3) | 7.0 MB Uint16 per origin **[measured]**; could be `Uint16Array(numSteps)` per *flow section* only (already) | Low | `snapshots.test.ts` pins `@06/@12/@18/@24` per section |
| 15 | `lib/timeline.ts:getActiveTrains` | Position, heading, dwell state, progress per active train per frame | I | keep | 1.4 ms / 292 dots **[measured]** | — | `animation.test.ts` |
| 16 | `lib/national.ts:buildNational` | Per-train refs + `pStart` (via #11) + stop times for every train in out-tables; **misses the stretch before a train's first featured origin** (the Rust national-trains file fixes this) | F | **move**: consume the Rust national trains file; delete the path prep; keep #17 | heap 9.0 MB **[measured]** → ≈ 12 MB raw typed columns incl. heads **[estimate]**; build 17.8 ms → ≈ 0 | Low once the Rust file lands | `national.test.ts (a)(b)(c)`; P3.1-style goldens `national_trains_paths`, `national_trains_total_km` |
| 17 | `lib/national.ts:natState / natXY / natPositions` | Dwell/ease state at absolute minute, position by two binary searches, wrap-around (`m + 1440k`) | P + I | keep | 2.9 ms / 2,668 dots **[measured]** | — | `national.test.ts` |
| 18 | `lib/national.ts:59` class → `cls` 0/1/2 | `"GDC"` / `"ZTKS"` literals | **F** | **move**: `speedGroup` from the manifest class table | 0 | Low | `national.test.ts` |
| 19 | `lib/mapModel.ts:getDestSectionCounts` | Per selected city: count of its trains on each section, cut at `secCnt`, **dedupe per train** (`seen`) | I + R3 dedupe | **keep**; dedupe → `firstVisit` | O(calls × secCnt) per selection; cached | Low | `mapModel.test.ts (b)` |
| 20 | `lib/mapModel.ts:getActiveDestSectionCounts` | Same, time-gated by `trainDistAt` vs `secStarts` | I | keep (reads #11's `secStarts`, which becomes shipped `pStart`) | per frame while a destination is selected and playing | — | `mapModel.test.ts (e)` |
| 21 | `lib/mapModel.ts:flowPasses` and the visibility rules (`isFilteredView`, context/focus alphas, `activeFlows` by step, caps `min(active, destN)`) | Which passes, items, alphas | I/P | **keep**. Smell to fix client-side: `isFilteredView` (`mapModel.ts:65-76`) *infers* "a filter is active" from array lengths; make it explicit state from `useSelection` | — | Low | `mapModel.test.ts (a)–(g)` |
| 22 | `lib/mapModel.ts:isolatedCorridor`, `pickableFlows`, `highlightSegN`, `chordPlan/chordVisible`, `infraPasses` | Isolation progress, pickability, chord gating by first departure | I | keep | — | — | `mapModel.test.ts (d)(f)`, `pick.test.ts` |
| 23 | `lib/mapModel.ts:stationStates` + `lib/stopEffects.ts` (destination window, `stopArrivalTimes`, `trainShownAt`) | Which trains exist at minute t under a selection; ripple timing; dot growth | I | **keep** (the `82e0f22` rule is interactive by nature) | — | — | `stopEffects.test.ts`, `mapModelStations.test.ts`, `mapModel.test.ts (h)` |
| 24 | `lib/mapModel.ts:computeCityAllowedArrivalTimes` inbound branch (`unrolled` day search, lines 665-681) | Guess the day of a boarding time by scanning `d = 0..4` | **F** (time arithmetic the pipeline knows exactly) | **move**: ship `boardAbs` per in-call row | ≈ 0 | Low | `mapModelStations.test.ts` inbound case (add) |
| 25 | `lib/filter.ts:filterOrigin` | Class sum over `byClass`; **recount over paths** for hour/dist/dur/code filters (`new Set(d.secs)`, lines 149-167); dest stats (`fast` via `["G","D","C","S"]`, fastest, median) | I + R3 dedupe + F (class group literal) | **keep**; dedupe → `firstVisit`; `fast` → manifest `speedGroup`. Add a test: `filterOrigin(cur, {hour: all 24})` recount equals shipped `flows` for every origin (today only `audit.rs` checks this relation, and only for the national file) | 1.3–2.2 ms **[measured]** | Low | New `filter.test.ts` recount-equals-shipped; existing `headingCount.test.tsx` |
| 26 | `lib/filter.ts` and `Histograms.tsx` `0.621371` + bin maths | km→mi and binning | P/I | keep; one copy (`lib/format.ts`) | — | — | existing |
| 27 | `lib/ferry.ts:isFerrySection / isWaterCross / splitFerry` | Which sections cross the Qiongzhou Strait and where the water leg is, by **hard-coded lat/lon** | **F** | **move**: `ferry: u8` per section (router leg status `"ferry"`, `railway=ferry` ways) and split the water leg into its own section (or ship `waterRange` per ferry section) | ≈ 8 KB | Low; 2–3 sections | `ferry.test.ts` becomes "shipped flags select exactly today's sections"; golden `ferry_sections = N` |
| 28 | `deck/layers/flows.ts:assemble` | Copies section vertices into per-pass buffers in paint order; ferry land/water substitution | I (paint order) | keep; with #27 the ferry substitution is a flag test | 0.25–0.33 ms **[measured, plan]** | — | `layers.test.ts` |
| 29 | `deck/layers/flows.ts:blendOver` (D3), `flowColor`, `WIDTH_K`, `flowWidth`, `stationR`, `stationZoomK`, tail lengths, ring radii | Styling | P | keep | — | — | `palette.test.ts`, `layers.test.ts`, shots |
| 30 | `deck/layers/trains.ts:glowOf`, `tooltip.ts:122`, `mapModel.ts:348` | High-speed vs conventional by class letter | **F** → P | **shape**: colour by manifest `speedGroup`, not by letter | 0 | Low | `tooltip.golden.json`, shots |
| 31 | `lib/labels.ts:placeLabels` | Candidate tiers by zoom, collision placement, terminus priority | I + P | keep | ≤ 60 labels | — | `labels.test.ts` |
| 32 | `lib/labels.ts:86` label text `en · zh` | Bilingual label format | P with a China assumption | keep, but read the two name columns from the manifest-declared `nameFields` so another network can ship one name | 0 | Low | `labels.test.ts` |
| 33 | `lib/tooltip.ts:tooltipHtml` | HTML strings; `isOrigin` by **name match** (`tooltip.ts:59`) | P + F (join by name) | keep; ship `originIdx` per city (−1 when not an origin) and drop the name join | ≈ 1 KB | Low | `tooltip.test.ts` golden |
| 34 | `lib/pick.ts:pickPriority`, `interaction.ts:pickDeck` (`idxToSec`) | Hit priority, exact distances, index mapping | I | keep | 0.4–0.6 ms **[measured, plan]** | — | `pick.test.ts`, P1b.4 driver |
| 35 | `lib/camera.ts` (fit, clamps, `viewToViewState`) and `prepAtlas` extent padding (`decode.ts:137-140`) | Camera maths; data extent | I; extent is F | keep; extent → manifest | 0 | Low | `camera.test.ts` |
| 36 | `hooks/useAtlasData.ts` staged merge (`Object.assign` into origins) | Merge four files by index into one origin object | D | **shape**: with columnar files, origins become `(origin index → column ranges)`; no merge | — | Medium (touches `RawOrigin` typing throughout) | typecheck; `decode.test.ts` |
| 37 | `hooks/useAtlasData.ts:263` default origin `"广州"`; `App.tsx` | Default view | F (data default) | manifest `defaultOrigin` | 0 | Low | — |
| 38 | `TrainScheduleModal.tsx` + `format.ts:formatScheduleStops` | Dwell minutes, day labels from schedule rows | P | keep (with #12's absolute minutes it loses the frame logic) | — | — | existing |
| 39 | `Histograms.tsx` hour/dist/dur bins, `HeadCount`, `stationBreakdown` | Counts for the panels under filters | I/P | keep | — | — | `headingCount.test.tsx`, `stationBreakdown.test.ts` |
| 40 | `data.ts:fetchData` (brotli sniff `0x7b`, JSON fallback) | Transport | D | shape: sniff by file kind; `.ta1` has a magic header | — | Low | `staleReload.test.ts` |

**Pipeline outputs the client ignores or re-derives**

| Output | Where | Client today | Note |
|---|---|---|---|
| `shared.build` provenance | `atlaspack` | ignored | fine; move into the manifest |
| `atlas-v2-national.json` (P3.1) | staged, not shipped | not read (P3.2 pending; `feat/national-lib` has the loader) | — |
| `calls[].sec_cnt` | always present since v2 | optional with fallback `deps[...].secs.length` (`origin.ts:165-170`, `312-317`) | drop the fallback once the type says non-optional |
| `dests[].crow` / `rail` per city | out-map | used in tooltips; **per-row** `distKm` fallback recomputed with haversine (`origin.ts:104`, `249`) | ship per-row crow km (#5) |
| `fully_tracked`, `outbound`, `inbound` counts | out-map | `outbound`/`inbound` in tooltip; `fully_tracked` unused | keep for the header or drop |
| `extra_stations` | schedules | unused (always empty) | drop |
| arr `dayOff` | dropped by atlaspack | recomputed `floor((dep+dur)/1440)` | fine; or ship (#5) |
| Section lengths, cumulative lengths | pipeline has true OSM lengths | **re-derived from simplified geometry** (#10) | the one place the client is less accurate than the pipeline |
| Per-train path distances, stop distances | pipeline has them implicitly (`route_km_track`, `legKm`) | re-derived (#11) | move |
| Ferry status | router `"ferry"` leg status | re-derived by bbox (#27) | move |
| Train class semantics | `cn::classes` | re-derived by letter (#18, #25, #30) | move to manifest |

---

## 4. Migration plan (for later; nothing started)

Conventions as in `history/DECKGL_MIGRATION.md` §4: one PR per task, tests green, no stubs, acceptance
numbers quoted in the PR. "Swap" = owner-approved replacement of `web/public/assets`. Byte-rule:
a task that changes pack bytes without changing any decoded value must prove it (decoded
typed arrays byte-identical, or `secdiff --packs` reports no flow change); a task that changes
values re-baselines shots and goldens in its own PR with the diff explained.

| Task | Depends on | Scope | Acceptance | Swap? |
|---|---|---|---|---|
| **T0 Bench in repo** | — | Commit `web/tools/bench/{parse,columnar}.mjs` from this audit's scratch scripts; `bun run bench` prints the §1.3 tables | Numbers reproduce within 20 % | No |
| **T1 Manifest + pack id** (pipeline + client) | — | `atlaspack` writes `atlas-manifest.json` (pack id, fmt, files, counts, class table, extent, default origin, build); every file gains `pack`; client `requireFmt` → `requirePack`; `useAtlasData` loads the manifest first; `bundle.mjs` reads hashes from it | `audit --pack-only` checks `pack` equality across files (new hard check); client refuses a mixed pack (new `decode.test.ts`); shots 0 diff | **Yes** (adds a file). Batch with the P3.1/P2.2 national swap (R7) |
| **T2 Facts out of the client** (pipeline additive fields, fmt 7) | T1 | `ferry` flag + water split (#27); class table consumed (#18, #25, #30); romanised names in data (#9); `secLenM`/`cumLen` (#10); `pStart`/`stopDist` per path incl. the national trains file (#11); absolute schedule minutes + `boardAbs` (#12, #24); `firstVisit` (#14, #19, #25); `originIdx`, per-row crow km (#5, #33) | Oracle tests on the committed pack: shipped `pStart` vs `prepTrainPath` ≤ 1e-6 km for all trains; shipped lengths vs `getSecGeometry` ≤ 1 %; `ferry` flags select exactly today's sections. Goldens: `ferry_sections`, `sec_len_sum_km`, `path_total_km_sum`, `stop_dist_regressions = 0`, `city_en_fixed = 0`. Shots: animation scenarios re-baselined (dot distance space changes by ≤ 1 %), all others 0 diff | **Yes** (fmt 7). One swap for all of T2 (R7) |
| **T3 Client consumes T2** | T2 swapped | Delete `prepTrainPath` path maths, `getSecGeometry`, `ferry.ts` bbox rules, class literals, `enName`, the `rel()` frame shifts, the `unrolled` day search, the dedupe sets; `national.ts` reads the Rust trains file | `bun test` green with the oracle tests turned into equality tests; `grep` check from R1 = 0 hits; heap and timing within today's | No |
| **T4 Binary columnar container (fmt 8)** | T1 (T2 recommended first so the fmt bump is once) | Rust TA1 writer; `audit` + `check_pack_roundtrip` reader; geometry as int16 deltas; tables as columns; `expandOutTables`/`expandInTables` deleted; `DepVM.secs/path` become `(off,len)` views; `vercel.json` content-type; `staleReload` pattern; `fetchData` magic sniff | Decoded typed arrays byte-identical to the fmt 7 JSON decode (new test over the whole pack); **heap after both directions ≤ 60 MB** (today ≈ 175 **[measured]**); parse per file ≤ 5 ms **[estimate]**; first-paint transfer ≤ today's 1.07 MB; shots 0 diff; M7 (time to first deck frame) not worse | **Yes** (fmt 8) |
| **T5 12 k ingest** | T2 (+T4 strongly recommended) | The new timetable through router → atlas → atlaspack in the new format | goldens rebased deliberately (`--update-goldens`) with the P3.1 numbers re-derived; `?natSynth` retired; M1n/M2n/M4n/M5n on the real 12 k pack | **Yes** |
| **T6 Optional later** | T4 | (a) TripsLayer keyframes from `pStart` + absolute minutes if D2 is ever turned on; (b) per-origin map files / single archive with ranges if first paint must shrink; (c) Arrow IPC export from TA1 if interop is wanted | — | — |

**Sequencing against the deck plan and G-MAIN**

- T0 and T1's *pipeline* half are independent of `deckgl` and can be built now, **staged**,
  on a branch off `main` (pipeline work goes through PRs per the project rule). Their client
  half (`requirePack`, manifest loading) touches `useAtlasData.ts`, which Phase 2 also edits
  (`outTablesRaw`), so land it on `deckgl` after P2.2, or after G-MAIN, whichever is first.
- **Before G-MAIN:** nothing from this plan except T0. The owner gate should not be widened
  with a format change; the deck migration's parity evidence is against the fmt 6 pack.
- **After G-MAIN, before the 12 k data:** T1 → T2 → T3 → T4, batching the T1/T2 swap with the
  P3.1 national flows + P2.2 national trains swap if that has not happened yet (one approval,
  one goldens rebase, one `pack-diff` comment). T4 alone is a second swap; if the 12 k data is
  close, fold T4 into T5 so the 12 k pack is the first binary pack.
- Phase 2 (P2.1–P2.4) needs none of this: `buildNational` works on fmt 6 and the Rust trains
  file is additive. Phase 3 (P3.2/P3.3) benefits from T1 (manifest-declared national files) but
  does not need it.
- The router stays untouched throughout: everything here is `atlas`/`atlaspack`/`audit` output
  shape. The router's `ScheduleSource` / network seams (`pipeline/router/README.md`) are the
  right place for new schedule data; the thin-client contract starts at `atlas`.

**Budgets to hold (from `history/DECKGL_MIGRATION.md` §4/§11):** M1/M2 frame time unchanged (no layer
changes); M4 GPU ≤ 64 MB (unchanged); M6 deck chunk ≤ 300 KB brotli (TA1 reader ≈ 2 KB; no
Arrow JS); M7 first deck frame ≤ 1.0 s (parse drops, so it improves); new **M15 CPU heap after
both directions loaded ≤ 60 MB** and **M16 first-paint transfer ≤ 1.1 MB brotli**.

---

## 5. Open questions for the owner

1. **Presentation functions stay client-side (R2).** This contradicts rule 1 read literally
   (easing, colour ramps and radii are "the same for every user"). Confirm the three-category
   split, or say which presentation constants you want frozen in the pack.
2. **Container choice.** Minimal TA1 (own ≈ 60-line writer/reader, zero dependencies) versus
   Arrow IPC (standard, adds Arrow JS). The recommendation is TA1; say if Arrow interop
   (DuckDB, Parquet, Python notebooks reading the pack) is a goal, which would flip it.
3. **Distance space.** Shipping true OSM track lengths (#10/#11) changes dot speeds by the
   simplification error and makes the dot's progress consistent with the `km` column. It is a
   visible-but-tiny animation change and a shots re-baseline. OK?
4. **Ferry representation.** Split the water leg into its own section (cleanest; changes section
   count and ids, so it is a renumbering) or ship a `waterRange` per ferry section (no
   renumbering). Preference?
5. **Swap batching.** Are you willing to take one larger swap (national flows + national trains
   + manifest + fmt 7 fields) rather than three small ones? R7 assumes yes.
6. **12 k timing.** If the 12 k data lands before T4, should its pack be JSON fmt 7 (one more
   swap later) or should T4 be pulled forward so the 12 k pack is the first binary one?
7. **Default origin and bilingual labels** become manifest data. Do you want the manifest to be
   hand-editable (committed `data/manifest-defaults.json` merged by `atlaspack`) or fully generated?
8. **Scope of portability.** For "schedules on arbitrary OSM", is the target that the *web
   client* runs unchanged on another network's pack (then every China literal must go, §1.3 (k)),
   or only that the *pipeline* does? The audit assumes the former.
9. **Heap budget.** Is ≈ 60 MB JS heap after both directions (M15) the right number for your
   phone (Oppo Find N6), or do you want a measured target from a device run first?

---

## Appendix A. Measurements (bun 1.4.4, M4 Max, committed pack) **[measured]**

| pack | br bytes | json bytes | br decode | JSON.parse (median of 5) | retained heap |
|---|---:|---:|---:|---:|---:|
| atlas-v2-shared | 507,506 | 1,853,567 | 7.9 ms | 3.5 ms | 4.9 MB |
| atlas-v2-out-map | 527,609 | 5,081,805 | 7.3 ms | 12.8 ms | 25.2 MB |
| atlas-v2-out-tables | 1,640,513 | 9,746,657 | 16.1 ms | 18.6 ms | 29.8 MB |
| atlas-v2-in-map | 533,924 | 5,060,716 | 7.3 ms | 12.4 ms | 25.1 MB |
| atlas-v2-in-tables | 1,783,458 | 10,412,909 | 18.8 ms | 19.6 ms | 29.3 MB |
| atlas-v2-schedules | 415,311 | 1,800,072 | 3.6 ms | 4.1 ms | 5.9 MB |
| china-outline | 32,570 | 50,331 | 0.3 ms | 0.0 ms | 0.1 MB |

Structure: sections 7,922 (75,044 pts), in_sections 7,904 (75,804), network 7,703 (88,477),
throats 8,825 (21,004); trains 7,157; out path entries 670,796; stop_pos entries 67,784; out deps
29,926 rows, calls 210,196; in arrs 29,949, in_calls 214,516, in path entries 653,600; out-map
flow rows 270,313; schedule rows 81,159.

Client build costs: `prepAtlas` 10.8 ms; `expandOutTables` 9.1 ms / 29.0 MB; `expandInTables`
6.5 ms / 25.5 MB; `buildOrigin(广州)` 9.7 ms, its `buildDayTimeline` 37.1 ms (1,201 trains,
4,286 sections × 818 steps = 6.7 MB Uint16, 14.7 MB retained), `getActiveTrains(1095)` 1.4 ms →
292 dots, `filterOrigin(G)` 2.2 ms, subset timeline 12.4 ms; 北京: 3.8 / 33.2 / 0.3 ms;
`buildNational` 17.8 ms, 9.0 MB retained (6,972 trains, 670,796 refs); `natPositions(1095)`
2.9 ms → 2,668 dots.

Columnar prototype: §1.3 (d). Scripts: `scratchpad/thinclient/bench/measure.ts`,
`columnar.ts` (session scratch; T0 commits them).

## Appendix B. Sources

- deck.gl 9.4 docs: binary attributes / `startIndices` (developer guide, performance), TripsLayer
  (`getTimestamps`, `currentTime`, `trailLength`), as already cited in `DECKGL_MIGRATION.md`.
- PMTiles v3 (Protomaps): single immutable archive, HTTP range requests, 16 KB initial header,
  Hilbert tile ids — `protomaps.com/blog/pmtiles-v3-whats-new`, `docs.protomaps.com/pmtiles/`.
- GeoArrow: coordinates + offsets LineString layout; `@geoarrow/deck.gl-layers` renders Arrow
  tables directly (the R package `deckglgeoarrow` 0.0.2, 2026-07, wraps it) — the layout we
  mirror in `DecodedSet`.
- FlatGeobuf: streaming columnar features with an optional packed Hilbert R-tree; not needed
  while the whole network is always drawn.
- kepler.gl / DuckDB-WASM: client-side analytics as the contrasting cost model.
- This repo: `docs/history/DECKGL_MIGRATION.md` (C19, C23, D3, D8, D12, P2.1, P3.1 as built, §11),
  `docs/PIPELINE.md` §3/§7, `pipeline/analyze/src/bin/atlaspack.rs` header, `flows.rs`,
  `pipeline/goldens.json`, `web/src/lib/*`, `web/src/components/map/deck/**`.
