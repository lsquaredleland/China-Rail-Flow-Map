# deck.gl migration plan: from the Canvas 2D renderer to deck.gl

Status: **approved for execution, phase by phase.** Each phase is a set of numbered,
PR-sized tasks with files, tests, acceptance numbers and a stop/go gate. The owner
decisions D1–D15 (§10) are **adopted defaults**: implementers follow them unless the
owner overrides one in writing.
Baseline: `origin/main` @ `05bea87`. Target library: **deck.gl 9.4.0** (npm `latest`,
re-checked 2026-10-24) on **luma.gl 9.4.x**. Spike reference: `spike/national-anim` @ `600b3de`.

Where this plan states a number, the source is given: **[measured]** means measured for
this plan or in the spike, **[source]** means read from the deck.gl 9.4.0 package source,
**[docs]** means read from deck.gl's published 9.x API reference, and **[estimate]** means
a guess that Phase 0 must replace with a measurement.

---

## Review changes (2026-10-24, second pass against the code and the deck.gl docs)

What changed in this revision and why. Everything below is folded into the sections.

| # | Finding | Change |
|---|---|---|
| C1 | **`LineLayer` has no `getSourceColor`/`getTargetColor`** (only `getColor`) **[docs]**. The gradient-tail plan in §0 and row 21 was wrong. | Tails are a `TailLayer extends LineLayer` (~15 lines: `getShaders()` injects `vColor.a *= positions.x` so the segment fades source→target). Phase 0 M13 verifies it; fallback is `ArcLayer({getHeight: 0, numSegments: 2})` (has per-end colours **[docs]**), last resort a solid tail at α 0.6 (visible change, owner notified). |
| C2 | Dot "stroke trick" numbers were inconsistent (radius 3 + stroke 2 ≠ ring 2–4). `ScatterplotLayer` draws the stroke **inside** the radius **[source]**. | `getRadius: 4`, `getLineWidth: 2`, both in pixels: ring 2–4 px (class colour), core 0–2 px (white). Isolated: 5.5 / 2.7. |
| C3 | "A section with `n = 0` gets width 0" would be re-grown to 0.5 px by `widthMinPixels`. | Visibility of `n = 0` sections comes from `DataFilterExtension` (`getFilterValue = n`, `filterRange [0.5, 1e9]`), never from width. |
| C4 | `staleReload.ts` only matches hashed `.json.br` 404s; a lazily imported deck chunk that 404s after a deploy would surface as an `import()` TypeError with no status, so the old tab would never self-heal. | New pure `importFailureDecision()` + `maybeReloadForFailedImport()` with the same 60 s cooldown; a test in `staleReload.test.ts`. The deck loader catches `import()` rejection and calls it. |
| C5 | `"build": "node bundle.mjs"` runs under Node on Vercel and in CI, so production already uses the **esbuild** branch; the `Bun.build` branch is dead for prod. | D14: esbuild is the one bundler; the Bun branch is deleted in P1.4. Concrete esbuild options for the split are given (§7 R2). |
| C6 | `draw(M)` and `resize(M)` are canvas-bound (`anim.ts`, `camera.ts`, `api.ts`, `pointer.ts` import `draw` from `render.ts`; `resize` returns early without a `<canvas>`). The "mode switch" needs a seam. | P1.2 adds `M.render()` to `MapCtx`; hosts set it. `resize()` measures `wrapRef` (as it does) and sizes the 2D canvas only if present. The camera stays `S.current.view` for both renderers (no hand-off; conversion is per view-state event, §5). |
| C7 | Phones cannot be an agent gate (no devices). `drv/nat2.mjs` launches `headless: true`, which can land on SwiftShader and give meaningless numbers. | M3/M10 are **owner steps**; agent gates are M1, M2, M4, M6, M7, M8, M9, M12, M13. The perf driver prints `UNMASKED_RENDERER_WEBGL` and **fails if it contains "SwiftShader"**; rerun with `headless: false`. |
| C8 | `gpuTimePerFrame` is disabled unless `deviceProps: {debugGPUTime: true}` **[docs]**. | Added to the perf harness; production does not set it. |
| C9 | Phase 2a ("extract `lib/mapModel.ts` first") was right in direction but one 3–4 day lump, and the zero-diff screenshot tooling it depends on did not exist on `main`. | Screenshot + perf drivers land on `main` in **P0.1** (from the scratchpad `drv/`). 2a is split into three zero-diff PRs (2a.1 camera/ferry/tooltip, 2a.2 `mapModel` flows, 2a.3 stations/labels). |
| C10 | National mode semantics were undefined (what happens to selection, filters, inbound, the scrubber counters). | D13 defines national mode; `AnimState` gains `national`/`running`; the scrubber's two counters read "Running / Trains" in national mode (one small `TimelineScrubber.tsx` change, previously claimed unchanged). |
| C11 | D8 relied on `navigator.deviceMemory`, which Safari does not expose. | D8 now caps DPR at 2 in national mode on `deviceMemory ≤ 4` **or** any touch device. |
| C12 | Every preserved behaviour rule now has a named test or acceptance check (§6.1). Hover/selection priorities, class-filtered counts, minimize, stale reload, backdrop toggles, destination window. | New §6.1 table. |
| C13 | Verified and kept: projection formulas; `flowWidth` ↔ `widthUnits:'common'` + `widthMinPixels 0.5`; 62 tests / 7 files; 3,146 lines; bundle 392,735 B JS, `index.html` 454,611 B / 133 KB gzip; deck.gl 9.4.0 = npm latest; `dashUnits` exists (`'pixels'`) **[docs]**; DataFilter `filterSize ≤ 4`, 128 categories at `categorySize 1` **[docs]**; `useDevicePixels` accepts a number **[docs]**; 8 MB section-ref estimate (691 K × 12 B). TripsLayer GPU estimate tightened to ≈ 45–60 B/vertex (same conclusion). | — |
| C14 | `@deck.gl/react` vs imperative `Deck`: decided. | D15: imperative `Deck` driven from `MapCtx` (one `setProps` per `M.render()`); no `@deck.gl/react` in the bundle. |

---

## 0. TL;DR

- **The camera maps exactly onto deck.gl.** `camera.ts` uses `px = lon·scale + tx`,
  `py = −lat·scale + ty`. That equals `OrthographicView({flipY: false})` with positions
  `[lon, lat]`, `zoom = log2(scale)` and `target = [(W/2 − tx)/scale, (ty − H/2)/scale, 0]`.
  Checked in Node and Bun against `@deck.gl/core` 9.4.0 `OrthographicViewport.project`:
  largest error 4.6e-13 px **[measured]**. `flipY: false` so no coordinate is negated.
- **The bundle grows less than feared, and it is split out.** Core plus Path/Scatterplot
  layers minify to 833 KB (234 KB gzip); the full set (Trips, Text, Line, DataFilter,
  PathStyle) is 949 KB minified, 262 KB gzip, 217 KB brotli **[measured, esbuild 0.28.2]**.
  Today's app JS is 392,735 B minified; `index.html` is 454,611 B (133,146 B gzip)
  **[measured]**. deck ships as a **hashed, immutable, lazily imported ESM chunk** under
  `assets/`; `index.html` stays the revalidated entry.
- **The spike's 16.6 ms Canvas cost comes from the tails, not the position maths.** On deck
  the dots are one `ScatterplotLayer` (ring + core in one draw), the tails one `TailLayer`
  (a `LineLayer` subclass with a per-segment fade, C1). Both read the spike's interleaved
  `Float32Array` as binary attributes. Expected CPU per frame: well under 2 ms **[estimate]**.
- **TripsLayer is optional, not the core of A.** It needs 3.97 M expanded vertices today
  (≈ 6.8 M at 12k trains) at ≈ 45–60 B each on the GPU: 180–400 MB **[estimate]**. For A we
  use CPU positions over *shared section geometry* (the dedup); TripsLayer is an opt-in
  "comet" mode, only after Phase 0 M4 passes with simplified paths.
- **Most of the complexity is semantics, not drawing.** `flows.ts` (853 lines) is mostly
  "which sections, at what alpha and width, under which selection / animation / isolation
  state". That moves to pure, tested `lib/` functions. deck removes the drawing boilerplate.
  Custom render code drops from ≈ 3,360 to ≈ 1,500 lines plus ≈ 750 tested `lib` lines (§9).
- **Coexistence is a switch, not a stack.** Phase 1 mounts deck only in national mode;
  Phase 2 swaps the origin view behind `?renderer=deck`, flips, then deletes Canvas. Both
  renderers share `MapCtx` (camera `S.current.view`, animation clock, tooltip and scale-bar
  DOM); only `M.render()` differs.
- **Labels stay off-deck** on a thin overlay canvas drawn in `onAfterRender` (D5).
- **Effort.** Phase 0: 1–2 days. Phase 1: 5–7 days. Phase 2: 9–13 days. Phase 3: 3–5 days
  of web work plus the pipeline task.

---

## 1. Current client inventory (what has to be replaced)

`web/src/components/map/` is **3,146 lines** across 11 modules **[measured]**, all imperative
Canvas 2D driven from one `draw(M)` in `render.ts`. Paint order: backdrop → chords → flows →
infra → trains → hover segment highlight → stations → labels → legend sync → scale bar.

| # | Visual element / behaviour | Where today | deck.gl target | Notes |
|---|---|---|---|---|
| 1 | Paper background | `backdrop.ts paintBackdrop` | CSS `background` on `#map` host + transparent deck canvas | No layer |
| 2 | Country outline rings (fill + stroke) | `backdrop.ts drawOutline` | `SolidPolygonLayer` (fill) + `PathLayer` (stroke) | Width `max(0.65, scale·0.015)` → `widthUnits:'common'`, `getWidth 0.015`, `widthMinPixels 0.65` |
| 3 | Open boundary lines, nine-dash line | `drawOutline` (lines with `len ≤ 4` dashed) | `PathLayer` + `PathStyleExtension({dash:true})`, `dashUnits:'pixels'` **[docs]** | Dash `[max(6,2.2w), max(4,1.8w)]` |
| 4 | Graticule (5°) | `drawGraticule`, rebuilt per view | Static `LineLayer`, lon 60–150 / lat 0–60, 0.5 px | No per-view rebuild |
| 5 | Base network | `drawNetwork` | `PathLayer` on `atlas.net` (binary, `startIndices`, `_pathType:'open'`); `common` width 0.008, `widthMinPixels 0.45`, `widthMaxPixels 2.5` | One-to-one clamp mapping |
| 6 | Qiongzhou ferry (dashed blue, water part only) | `isFerry` bbox test + `traceInto(..., "landOnly"/"waterOnly")` **re-split every frame**; bbox test duplicated 6× | Split once at decode in `lib/ferry.ts`; water pieces → dashed `PathLayer` | — |
| 7 | Backdrop offscreen cache | `drawBackdrop` + `BackdropCache` | **Deleted** | GPU redraw is cheap |
| 8 | Routed flows: width ∝ trains, colour ramp | `flows.ts drawFlows / strokeFlowList` (0.25 px buckets) | Binary `PathLayer` on `sec`/`inSec`; `getWidth = n·WIDTH_K/fitScale`, `widthUnits:'common'`, `widthMinPixels 0.5`; `getColor` = `flowColorRGBA` | Equals `flowWidth(n, scale, fitScale) = max(0.5, n·0.08·scale/fitScale)` exactly **[verified]**; pan/zoom cost zero attribute updates. `n = 0` hidden via `DataFilterExtension` (C3) |
| 9 | Flow dimming passes (selected city, filtered view, isolated train) | `drawFlows` branches, faded α 0.06/0.08 (iso) and 0.16/0.18 (dark/light) | Two `PathLayer` instances: `flows-context` (faded, `pickable:false`) and `flows-focus` | D3: context pass pre-blended opaque |
| 10 | Animated flow growth (`secFlowSteps`) | `drawFlows` (`step = floor(t/stepMins)`) | `updateTriggers: {getWidth: step, getColor: step}` | Once per 5-min step |
| 11 | Isolated-train corridor (progressive) | `drawFlows` iso branch + `tracePartialSec` | `PathLayer` with one path from `lib/mapModel.ts isolatedCorridor` | Per frame, one path |
| 12 | Infrastructure overlay | `drawInfra` | `PathLayer` 1.25 px, colour by `hsr[s]`; connected/unconnected via `DataFilterExtension` categories | — |
| 13 | Chord legs (dashed straight) | `drawChords`, gated by first departure | `PathLayer` + `PathStyleExtension`, `dashUnits:'pixels'` | Gating → `lib/mapModel.ts chordVisibility` |
| 14 | Hover highlight (seg/chord), width +1.6 | `drawHighlightSeg` | `PathLayer` with 0–1 items | — |
| 15 | Station dots: `stationR·stationZoomK(t)`, `rampColor(fastest)`, `dotEdge` stroke 1.5/3.0 | `stations.ts drawStations` | `ScatterplotLayer`, `radiusUnits:'pixels'`, `stroked`, `lineWidthUnits:'pixels'` | `updateTriggers.getRadius = round(stationT, 3)` |
| 16 | Dot growth while animating | `drawDot` (`cityArrTimes ≤ t`) | Same `lib` maths; `getRadius` trigger on `animTime` | ≤ 300 points |
| 17 | Arrival ripple (gold ring, 20 min) | `drawDot recentArrival` | `ScatterplotLayer filled:false`, per-point radius/alpha | Exact |
| 18 | Selected / hovered rings, origin hover ring | end of `drawStations` | `ScatterplotLayer` (0–3 points) | — |
| 19 | Origin marker (disc + diamond) | `drawStations` | Disc: `ScatterplotLayer`; diamond: drawn on the label overlay canvas | Avoids an `IconLayer` atlas |
| 20 | Train dots: glow r4 + white core r2, α 0.45 on chords | `trains.ts drawTrains` | One `ScatterplotLayer`: `getRadius 4`, `getFillColor` white, `stroked`, `getLineWidth 2`, `getLineColor` class colour (C2) | One draw call |
| 21 | Gradient tails 12 px × speedFrac (22 isolated), width 2.5 (3.5) | `drawTrains` (save/rotate/stroke per train) | `TailLayer` (C1): source = pos − heading·len/scale, colour fades to α 0 at the source | Length ∝ 1/scale so it stays 12 px |
| 22 | Dwell ring (r 6.5, α 0.85, 1.3 px) | `drawTrains` | `ScatterplotLayer` stroked-only on dwelling dots | — |
| 23 | Hover/selected/isolated train ring + code tag | `drawTrains` | Ring: `ScatterplotLayer` (0–2). Tag: label overlay canvas | — |
| 24 | City labels (collision-aware, tiers by zoom, boxed origin/selected) | `stations.ts drawLabels` (≈ 250 lines) | Placement → pure `lib/labels.ts`; drawing → overlay canvas | §1.2 |
| 25 | Hover tooltip (HTML) | `interaction.ts showTooltip` (≈ 190 lines) | **Unchanged** DOM `#tooltip`; builders → `lib/tooltip.ts` | Positioned from `info.x/y` |
| 26 | Hit-testing: train (14 px, paused only) > station (`14·zoomK`) / origin (15 px, wins ties) > segment (10 px, busier wins within ±0.75 px) > chord | `interaction.ts pick*` | Phase 1: deck picking on dots. Phase 2: `pickMultipleObjects` + pure `pickPriority` (D6) | §2.5 |
| 27 | Tap-select / tap-empty-clears / pinned tooltip | `pointer.ts endPointer` | `Deck.onClick(info, event)` | P2b.3 verifies `onClick` fires with `picked:false` |
| 28 | Pan / wheel / pinch, clamp `fitScale·[0.55, 60]` | `pointer.ts`, `camera.ts zoomAt`, wheel listener in `MapCanvas.tsx` | `OrthographicController` `{dragPan, scrollZoom:{speed}, touchZoom, inertia:false, dragRotate:false, keyboard:false, doubleClickZoom:false}` **[docs]**; `minZoom/maxZoom` in `viewState` | Wheel calibrated to `exp(−deltaY·0.0016)` in P1.5 |
| 29 | Fit country / home / Guangzhou initial / `panZoomTo` / `initialCamera` / keep centre on resize | `camera.ts fit*`, `resize` | Same maths on `S.current.view`; `lib/camera.ts` converts to/from `viewState` | `MapApi` unchanged |
| 30 | Scale bar | `camera.ts updateScaleBar` | Unchanged; called from `M.render()` | — |
| 31 | URL view report (debounced) | `reportViewChange` | Unchanged; URL zoom `log2(scale·360/256)` kept | — |
| 32 | Day / night | `lib/palette.ts palette(dark)` | Add RGBA tuple variants; `dark` in colour triggers | Strings stay for DOM/Legend |
| 33 | DPR cap 3 | `resize` | `useDevicePixels: Math.min(3, devicePixelRatio)` (cap 2 per D8) | — |
| 34 | Origin-switch fade (`#map.switching`) | `MapCanvas.tsx` | Same class on the deck host `div#map` | — |
| 35 | Legend sync | `render.ts` | From `M.render()` | SVG, stays |
| 36 | Animation clock | `anim.ts` | **Kept**; calls `M.render()` | Scrubber/modal subscribe unchanged (one label change, C10) |
| 37 | Loading / error / stale overlay, isolation chip, timeline button | `MapCanvas.tsx`, `MapOverlays.tsx` | **Unchanged** | — |

Everything outside `components/map/` and `MapCanvas.tsx` stays unchanged except the small,
named edits in the task lists (`App.tsx`, `Toolbar.tsx`, `TimelineScrubber.tsx`,
`useUrlState.ts`, `useAtlasData.ts`, `bundle.mjs`, `index.template.html`, `staleReload.ts`).
**The `MapApi` interface in `context.ts` is the seam**; it does not change.

### 1.1 Target module layout (after Phase 2)

```
web/src/lib/               (pure, bun-testable; no deck imports)
  camera.ts      View {scale,tx,ty} <-> viewState {target,zoom}; fit maths; zoom clamps; scale-bar distance
  mapModel.ts    flow passes for every selection/animation/isolation state; chord gating; station
                 states (radius inputs, ripple, alpha); isolatedCorridor; selection cache rule
                 (getSelCache / isTrainShown, moved from map/trains.ts; delegates to stopEffects)
  labels.ts      label candidates + collision placement (from drawLabels; returns boxes + text)
  tooltip.ts     tooltip HTML builders (from interaction.ts)
  ferry.ts       one-time land/water split of the ferry sections
  national.ts    national per-train timelines on section refs (reworked from the spike; §2.3)
  pick.ts        pickPriority(candidates, px, py, project) (Phase 2)
  (unchanged)    decode, filter, origin, timeline(+prepTrainPath), stopEffects, palette(+RGBA), format, geo
web/src/components/map/
  deck/DeckHost.tsx          Deck instance, controller, lifecycle, context loss, onAfterRender → overlay
  deck/TailLayer.ts          LineLayer subclass with the source→target alpha fade (C1)
  deck/layers/{backdrop,flows,stations,trains,national}.ts   props builders only (pure given inputs)
  deck/labelsOverlay.ts      thin 2D canvas: labels, origin diamond, train tag
  deck/load.ts               lazy import() of the deck chunk + stale-chunk recovery (C4)
  anim.ts, api.ts, camera.ts, context.ts   kept (camera.ts shrinks to resize/report glue)
```

### 1.2 Why labels stay outside deck (D5 adopted: overlay canvas)

| Option | Pros | Cons |
|---|---|---|
| **Overlay 2D canvas (adopted)** | Pixel-identical text (native CJK shaping, system font fallback); keeps today's placement; ≈ 40 lines of drawing | One extra canvas; redraw on every deck frame (≤ ≈ 60 labels, cheap) |
| `TextLayer` (`characterSet:'auto'`, `background:true`) **[source]** | All on GPU | SDF text at 10.5–14 px is softer than native, especially thin CJK strokes; atlas rebuilds on new characters (origin switch); collision still JS |
| DOM labels | Crisp; screen-reader accessible | ≈ 60 elements repositioned per pan frame; z-order vs tooltip; collision still JS |

**Sync rule.** The overlay is drawn inside deck's `onAfterRender` with the viewport from
`deck.getViewports()[0]`, so it uses the exact view state of the frame just drawn (controller
inertia and controlled `viewState` updates both pass through a deck redraw). The overlay
canvas mirrors the deck canvas size (W × H CSS px, same DPR) and has `pointer-events: none`;
it sits above the deck canvas and below `#tooltip`.

---

## 2. Data flow: pack to layers

### 2.1 What the pack provides (fmt 6, `lib/decode.ts DATA_FMT = 6`)

| Pack (size, br) | Decoded into | Used by |
|---|---|---|
| `atlas-v2-shared` (529 KB) | `DecodedAtlas.sec / inSec / net / thr` (`DecodedSet`: `pts` Float32 lon/lat, `off`, `len`, `bb`, `hsr`) | All path layers; **geometry uploaded once per set** as binary paths (`startIndices = off/2`) |
| `atlas-v2-out-map` / `in-map` (546 / 551 KB) | `OriginVM.flows / inFlows / chords / dests / srcs` | Flow widths/colours, chords, station dots |
| `atlas-v2-out-tables` (1,650 KB: `paths`, `stop_pos`, `chords`, per-origin `dep_off`) | `expandOutTables` → `DepVM.secs / path / stopPos / chordLegs` | Origin timeline; **national timelines** (needs the raw `paths`/`stop_pos`/`chords`, which `useAtlasData` must retain, P1.1) |
| `atlas-v2-in-tables` (1,796 KB) | `ArrVM` rows | Inbound panels/flows |
| `atlas-v2-schedules` (416 KB) | `DecodedAtlas.schedules` | Dwells; national stops (already fetched together with out-tables in `useAtlasData`) |

`lib/` changes in Phases 1–2 are additive only: `palette.ts` RGBA helpers; `camera.ts`,
`mapModel.ts`, `labels.ts`, `tooltip.ts`, `ferry.ts`, `pick.ts` extracted; `national.ts`
promoted; `timeline.ts` exports `prepTrainPath`. `filter.ts`, `origin.ts`, `stopEffects.ts`,
`decode.ts` stay byte-for-byte unchanged, so the 62 existing tests keep guarding semantics.

### 2.2 Layer data shapes

- **Static geometry (flows, infra, network, outline).** One binary `PathLayer` data object
  per `DecodedSet`: `data: {length: nSec, startIndices, attributes: {getPath: {value: set.pts, size: 2}}}`,
  `_pathType: 'open'` (skips normalisation **[docs]**). Per-section width and colour via
  accessors `(_, {index}) => widthArr[index]` with `updateTriggers`; visibility of `n = 0`
  sections via `DataFilterExtension({filterSize: 1})`, `getFilterValue: (_, {index}) => nArr[index]`,
  `filterRange: [0.5, 1e9]` (C3). Geometry never re-uploads; width/colour/filter attributes
  rebuild in O(vertices of the set) per trigger: ≈ 1–4 ms at the 5-min step **[estimate]**.
  - Focus pass for a selected city (small subset): non-binary `data = subFlows` with
    `getPath: f => set.pts.subarray(off[f.s], off[f.s] + 2·len[f.s])`.
- **Animated dots (origin and national).** CPU writes the spike's interleaved `Float32Array`
  (6 floats per dot: lon, lat, ux, uy, speed, flags). `getPosition: {value: buf, size: 2, stride: 24, offset: 0}`;
  colour from a parallel `Uint8Array(c·4)` filled in the same loop. A **new** `data` object
  `{length: c, attributes}` per frame (deck recalculates that layer's attributes when `data`
  changes **[docs]**; for external typed arrays that is a re-upload of ≈ 2.7k × 28 B = 75 KB).
- **Tails.** `Float32Array(c·4)` (source xy, target xy) in the same loop → `TailLayer`.
- **Small per-frame sets** (ripples, dwell rings, highlight rings, isolated corridor): plain
  arrays (≤ a few hundred items).

### 2.3 National timelines and memory (A)

The spike (`lib/national.ts buildNational`) expands every train's path into its own vertex
arrays: **3.97 M vertices ≈ 48 MB** CPU, against **≈ 691 K section refs** **[measured, spike]**.
At ≈ 12k trains: ≈ 6.8 M vertices ≈ 82 MB **[estimate, linear]**.

**Dedup (P1.1).** Keep per-train **section refs plus cumulative starts**, like the origin
`PrepTrain` (`secStarts`, `throatSpans`, `chordSpans`). Position-at-distance = binary-search
the path entry, then binary-search inside the shared section's `secCumLens`
(`getSecGeometry` in `timeline.ts` already caches these per `DecodedSet`). Memory
≈ 691 K × (4 B id + 8 B start) ≈ **8 MB** plus the already-loaded geometry. Per frame: two
binary searches per active train (≤ ≈ 4.5k at 12k) **[estimate: < 1 ms]**.

Concretely: generalise `buildDayTimeline`'s per-train prep (`timeline.ts` lines ≈ 246–400)
into an exported `prepTrainPath(pathEntries, stopPos, chordLegs, atlas)` used by both the
origin timeline and `national.ts`. This is the only change to `timeline.ts`; the snapshot
tests (`tests/__snapshots__`) pin its output.

**Wrap-around (dots).** Keep the spike's rule: a train is drawn at display minute `m` for
every `k` with `start ≤ m + 1440k ≤ end` (`natPositions`). Handles overnight and multi-day
trains; a run longer than 24 h yields two dots.

**Synthetic load.** `?natSynth=12000` duplicates trains with a +37 min shift until
`n ≈ 12,000` (used by M1/M2/M4/M5; never shipped on by default).

### 2.4 TripsLayer (optional comet mode; after Phase 1, only if M4 passes)

TripsLayer 9.4.0 (`@deck.gl/geo-layers`) **[source, docs]**: `getPath`/`getTimestamps` per
vertex; `currentTime`/`trailLength` in the timestamp unit (minutes); `fadeTrail` default
true; fragments outside `[currentTime − trailLength, currentTime]` are discarded; **draws only
the trail, never a head**; timestamps are float32 (minutes up to 4,320 → resolution ≈ 5e-4).

Timestamps from `prepTrainPath`: per vertex `timeAtDist(cumDist[v])`; dwells as a duplicate
vertex (`arrMins`, then `depMins`) offset ≈ 1e-6° to avoid a zero-length segment (M11 checks
the tesselator keeps it); wrap-around via shifted copies (timestamps − 1440·k) for trains with
`end > 1440` only.

Memory is the blocker: PathLayer-family positions are fp64 in `DEFAULT`/`LNGLAT`/`CARTESIAN`
coordinate systems **[source: `use64bitPositions`]**, uploaded as high+low float32 (24 B per
vertex), plus timestamps (8), colour (4), width (4), type (1), picking (3): ≈ 45–60 B/vertex
GPU plus a CPU staging copy. 3.97 M ≈ 180–240 MB; 6.8 M ≈ 300–400 MB. Only viable with
Douglas–Peucker simplification (≈ 0.005°, sub-pixel below ≈ 200 px/°), expected 5–10× fewer
vertices **[estimate]**, which Phase 0 M4 measures.

### 2.5 Picking

| Target | Phase 1 (national) | Phase 2 (origin view) |
|---|---|---|
| Train dots | deck GPU picking on the dots layer (`pickable: !animPlaying`, Deck `pickingRadius: 14`); `info.index` → slot in the frame buffer → train | Same |
| Stations / origin | — | Stations layer pickable; radius rule (`14·zoomK`, origin 15 px, origin wins ties) applied in `pickPriority` over `pickMultipleObjects({x, y, radius: 15, depth: 10})` candidates |
| Sections / chords | — | D6: candidates from `pickMultipleObjects`; `lib/pick.ts pickPriority` recomputes the exact screen distance (`distToSeg` over the ≤ 10 candidates' polylines via `viewport.project`) and applies today's order and the ±0.75 px "busier section wins" tie-break. `flows-context` is `pickable: false` (today a filtered-out section is not pickable either) |

Picking only sees what the layers hold: today's gating ("not pickable unless active at
`animTime`", destination subset, isolated reached sections) falls away because each layer's
data **is** the visible set.

### 2.6 Update strategy

| Change | Layers touched | Mechanism |
|---|---|---|
| Pan / zoom | none, or `stations` (radius via `stationT`), overlay, tails (length ∝ 1/scale) | `viewState` only; `updateTriggers.getRadius = round(stationT, 3)` |
| Animation frame | dots, tails, dwell rings, ripples, station growth, isolated corridor | New binary attributes per frame; everything else memoised |
| Animation step (5 min) | flows width/colour/filter | `updateTriggers` on `step` |
| Origin / direction | all but backdrop | `cur` identity is the trigger key |
| Class / histogram / train filter (new `cur`) | flows (context + focus), chords, stations, dots | `cur` identity; `isFilteredView` → `mapModel` |
| Selected city / isolated train | flows-focus, infra, stations, dots | Rebuild focus data; `trainShownAt`/`stopArrivalTimes` (`lib/stopEffects.ts`) remain the single visibility rule |
| Theme | all colours | `dark` in every colour trigger |

**`DataFilterExtension`** (9.4: `filterSize ≤ 4`, `filterSoftRange`, categories: 128 at
`categorySize 1`, `countItems`) **[docs]** is used only where geometry is static and only
visibility changes: `n = 0` sections (C3); infra connected/unconnected; optional national dot
class toggle; Phase 3 "hide B below threshold". Never for widths (class filters change `n`).

---

## 3. Visual parity

| Element | Expected difference | Resolution | Decision |
|---|---|---|---|
| Faded flow passes (α 0.06–0.18) | Canvas strokes one bucket path at a time (no alpha build-up within a bucket); deck blends each path, so overlaps get darker | Context pass **opaque, pre-blended** against `pal.paper`: `mix(col, paper, 1−α)`. The network no longer shows through faded flows | **D3 adopted** |
| Joints / caps | `jointRounded: true, capRounded: true` ≈ Canvas round | — | No |
| Width quantisation | Canvas rounds to 0.25 px; deck continuous | None | No |
| Gradient tails | `TailLayer` fades alpha linearly source→target in the shader; Canvas used a premultiplied gradient to transparent white | Source colour = class colour at α 0 (no whitish fringe); `LineLayer` has no round cap but the cap sits under the head | No (M13 screenshot) |
| Comet mode | Track-following trail in minutes | Only if D2 toggled on later | D2 |
| Dots | Crisp antialiased ring vs Canvas arcs: same | — | No |
| Ripples / dwell rings | Exact | — | No |
| Dashes | `PathStyleExtension` restarts per path like `setLineDash` per stroke; `dashJustified: false` | `dashUnits: 'pixels'` | No |
| Labels | Identical (overlay) | — | D5 |
| Antialiasing | MSAA vs Canvas AA: 0.45–0.5 px floors may shimmer | Raise to 0.6 if the screenshot review shows shimmer | Screenshot review |

---

## 4. Phases and tasks

Conventions for every task: one PR per task unless marked "same PR"; `bun run typecheck`,
`bun run build` and `bun test` green; **no `test.skip`/`.only`/TODO stubs**; the PR
description quotes the acceptance numbers it measured. "Parallel" means the task touches no
file another in-flight task touches. Tasks marked **[owner]** are performed by the owner,
reported in §11, and never block agent tasks unless stated.

### Phase 0: tooling on `main` + throwaway deck spike (1–2 days). Go / no-go gate

**P0.1 Commit the measurement drivers** — *sequential first; everything else waits on it.*
Files: new `web/tools/shots/shots.mjs`, `web/tools/shots/cmp.mjs` (pixelmatch-style diff,
ported from scratchpad `drv/shots.mjs`, `clsshots.mjs`, `hcshots.mjs`, `minshots.mjs`,
`cmp.py`), new `web/tools/perf/national.mjs` (from `drv/nat2.mjs`/`perf.mjs`),
`web/tools/serve.mjs` (static `dist/` server), `web/package.json` (`devDependencies`:
`puppeteer-core`; scripts `shots`, `perf`), `web/src/App.tsx` (expose `window.__M` next to
the existing `window.__mapApi` debug handle). Scenarios in `shots.mjs` (each a named step
and a PNG): `national-fit`, `guangzhou-initial`, `city-zoom-x10`, `selected-city`,
`selected-city-minimized`, `isolated-train-mid`, `class-filter-G`, `inbound`, `infra-on`,
`night`, `anim-0600`, `anim-1815`, `anim-2350`, `labels-on`, at DPR 1 and 2.
Perf driver prints `UNMASKED_RENDERER_WEBGL` and **exits non-zero if it contains
"SwiftShader"** (C7); accepts `--headed` to relaunch with `headless: false`.
Tests: none (tooling). Acceptance: `bun run shots -- http://localhost:8766 out/` writes
28 PNGs; `cmp.mjs a/ b/` prints per-scenario mismatch % and exits 1 above a threshold flag.

**P0.2 Spike branch `spike/deckgl`** — *sequential after P0.1; throwaway, never merged.*
Files: `web/package.json` (add `@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/extensions`,
`@deck.gl/geo-layers` at exact `9.4.0`), a deck host behind `?national=deck` reusing
`lib/national.ts` from `600b3de` as is, layers: network `PathLayer`, dots `ScatterplotLayer`
(C2 numbers), `TailLayer` (C1), optional `TripsLayer` on a simplified subset; `?natSynth=N`.
Measurements M1–M13 below; results appended to §11; screenshots attached to PR #24.

| # | Metric | How | Pass threshold | Who |
|---|---|---|---|---|
| M1 | Frame time at national peak (18:15 = minute 1095, 2,668 trains today; synthetic ≈ 4.6k active at 12k) on M4 Max, DPR 2, 1280×800 | `deck.metrics.cpuTimePerFrame`, `gpuTimePerFrame` (`deviceProps: {debugGPUTime: true}`, C8), rAF interval p50/p95 over 300 frames; time sweep `animTime = 1095 + i·0.2` | p95 rAF ≤ 16.7 ms; CPU ≤ 4 ms; at 12k synthetic p95 ≤ 16.7 ms | agent (gate) |
| M2 | M1 under CDP `Emulation.setCPUThrottlingRate {rate: 4}` and `{rate: 6}` | as M1 | p95 ≤ 33 ms at 4× (today's data); report 6× | agent (gate) |
| M3 | Real devices: one mid-range Android (Snapdragon 7-series, Chrome) + one iPhone (A15 class, Safari) | On-page FPS meter from `deck.metrics.fps` behind `?fps=1`; the agent ships the meter, the owner runs it | ≥ 30 fps sustained at the peak | **[owner]**, not a gate for Phase 1 start; a fail re-opens D8 |
| M4 | GPU memory | `deck.metrics.gpuMemory`/`bufferMemory` | Dots-and-tails ≤ 64 MB; TripsLayer reported, must be ≤ 150 MB after simplification to be eligible for comet mode | agent (gate for dots; report for Trips) |
| M5 | CPU heap | puppeteer `HeapProfiler`/`performance.memory` delta before/after national build | Report (spike expands vertices: expect ≈ 48 MB; the P1.1 dedup target is ≤ 30 MB) | agent (report) |
| M6 | Bundle | `bundle.mjs` deck chunk min / gzip / brotli | ≤ 300 KB brotli | agent (gate) |
| M7 | Time to first national frame | `performance.now()` from toggle to first `onAfterRender` with `c > 0`, packs cached | ≤ 1.5 s on M4 Max; report at 4× throttle | agent (gate) |
| M8 | Projection exactness | unit test `OrthographicViewport.project` vs `camera.ts X/Y` on 1,000 random points at 5 zooms | ≤ 1e-6 px | agent (gate) |
| M9 | Headless SwiftShader smoke | `--use-angle=swiftshader --enable-unsafe-swiftshader`: build → serve → load `?national=deck` | No `pageerror`; `onAfterRender` fired; canvas has non-paper pixels | agent (gate) |
| M10 | Label rendering options | Side-by-side PNGs overlay vs `TextLayer` at national fit and city zoom | Eyeball | **[owner]**, informational (D5 already adopted) |
| M11 | TripsLayer dwell / zero-length segments | Visual check at a known long dwell | Trail pauses, no artefacts | agent (report; only if Trips was built) |
| M12 | Context loss path | puppeteer: `WEBGL_lose_context.loseContext()` then `restoreContext()` | `onError` receives the loss; after re-creating `Deck` the map draws again, no `pageerror` | agent (gate) |
| M13 | `TailLayer` renders a fade | Screenshot at a zoomed moving train: alpha at the source end < 10 %, head end ≥ 90 % (pixel probe) | Pass, or fall back per C1 and record which | agent (gate) |

**Stop/go.** Phase 1 starts only if **M1, M2, M4 (dots), M6, M7, M8, M9, M12, M13** pass.
If M1–M2 fail on the dots-and-tails path, stop: deck does not buy national performance;
keep Canvas with the spike's sprite variant and close PR #24 with the numbers. If only the
TripsLayer numbers fail, comet mode stays off (D2) and Phase 1 proceeds.

### Phase 1: national animation (A) on deck.gl (5–7 days)

Dependency graph: P1.1 ∥ P1.2 ∥ P1.4 (disjoint files) → P1.3 (needs P1.2) → P1.5 (needs
P1.1, P1.3, P1.4) → P1.6 (needs P1.5) → P1.7 (needs P1.6).

**P1.1 National timelines on section refs** — *parallel.*
Files: `web/src/lib/national.ts` (new on main; reworked from the spike), `web/src/lib/timeline.ts`
(export `prepTrainPath`; `buildDayTimeline` calls it), `web/src/lib/index.ts` (exports),
`web/src/types.ts` (`NationalTimeline`), `web/src/hooks/useAtlasData.ts` (retain the raw
`OutTablesPack` `paths`/`stop_pos`/`chords` in a ref; expose `outTablesRaw`), new
`web/tests/national.test.ts`.
Tests: (a) `natPositions` at minute 1095 on the committed pack returns **2,668** dots;
(b) wrap-around: every dot at m = 30 belongs to a train with `start ≤ 30 + 1440k ≤ end` for
some integer k, and at least one such dot has `start > 30` (a train that left the day before); (c) positions equal the spike's expanded
vertex method within 1e-6° for a 200-train sample (port the spike's `natXY` into the test as
the oracle); (d) `bun test` snapshots unchanged (proves `prepTrainPath` is a pure refactor).
Acceptance: heap delta of `buildNational` ≤ 30 MB (`process.memoryUsage()` in the test, logged).

**P1.2 Render seam in `MapCtx`** — *parallel.*
Files: `web/src/components/map/context.ts` (`render: () => void` on `MapCtx`, default set by
the host), `render.ts` (export `draw`; `scheduleDraw` calls `M.render`), `anim.ts`,
`camera.ts`, `api.ts`, `pointer.ts`, `MapCanvas.tsx` (replace direct `draw(M)` calls with
`M.render()`; `MapCanvas` sets `M.render = () => draw(M)`), `camera.ts resize()` (measure
`wrapRef`; size the 2D canvas only when `canvasRef.current` exists).
Tests: none new (behaviour-neutral). Acceptance: `shots.mjs` vs `main` = **0 differing
pixels** on all 28 scenarios; typecheck green.

**P1.3 Deck host + camera conversion** — *sequential after P1.2.*
Files: new `web/src/lib/camera.ts` (`viewToViewState(view, W, H)`, `viewStateToView(vs, W, H)`,
`zoomBounds(fitScale)`), new `web/src/components/map/deck/DeckHost.tsx` (imperative `Deck`
with `canvas` = our own `<canvas>` inside `div#map`, `views: [new OrthographicView({id: 'map', flipY: false})]`,
controlled `viewState` from `S.current.view`, `onViewStateChange` → `viewStateToView` →
`S.current.view` + `interacted = true` + `M.render()`, `controller` per row 28,
`useDevicePixels` per D8, `onError` → context-loss notice + re-create (`finalize()` then new
`Deck`), `onAfterRender` → overlay draw + Legend + scale bar + view report, `window.__deck`
debug handle), new `deck/labelsOverlay.ts` (canvas sizing + train tag), new
`deck/layers/backdrop.ts` (outline fill/stroke, dashes, graticule, network), `TailLayer.ts`,
new `web/tests/camera.test.ts`.
Tests: round trip `viewStateToView(viewToViewState(v)) ≈ v` (1e-9) on random views; M8
projection test (1e-6 px) using `@deck.gl/core` under Bun **[measured: imports without WebGL]**;
zoom bounds equal `log2(fitScale·0.55)` / `log2(fitScale·60)`.
Acceptance: with `?national=1` and no data, the host mounts, draws outline + network, pans
and zooms with the same clamps; `panZoomTo`/`fitCountry` from the toolbar move the deck view.

**P1.4 Build: lazy hashed deck chunk + stale-chunk recovery** — *parallel.*
Files: `web/bundle.mjs` (delete the `Bun.build` branch per D14; esbuild
`format: 'esm', splitting: true, outdir: 'dist', entryNames: '[name]', chunkNames: 'assets/[name]-[hash]',
metafile: true, write: false`; order: bundle → `rmSync('dist')` → copy `public/` → write hashed
packs → write chunk outputs → inline the entry output into the template → assert via the
metafile that **no input under `node_modules/@deck.gl` or `node_modules/@luma.gl` is in the
inlined entry**, exit 1 otherwise → print each chunk's min/gzip/brotli size and exit 1 if the
deck chunk > 300 KB brotli), `web/index.template.html` (`<script type="module">/*__BUNDLE__*/</script>`),
`web/src/staleReload.ts` (`importFailureDecision(lastReloadAt, now, online)` pure;
`maybeReloadForFailedImport()` with the same `RELOAD_KEY` cooldown and notice), new
`web/src/components/map/deck/load.ts` (`loadDeck(): Promise<typeof import('./DeckHost')>`
wrapping `import()` and calling `maybeReloadForFailedImport` on rejection),
`web/tests/staleReload.test.ts` (+ cases: offline → error; within cooldown → error; otherwise
reload), `.github/workflows/ci.yml` (no change needed: `bun run build` now enforces the size
and split assertions).
Acceptance: `dist/index.html` contains the entry only; `dist/assets/` has exactly one
`DeckHost-*.js` chunk (plus any shared chunks, each listed in the build log); loading the
page without national mode fetches **zero** `assets/*.js` (puppeteer request log); toggling
national fetches the chunk once; `vercel.json` `immutable` header applies (path under
`/assets/`); M6 ≤ 300 KB brotli; a simulated 404 on the chunk (serve.mjs flag) shows
`RELOAD_NOTICE` and reloads once, then shows the error on the second failure within 60 s.

**P1.5 National layers + mode + clock** — *sequential after P1.1, P1.3, P1.4.*
Files: new `deck/layers/national.ts` (dots, tails, dwell rings from the frame buffer),
`DeckHost.tsx` (national frame loop: `M.render()` → `natPositions` → `setProps({layers})`),
`web/src/components/MapCanvas.tsx` (`national` prop: mounts `DeckHost` via `React.lazy(loadDeck)`
instead of `<canvas id="map">`; loading overlay while the chunk/timelines load),
`web/src/App.tsx` (`national` state from `?national=1`; `TimelineScrubber` shown when
`direction === 'out' || national`; city panel closed on entering national),
`web/src/components/Toolbar.tsx` (toggle "National · beta", D11), `web/src/hooks/useUrlState.ts`
(`national=1` in the URL), `web/src/components/map/anim.ts` + `context.ts` (`AnimState.national`,
`AnimState.running`; in national mode `activeTimeline()` is `undefined` so `totalMins` is
1440 and the clock wraps; `departed = running`, `total = nat.n`, `arrived = 0`),
`web/src/components/TimelineScrubber.tsx` (labels "Running" / "Trains" when `state.national`;
the "jump to finish" button hidden), `web/src/lib/palette.ts` (RGBA helpers).
Tests: `anim` state in national mode (`totalMins 1440`, wrap at 1440 → 0) via a small
`MapCtx` fixture in `tests/animation.test.ts`; `palette` RGBA equals the CSS strings parsed.
Acceptance: M1/M2/M4/M7 thresholds hold on the real build (perf driver, numbers in the PR);
dots at 00:30 include overnight trains (compare count to the P1.1 test value); wheel zoom
factor matches `exp(−deltaY·0.0016)` within 5 % for deltaY ±100 (driver: dispatch wheel,
read `S.current.view.scale`); national ↔ origin switch keeps centre lon/lat within 1e-6° and
scale within 1e-6 (same `S.current.view`); `shots.mjs` on the **origin view** vs `main` = 0
differing pixels (Canvas path untouched).

**P1.6 Picking, tooltip, modal** — *sequential after P1.5.*
Files: new `web/src/lib/tooltip.ts` (HTML builders moved from `interaction.ts`; `interaction.ts`
imports them), `DeckHost.tsx` (`onHover` only when `event.srcEvent.pointerType === 'mouse'`
and paused; `onClick` → `onSelectTrain(code)`; tooltip at `info.x/y` with today's edge
flipping), `deck/layers/national.ts` (`pickable: !animPlaying`).
Tests: `tooltip.ts` builders return today's strings for a fixture train/station/segment
(string equality against the current `showTooltip` output captured once into the test).
Acceptance: pause → hover a dot → tooltip; click → `TrainScheduleModal` opens for that code;
no hover tooltips from touch (driver uses `page.touchscreen`).

**P1.7 Device pass and release** — *sequential after P1.6; owner steps in it.*
Agent: `fps=1` meter; `deviceMemory`/touch DPR cap (D8); a11y live region ("2,668 trains
running at 18:15") from `getAnimState`; §11 updated. **[owner]**: M3 on the two phones;
trackpad/mouse/touch feel checklist (R8). Acceptance: 62 + new tests green; `bun run build`
assertions green; owner records M3 in §11 (a fail re-opens D8, not Phase 1).

**Deleted in Phase 1:** nothing in the origin view. The spike's
`components/map/national.ts` is not carried over.

### Phase 2: migrate the origin view, then remove Canvas (9–13 days)

**Phase 2a: extract the semantics (pure; both renderers consume them). Zero-diff PRs.**
Each 2a PR ends with `shots.mjs` vs the previous `main` = **0 differing pixels** on all 28
scenarios (the drivers from P0.1), otherwise it does not merge. 2a.1 ∥ 2a.2 ∥ 2a.3 touch
disjoint files and can run in parallel.

**P2a.1 `lib/ferry.ts` + `lib/camera.ts` fit maths** — Files: new `lib/ferry.ts`
(`splitFerry(set) → {landPieces, waterPieces}` by the existing lat 20.10/20.18, lon
109.9–110.4 rule; one `isFerrySection(bb, s)` helper replacing the 6 copies in `backdrop.ts`,
`flows.ts` ×3, `interaction.ts`), `lib/camera.ts` (+ `fitExtentView`, `fitCountryView`,
`fitHomeView`, `stationT(view, fitScale)` as pure functions; `components/map/camera.ts`
delegates). Tests: `ferry.test.ts` (the known ferry sections split into exactly one water
piece each; every other section is unchanged); `camera.test.ts` (+ fit maths equals the
current `fitExtent` on 100 random extents).

**P2a.2 `lib/mapModel.ts` for flows / chords / infra / isolation** — Files: new
`lib/mapModel.ts` (`flowPasses(state) → {items: {s, n}[], alpha, maxN, pickable}[]`,
`chordVisibility`, `infraPasses`, `isolatedCorridor`, `getDestSectionCounts`,
`getActiveDestSectionCounts` as pure functions of `{cur, baseCur, dir, animTime, animEnabled,
showInfra, panelDest, iso, dark}` + caches passed in), `components/map/flows.ts` (drawing only;
calls `mapModel`), `interaction.ts pickSegment` (uses the same `flowPasses` to decide
pickability). Tests: new `mapModel.test.ts` on the fixture origins: (a) no selection, not
animated → one pass α 1; (b) selected city → context α 0.16/0.18 + focus pass equal to
`getDestSectionCounts`; (c) filtered view → context = `baseFlows` α 0.16/0.18, focus =
filtered; (d) isolated → context α 0.06/0.08 + corridor; (e) animated at step k → focus
items equal `secFlowSteps[s][k]`; (f) chord gating: a chord is visible only after its first
departure; (g) `flowPasses` at `animTime ≥ totalMins` equals the static flows (mirrors
`animation.test.ts`).

**P2a.3 `lib/mapModel.ts` stations + `lib/labels.ts`** — Files: `lib/mapModel.ts`
(`stationStates(state, sel) → {idx, r0, kd, alpha, ripple?: {frac}}[]`, the destination-window
rule via `lib/stopEffects.ts`; `getSelCache`/`isTrainShown` moved here from `map/trains.ts`),
new `lib/labels.ts` (`placeLabels(points, view, W, H, measure) → {text, x, y, align, box, style}[]`,
ported from `drawLabels` with `measureText` injected), `components/map/stations.ts` (draw only),
`components/map/trains.ts` (imports from `mapModel`), `anim.ts` (imports `getSelCache` from
`mapModel`). Tests: `mapModel.test.ts` (+ (h) with a destination selected, no ripple time is
later than the train's `arrMins` at the destination and no train is shown after it — the
`82e0f22` rule; (i) dimmed alpha 0.16/0.18 for non-selected cities); new `labels.test.ts`
(deterministic placement for 北京/上海/广州 at national fit with a stub `measure = 7·chars`;
the origin label is always placed; no two boxes overlap).

**Phase 2b: deck adapters behind `?renderer=deck` (4–6 days).** Sequential after 2a.
P2b.1 → P2b.2 → P2b.3 → P2b.4 are sequential (they share `DeckHost.tsx`), but P2b.1's
layer files can be written by two agents if split as `layers/flows.ts` vs `layers/stations.ts`
with the host wiring done last in one PR.

**P2b.1 Flow / infra / chord / highlight layers** — Files: new `deck/layers/flows.ts`
(binary `PathLayer` per set, `DataFilterExtension` for `n = 0`, context pass pre-blended per
D3, focus pass, infra, chords with `PathStyleExtension`, highlight), `DeckHost.tsx`
(`renderer === 'deck'` mounts the origin layer stack; `?renderer=` parsed in `App.tsx`).
Tests: new `layers.test.ts`: given a `flowPasses` output, the builder returns the expected
`data.length`, `updateTriggers` keys, and `getWidth(index)` equals `n·WIDTH_K/fitScale`,
`getFilterValue` equals `n` (no GPU; `@deck.gl/layers` constructs under Bun).

**P2b.2 Station / origin / train layers + overlay labels** — Files: new `deck/layers/stations.ts`,
`deck/layers/trains.ts`, `deck/labelsOverlay.ts` (+ city labels from `lib/labels.ts`, origin
diamond, boxed origin/selected). Tests: `layers.test.ts` (+ station radius equals
`stationR(n)·stationZoomK(r0, t)`; ripple ring radius `r + frac·7·kd` and alpha `1 − frac`).

**P2b.3 Interaction parity** — Files: new `lib/pick.ts` (`pickPriority`), `DeckHost.tsx`
(`onHover`/`onClick`/pinned tooltip/`clearStationHover`/`selectDestByZh`), `interaction.ts`
(pick maths kept for the Canvas path until 2c). Tests: new `pick.test.ts`: candidates
`[train, station, seg]` → train; `[station d=10, origin d=10]` → origin; two segments within
0.75 px → the busier; a segment 1 px closer than a busier one beyond 0.75 px → the closer;
chords only when no segment and `direction === 'out'` and no destination selected.
Acceptance (driver): `onClick` with nothing under the pointer clears the selection
(`info.picked === false` path); tap on station pins the panel; hover only for mouse.

**P2b.4 Canvas vs deck screenshot parity** — Files: `web/tools/shots/cmp.mjs` thresholds.
Acceptance: all 28 scenarios `canvas` vs `deck` within **≤ 0.5 % differing pixels** at
tolerance 0.1 (pixelmatch), except `selected-city`/`class-filter-G`/`isolated-train-mid`
where D3's opaque context pass is allowed **≤ 2 %**; any scenario above threshold is listed
in the PR with a side-by-side PNG and an explicit owner sign-off line. Interaction checklist
(pan, wheel, pinch, fit buttons, URL camera restore, scale bar km/mi, selection, isolation,
class filter, histogram filter, inbound, play/seek, night, DPR 1/2/3) recorded in the PR.
Perf: origin view p95 rAF ≤ 16.7 ms on M4 Max during animation (perf driver, origin mode).

**Phase 2c: flip the default, then delete (1–2 days).** Sequential after 2b.

**P2c.1 Flip** — `App.tsx`: default renderer `deck`; `?renderer=canvas` escape hatch kept
**for one release (≤ 14 days from merge; the PR body states the date)**.

**P2c.2 Delete Canvas** — on or after that date. Files deleted: `backdrop.ts` (240),
`flows.ts` drawing (`traceInto`, `tracePartialSec`, `strokeFlowList`, `drawInfra`, `drawChords`,
`drawHighlightSeg`), `stations.ts` and `trains.ts` drawing, `render.ts`, `pointer.ts`, the
`interaction.ts` pick maths, `BackdropCache`/`tailGradRef`/pointer state in `context.ts`, the
wheel and canvas handlers in `MapCanvas.tsx`; `MapCanvas.tsx` becomes the thin host of
`DeckHost`. Acceptance: no TS errors; tests green; `shots.mjs` vs the pre-deletion `main`
(deck mode) = 0 differing pixels.

### Phase 3: B (national flows) and A+B (3–5 days web + pipeline task)

**P3.1 Pipeline (D12)** — a national per-section flow table (`byClass` sums over all trains),
shipped as `atlas-v2-national.json.br` (fmt 7 or a new file; `DATA_FMT` check extended);
`pack-audit` goldens extended with the national totals. Scheduled with the ≈ 12k-train data.

**P3.2 B layer** — `deck/layers/national.ts` (+ flows `PathLayer`, class filter =
`Σ byClass[selected]` into `widthArr`). Test: per-section totals equal the pack audit.

**P3.3 A+B** — per-section cumulative entry counts per 5-min step from the national
timelines' `trainEntries` (≈ 7.5k sections × 288 × 2 B ≈ 4.3 MB) or precomputed by the
pipeline; D7 wrap semantics. Test: A+B at 24:00 equals B.

**P3.4 Optional comet mode** — only if D2 is toggled on and M4 passed.

---

## 5. Interim coexistence (two renderers)

| Concern | Plan |
|---|---|
| **Shape** | Mode switch, not stacking. Phase 1: deck mounted only in national mode; Phase 2b: selected by `?renderer`. Never both on screen |
| **Camera** | One source of truth for both: `S.current.view {scale, tx, ty}` in `MapCtx`. deck gets a controlled `viewState` from `lib/camera.ts viewToViewState` on every `M.render()`; `onViewStateChange` writes back through `viewStateToView`. No hand-off step, no per-frame mirror; the URL format is unchanged |
| **Input** | Whichever renderer is mounted owns pointer and wheel (deck controller vs `pointer.ts`); no shared listeners |
| **Shared state** | `anim.ts` clock, `MapApi`, tooltip DOM, scale-bar DOM, Legend: renderer-agnostic. `M.render()` is the only per-renderer dispatch |
| **If stacking is ever needed** | deck canvas on top with `pointer-events: none`, `controller: false`, `viewState` pushed from `S.current.view` inside the Canvas `draw()`. Not planned |
| **Duration** | Phase 1 start to 2c.2: ≈ 3–4 weeks calendar. The `?renderer=canvas` hatch lives ≤ 14 days after the flip |
| **Avoiding getting stuck** | (1) 2a makes both renderers consumers of `mapModel`; (2) Canvas drawing is frozen from 2b start (D10); (3) 2c.2 is a dated PR; (4) if 2b slips > 2 weeks, the owner re-decides (Canvas for origin, deck for national), no third state |

---

## 6. Testing strategy

| Layer | What | Where / CI |
|---|---|---|
| Data-level (existing) | 62 tests / 7 files (`decode`, `animation`, `snapshots`, `stopEffects`, `headingCount`, `stationBreakdown`, `staleReload`) **[measured: 62 pass]** | `bun test` in CI, unchanged |
| New pure tests | `camera`, `national`, `ferry`, `mapModel`, `labels`, `tooltip`, `pick`, `staleReload` (+ import failure) | `bun test` |
| Layer-props tests | `layers.test.ts`: builders return expected `data.length`, trigger keys, accessor values (no GPU; `@deck.gl/*` constructs under Bun **[measured for core]**) | `bun test` |
| Screenshot diff | `web/tools/shots/` (P0.1), 14 scenarios × DPR 1/2 | Local macOS GPU only (SwiftShader AA differs) |
| Headless WebGL smoke | build → serve → puppeteer `--use-angle=swiftshader --enable-unsafe-swiftshader` → no `pageerror`, `onAfterRender` fired, non-paper pixels | Added to CI in P1.5 |
| Context loss | `WEBGL_lose_context` lose/restore → notice, then a working map | Local + CI smoke |
| Perf | `web/tools/perf/national.mjs`: time sweep through the peak, `deck.metrics` + rAF p50/p95/max, CDP CPU throttle, renderer-string check | Local; numbers in §11 and `docs/benchmarks/` |
| Build assertions | deck chunk ≤ 300 KB brotli; no `@deck.gl`/`@luma.gl` input in the inlined entry; `--frozen-lockfile` | `bun run build` in CI (P1.4) |

### 6.1 Preserved behaviour rules and their checks

| Rule (where it lives today) | Check |
|---|---|
| Destination window: a train exists only until its arrival at the selected destination; stop effects only from visible trains at stops on that leg (`lib/stopEffects.ts`, `82e0f22`) | `stopEffects.test.ts` (unchanged); `mapModel.test.ts` (h); `shots` `selected-city` + `anim-1815` |
| Class-filtered heading count and station breakdown (`headingCount.test.tsx`, `stationBreakdown.test.ts`, `05bea87`, `f396026`) | Unchanged tests; the components are untouched by the migration |
| Minimize keeps the selection (`DestinationPanel.tsx`, `574f0cd`) | `shots` `selected-city-minimized` (map highlight identical to `selected-city`) |
| Stale-asset reload once per 60 s on a hashed pack 404 (`staleReload.ts`, `a58ccf1`) | `staleReload.test.ts` (unchanged) + new import-failure cases (P1.4) + the simulated-404 driver check |
| Backdrop toggles (`showNetwork`, `showOutline`, graticule) redraw correctly; no visible cache behaviour to preserve | `shots` `infra-on`, `national-fit`; toggle check in the P2b.4 checklist |
| Hover priority train > station/origin (origin wins ties) > segment (busier within ±0.75 px) > chord; train hover only when paused; hover only for mouse | `pick.test.ts`; P1.6 and P2b.3 driver checks |
| Tap on station selects, tap on train opens the modal, tap on segment pins the tooltip, tap on empty clears | P2b.3 driver checks |
| Camera clamps `fitScale·[0.55, 60]`; URL zoom format; keep centre on resize; Guangzhou initial fit | `camera.test.ts`; `shots` `guangzhou-initial`; P1.5 wheel check |
| Animation: wrap/tail speed-up ×2.5 after day 1 (origin), 1440 wrap (national) | `animation.test.ts` (+ national clock) |
| Isolated train corridor and chip | `mapModel.test.ts` (d); `shots` `isolated-train-mid` |

---

## 7. Risks and mitigations

| # | Risk | L / I | Mitigation |
|---|---|---|---|
| R1 | Version churn in deck.gl 9.x minors / luma.gl | M / M | Pin exact `9.4.0` for all `@deck.gl/*`; `bun.lock` committed; upgrades as deliberate PRs through the screenshot suite |
| R2 | Build integration: single inlined IIFE today, `index.html` `max-age=0` | H / M | P1.4: esbuild ESM + `splitting` with `chunkNames: 'assets/[name]-[hash]'` (immutable header already covers `/assets/(.*)`); entry inlined as `<script type="module">`; `</script` escaping kept; metafile assertion that deck never lands in the entry; stale-chunk recovery (C4) |
| R3 | WebGL2 unavailable / context loss. deck 9 requires WebGL2; on loss it calls `onError('WebGL context is lost')` and does not restore **[source]** | L / M | `onError` → notice "Map paused — tap to resume", `finalize()`, new `Deck` from retained CPU state (layers are pure functions of state). No WebGL2 → notice; panels/tables keep working (D9: no Canvas fallback). M12 gates the path |
| R4 | Mobile GPU memory | M / H (Trips), L (dots) | Section-ref dedup; no TripsLayer by default; DPR cap 2 per D8; M3 owner check |
| R5 | Accessibility | — | DOM surfaces unchanged; live region in P1.7 |
| R6 | Regression in selection/filter semantics | M / H | 2a extracts into `mapModel` **before** deck code, with zero-diff screenshots; one visibility function for dots, picking, counters and stop effects |
| R7 | Picking semantics drift | M / L | `pick.test.ts`; exact distances recomputed for the candidates |
| R8 | Interaction feel (wheel speed, inertia, tap threshold, pinch) | M / M | `scrollZoom.speed` calibrated (P1.5 numeric check); `inertia: false`; owner feel checklist in P1.7 |
| R9 | Hairline shimmer under MSAA | M / L | Raise 0.45–0.5 floors to 0.6 if the screenshot review shows it |
| R10 | Stuck with two renderers | M / H | §5 exit rules; dated 2c.2 |
| R11 | Data growth to ≈ 12k trains | certain / M | Dedup scales with refs; `?natSynth=12000` in every perf run |
| R12 | Bundler branches diverge | — | Resolved by D14 (esbuild only) |
| R13 | `TailLayer` shader injection breaks on a deck minor | L / L | 15 lines, covered by M13 and the screenshot suite; fallback `ArcLayer` |

---

## 8. What stays unchanged

- React UI outside the map: `DeparturesTable.tsx`, `Histograms.tsx`, `Legend.tsx`,
  `MapOverlays.tsx`, `CityPicker.tsx`, `ActiveFilterBar.tsx`, `DestinationPanel.tsx`,
  `TrainScheduleModal.tsx`, `AppHeader.tsx`. Small named edits only: `App.tsx`,
  `Toolbar.tsx` (toggle), `TimelineScrubber.tsx` (two labels in national mode).
- Hooks: `useSelection`, `useAnimationClock`, `useDialog`; `useUrlState` (+ `national`),
  `useAtlasData` (+ retained raw out-tables).
- `lib/`: `decode`, `filter`, `origin`, `stopEffects`, `format`, `geo`; `timeline`
  (+ exported `prepTrainPath`), `palette` (+ RGBA).
- Data packs (fmt 6) through Phase 2; `web/vercel.json` headers (the active config; the root
  `vercel.json` mirrors it); `staleReload` behaviour (extended, not changed).
- Owner rules: no MapLibre, no basemap tiles, no API keys. deck.gl standalone with
  `OrthographicView`, drawing our own outline and network.

---

## 9. Maintainability: custom render code before and after

`wc -l` of `web/src/components/map/*.ts` plus `MapCanvas.tsx` today **[measured]**; other
columns **[estimate]**.

| Module | Today | After P1 | After P2c | Notes |
|---|---:|---:|---:|---|
| `backdrop.ts` | 240 | 240 | 0 (→ ≈ 60 `deck/layers/backdrop.ts`) | Cache and ferry split go |
| `flows.ts` | 853 | 853 | 0 (→ ≈ 250 `mapModel` + ≈ 120 layers) | — |
| `stations.ts` | 432 | 432 | 0 (→ ≈ 200 `lib/labels.ts` + ≈ 80 layers + ≈ 50 overlay) | — |
| `trains.ts` | 278 | 278 | 0 (→ ≈ 90 `mapModel`, ≈ 60 layers) | — |
| `interaction.ts` | 439 | ≈ 250 | ≈ 80 glue + ≈ 190 `lib/tooltip.ts` + ≈ 60 `lib/pick.ts` | — |
| `pointer.ts` | 119 | 119 | 0 | deck controller |
| `camera.ts` | 187 | 187 | ≈ 60 glue + ≈ 110 `lib/camera.ts` | — |
| `render.ts` | 82 | 82 | 0 | — |
| `context.ts` | 275 | 280 | ≈ 150 | Pointer, backdrop, gradient state go |
| `anim.ts` / `api.ts` | 241 | 245 | ≈ 245 | Kept |
| `MapCanvas.tsx` | 216 | ≈ 230 | ≈ 120 | — |
| deck host (new) | — | ≈ 150 `DeckHost.tsx` + ≈ 120 `layers/national.ts` + ≈ 60 backdrop + ≈ 40 load + 15 `TailLayer` | ≈ 200 host + ≈ 400 layers + ≈ 50 overlay | — |
| **Total render-side** | **≈ 3,360** | **≈ 3,750** | **≈ 1,500** glue/layers + **≈ 750** pure tested `lib` | — |

---

## 10. Owner decisions: adopted defaults (override in writing)

| # | Question | Adopted default | Changed in review? |
|---|---|---|---|
| D1 | Phase 0 as go/no-go before any production change? | **Yes.** Agent gates: M1, M2, M4 (dots), M6, M7, M8, M9, M12, M13. M3/M10 are owner steps and do not block Phase 1 | Gate set made explicit (C7) |
| D2 | TripsLayer comet trails vs today's short straight tails? | **Straight tails** (`TailLayer`, C1). Comet mode only as a later optional toggle, only if M4 passes with simplified paths | Implementation changed (C1) |
| D3 | Faded context flows: opaque pre-blended colours? | **Yes** | — |
| D4 | "+400 KB" as transfer or minified size? | **Transfer size**; deck is a lazily loaded hashed chunk (217–262 KB) | — |
| D5 | Labels: overlay canvas / `TextLayer` / DOM? | **Overlay canvas**; DOM labels revisited for a11y after Phase 2 | — |
| D6 | Segment/chord picking: GPU + priority, or CPU picker? | **GPU candidates + `lib/pick.ts pickPriority`** with exact distances recomputed for the candidates (keeps the ±0.75 px rule) | Sharpened |
| D7 | A+B wrap semantics | **Cumulative since 00:00**; at 24:00 equals B | — |
| D8 | DPR cap on weak devices? | **Cap 2 in national mode when `navigator.deviceMemory ≤ 4` or `navigator.maxTouchPoints > 0`** (Safari has no `deviceMemory`) | Changed (C11) |
| D9 | Canvas fallback after Phase 2? | **No.** Notice + working tables/panels | — |
| D10 | Freeze Canvas drawing features from 2b? | **Yes** | — |
| D11 | National entry point | **Toolbar toggle "National · beta" + `?national=1`** | — |
| D12 | Separate pipeline task for B? | **Yes**, with the ≈ 12k-train data | — |
| D13 | What national mode shows and ignores | **Map-only mode:** outline, graticule, network, every covered train's dot/tail/dwell ring, wrap at 1440. Origin-specific map state (selection, filters, isolation, inbound flows, station dots, labels) is not drawn; entering national closes the city panel; the departures table and panels below the map keep working for the current origin; the scrubber shows Running / Trains | New |
| D14 | Production bundler | **esbuild via `node bundle.mjs`** (already the case on Vercel and CI); the `Bun.build` branch is deleted in P1.4 | New (C5) |
| D15 | `@deck.gl/react` or imperative `Deck`? | **Imperative `Deck`** owned by `DeckHost.tsx`, one `setProps` per `M.render()`; no `@deck.gl/react` | New (C14) |

---

## 11. Phase 0 results (filled in by P0.2 / P1.7)

| Metric | Result | Pass? | Who / date |
|---|---|---|---|
| M1 | — | — | — |
| M2 | — | — | — |
| M3 | — | — | owner |
| M4 | — | — | — |
| M5 | — | — | — |
| M6 | — | — | — |
| M7 | — | — | — |
| M8 | — | — | — |
| M9 | — | — | — |
| M10 | — | — | owner |
| M11 | — | — | — |
| M12 | — | — | — |
| M13 | — | — | — |

## Sources

- deck.gl 9.4.0 / luma.gl 9.4.x package source (npm `latest`, inspected locally):
  `@deck.gl/geo-layers/dist/trips-layer/*`, `@deck.gl/core/dist/viewports/orthographic-viewport.js`,
  `@deck.gl/core/dist/lib/deck.js` (metrics, `_onContextLost`, `useDevicePixels`),
  `@deck.gl/core/dist/lib/layer.js` (`use64bitPositions`), `@deck.gl/layers/dist/text-layer/*`,
  `@deck.gl/layers/dist/scatterplot-layer/*` (stroke inside radius),
  `@deck.gl/extensions/dist/{data-filter,path-style}`.
- deck.gl docs re-read 2026-10-24: orthographic-view (`flipY` default true), controller
  (`scrollZoom.speed` default 0.01, `inertia` default false), deck (`useDevicePixels` number,
  `pickMultipleObjects({x, y, radius, depth})`, metrics incl. `gpuTime` needing
  `deviceProps.debugGPUTime`), line-layer (**`getColor` only**), arc-layer
  (`getSourceColor`/`getTargetColor`, `getHeight 0` flat), path-layer (`startIndices`,
  `_pathType`), scatterplot-layer, trips-layer (float32 timestamps), path-style-extension
  (`dashUnits`), data-filter-extension (limits), developer-guide/performance (binary attributes;
  "when `data` changes the layer recalculates its GPU buffers").
- Spike: `spike/national-anim` @ `600b3de` (`web/src/lib/national.ts`,
  `web/src/components/map/national.ts`); scratchpad drivers `drv/nat2.mjs`, `perf.mjs`,
  `shots.mjs`, `clsshots.mjs`, `hcshots.mjs`, `minshots.mjs`, `cmp.py` (to be committed in P0.1).
- Bundle measurement: esbuild 0.28.2, `--bundle --minify --format=iife --target=es2020`;
  today's build re-run for this review: `bundle bytes: 392735`, `dist/index.html` 454,611 B,
  133,146 B gzip.
