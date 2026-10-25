# deck.gl migration plan: from the Canvas 2D renderer to deck.gl

Status: **approved for execution, phase by phase, on the integration branch `deckgl`.**
Each phase is a set of numbered, PR-sized tasks with files, tests, acceptance numbers and a
stop/go gate. The owner decisions D1–D16 (§10) are **adopted defaults**: implementers follow
them unless the owner overrides one in writing.
Baseline: the review measurements were taken at `origin/main` @ `05bea87`; the integration
branch **`deckgl` exists at `cecf4d2`** (= current `main`, which includes PR #23's pack
rebuild). Pack-dependent numbers quoted here (2,668 trains at 18:15, 62 tests, section counts)
are re-verified on the current pack in P0.1 and corrected in §11 if they moved. Target
library: **deck.gl 9.4.0** (npm `latest`, re-checked 2026-10-24) on **luma.gl 9.4.x**. Spike
reference: `spike/national-anim` @ `600b3de`.

**Order of work (owner rule):** the origin view must work on deck first, with the current
interface and behaviour intact; only then the national (whole-network) view. Phase 0 spikes
the **origin** view on deck; Phase 1 migrates the origin view; Phase 2 adds the national
animation (A); Phase 3 adds national flows (B, A+B).

**Branch rules (owner rule):**

- All deck.gl work lives on the long-lived integration branch **`deckgl`** (exists;
  `cecf4d2` = `main` at the time of writing). **Nothing from this plan lands on `main`
  directly**, including tooling.
- Every task PR targets **`deckgl`** (`gh pr create --base deckgl`). PR #24 (this plan) also
  targets `deckgl`.
- The renderer flip (P1c.1) and the Canvas deletion (P1c.2) happen on `deckgl` only.
- **`deckgl` → `main` is one explicit owner gate (G-MAIN, D16).** No agent opens or merges
  that PR; the owner does.
- `deckgl` takes `main` in by a "sync PR" (`git merge main` into `deckgl`) at least weekly
  and before every parity run. The sync PR author runs
  `git diff <last-sync>..main -- web/src/components/map web/src/components/MapCanvas.tsx`
  and mirrors any Canvas-side change into `lib/mapModel.ts` / the deck layers in the same
  PR, so parity never silently drifts (R10).
- Spike branches (`spike/deckgl`) fork from `deckgl` and are never merged.

Where this plan states a number, the source is given: **[measured]** means measured for
this plan or in the spike, **[source]** means read from the deck.gl 9.4.0 package source,
**[docs]** means read from deck.gl's published 9.x API reference, and **[estimate]** means
a guess that Phase 0 must replace with a measurement.

---

## Review changes (2026-10-24, second pass against the code and the deck.gl docs; third pass for the owner's reorder)

What changed and why. Everything below is folded into the sections.

| # | Finding | Change |
|---|---|---|
| C1 | **`LineLayer` has no `getSourceColor`/`getTargetColor`** (only `getColor`) **[docs]**. The gradient-tail plan was wrong. | Tails are a `TailLayer extends LineLayer` (~15 lines: `getShaders()` injects `vColor.a *= positions.x`, fading source→target). Phase 0 M13 verifies; fallback `ArcLayer({getHeight: 0, numSegments: 2})` (has per-end colours **[docs]**), last resort a solid tail at α 0.6 (visible change, owner notified). |
| C2 | Dot "stroke trick" numbers were inconsistent. `ScatterplotLayer` draws the stroke **inside** the radius **[source]**. | `getRadius: 4`, `getLineWidth: 2`, pixels: ring 2–4 px (class colour), core 0–2 px (white). Isolated: 5.5 / 2.7. |
| C3 | "A section with `n = 0` gets width 0" would be re-grown to 0.5 px by `widthMinPixels`. | Visibility of `n = 0` sections via `DataFilterExtension` (`getFilterValue = n`, `filterRange [0.5, 1e9]`), never via width. |
| C4 | `staleReload.ts` matches only hashed `.json.br` 404s; a lazily imported deck chunk that 404s after a deploy is an `import()` TypeError with no status, so an old tab would never self-heal. | New pure `importFailureDecision()` + `maybeReloadForFailedImport()` with the same 60 s cooldown; tests in `staleReload.test.ts`; the deck loader calls it on rejection. |
| C5 | `"build": "node bundle.mjs"` runs under Node on Vercel and CI, so production already uses the **esbuild** branch; the `Bun.build` branch is dead for prod. | D14: esbuild is the one bundler; the Bun branch is deleted in P1.1. Concrete esbuild split options in §7 R2. |
| C6 | `draw(M)` and `resize(M)` are canvas-bound (`anim.ts`, `camera.ts`, `api.ts`, `pointer.ts` import `draw`; `resize` returns early without a `<canvas>`). | P1.0 adds `M.render()` to `MapCtx`; hosts set it. `resize()` measures `wrapRef` and sizes the 2D canvas only if present. The camera stays `S.current.view` for both renderers; conversion per view-state event (§5). |
| C7 | Phones cannot be an agent gate (no devices). `drv/nat2.mjs` launches `headless: true`, which can land on SwiftShader. | Phone checks are **owner steps**. The perf driver prints `UNMASKED_RENDERER_WEBGL` and **fails if it contains "SwiftShader"**; `--headed` rerun. |
| C8 | `gpuTimePerFrame` is disabled unless `deviceProps: {debugGPUTime: true}` **[docs]**. | Set in the perf harness only. |
| C9 | The `mapModel` extraction was right but one lump, and the zero-diff screenshot tooling it depends on did not exist. | Drivers land first (P0.1, on `deckgl`); the extraction is three zero-diff PRs (P1a.1 camera/ferry/tooltip, P1a.2 `mapModel` flows, P1a.3 stations/labels). |
| C10 | National mode semantics were undefined. | D13 defines national mode; `AnimState` gains `national`/`running`; two scrubber labels change (`TimelineScrubber.tsx`, previously claimed unchanged). |
| C11 | D8 relied on `navigator.deviceMemory`, absent in Safari. | D8: cap DPR at 2 in national mode on `deviceMemory ≤ 4` **or** any touch device. |
| C12 | Preserved behaviour rules lacked named checks. | §6.1 maps every rule to a test or acceptance check. |
| C13 | Verified and kept: projection formulas; `flowWidth` ↔ `widthUnits:'common'` + `widthMinPixels 0.5`; 62 tests / 7 files; 3,146 lines; bundle 392,735 B JS, `index.html` 454,611 B / 133,146 B gzip; deck.gl 9.4.0 = npm latest; `dashUnits:'pixels'` **[docs]**; DataFilter `filterSize ≤ 4`, 128 categories **[docs]**; `useDevicePixels` number **[docs]**; 8 MB ref estimate. TripsLayer GPU estimate tightened to ≈ 45–60 B/vertex. | — |
| C14 | `@deck.gl/react` vs imperative `Deck`: decided. | D15: imperative `Deck` driven from `MapCtx`; no `@deck.gl/react`. |
| C15 | **Owner feedback (third pass):** all work on the `deckgl` integration branch, never on `main`; origin-view compatibility first, national second; `deckgl` → `main` is an explicit owner gate. | Branch rules above; phases reordered (Phase 0 = origin spike with national numbers secondary; Phase 1 = origin migration incl. flip and Canvas deletion on `deckgl`; Phase 2 = national A; Phase 3 = B/A+B); task IDs and dependency graph rewritten; new D16 (merge timing); §2.5, §9, §11 re-cut to the new order. |

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
  `assets/`; `index.html` stays the revalidated entry. (Once deck is the default renderer the
  chunk is fetched on first paint, so the lazy load buys little on the origin view; it still
  keeps `index.html` small and immutable-cached deck bytes across deploys.)
- **Origin view first.** Phase 0 spikes the origin view on deck (flows, stations, trains,
  picking, labels overlay) and measures parity against the committed screenshots; the
  national peak numbers are collected as secondary information for Phase 2's gate.
- **Most of the complexity is semantics, not drawing.** `flows.ts` (853 lines) is mostly
  "which sections, at what alpha and width, under which selection / animation / isolation
  state". That moves to pure, tested `lib/` functions **before** any deck layer is written
  (Phase 1a, zero screenshot diff), so a semantic rule lands once and both renderers consume it.
- **The spike's 16.6 ms Canvas cost (national) comes from the tails, not the position maths.**
  On deck the dots are one `ScatterplotLayer`, the tails one `TailLayer` (C1), both reading an
  interleaved `Float32Array` as binary attributes. Expected CPU per frame well under 2 ms
  **[estimate]**. TripsLayer stays optional (180–400 MB GPU without simplification).
- **Coexistence is a switch, not a stack.** On `deckgl`, `?renderer=deck` selects the deck
  origin renderer (P1b); the flip makes it the default (P1c.1); Canvas is deleted (P1c.2).
  Both renderers share `MapCtx` (camera `S.current.view`, animation clock, tooltip and
  scale-bar DOM); only `M.render()` differs.
- **Labels stay off-deck** on a thin overlay canvas drawn in `onAfterRender` (D5).
- **Effort.** Phase 0: 1.5–2.5 days. Phase 1: 10–14 days. Phase 2: 4–6 days. Phase 3: 3–5
  days of web work plus the pipeline task.

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
| 19 | Origin marker (disc + diamond) | `drawStations` | Disc: `ScatterplotLayer`; diamond: label overlay canvas | Avoids an `IconLayer` atlas |
| 20 | Train dots: glow r4 + white core r2, α 0.45 on chords | `trains.ts drawTrains` | One `ScatterplotLayer`: `getRadius 4`, `getFillColor` white, `stroked`, `getLineWidth 2`, `getLineColor` class colour (C2) | One draw call |
| 21 | Gradient tails 12 px × speedFrac (22 isolated), width 2.5 (3.5) | `drawTrains` (save/rotate/stroke per train) | `TailLayer` (C1): source = pos − heading·len/scale, colour fades to α 0 at the source | Length ∝ 1/scale so it stays 12 px |
| 22 | Dwell ring (r 6.5, α 0.85, 1.3 px) | `drawTrains` | `ScatterplotLayer` stroked-only on dwelling dots | — |
| 23 | Hover/selected/isolated train ring + code tag | `drawTrains` | Ring: `ScatterplotLayer` (0–2). Tag: label overlay canvas | — |
| 24 | City labels (collision-aware, tiers by zoom, boxed origin/selected) | `stations.ts drawLabels` (≈ 250 lines) | Placement → pure `lib/labels.ts`; drawing → overlay canvas | §1.2 |
| 25 | Hover tooltip (HTML) | `interaction.ts showTooltip` (≈ 190 lines) | **Unchanged** DOM `#tooltip`; builders → `lib/tooltip.ts` | Positioned from `info.x/y` |
| 26 | Hit-testing: train (14 px, paused only) > station (`14·zoomK`) / origin (15 px, wins ties) > segment (10 px, busier wins within ±0.75 px) > chord | `interaction.ts pick*` | `pickMultipleObjects` + pure `lib/pick.ts pickPriority` (D6), P1b.4 | §2.5 |
| 27 | Tap-select / tap-empty-clears / pinned tooltip | `pointer.ts endPointer` | `Deck.onClick(info, event)` | P1b.4 verifies `onClick` fires with `picked:false` |
| 28 | Pan / wheel / pinch, clamp `fitScale·[0.55, 60]` | `pointer.ts`, `camera.ts zoomAt`, wheel listener in `MapCanvas.tsx` | `OrthographicController` `{dragPan, scrollZoom:{speed}, touchZoom, inertia:false, dragRotate:false, keyboard:false, doubleClickZoom:false}` **[docs]**; `minZoom/maxZoom` in `viewState` | Wheel calibrated to `exp(−deltaY·0.0016)` in P1b.1 |
| 29 | Fit country / home / Guangzhou initial / `panZoomTo` / `initialCamera` / keep centre on resize | `camera.ts fit*`, `resize` | Same maths on `S.current.view`; `lib/camera.ts` converts to/from `viewState` | `MapApi` unchanged |
| 30 | Scale bar | `camera.ts updateScaleBar` | Unchanged; called from `M.render()` | — |
| 31 | URL view report (debounced) | `reportViewChange` | Unchanged; URL zoom `log2(scale·360/256)` kept | — |
| 32 | Day / night | `lib/palette.ts palette(dark)` | Add RGBA tuple variants; `dark` in colour triggers | Strings stay for DOM/Legend |
| 33 | DPR cap 3 | `resize` | `useDevicePixels: Math.min(3, devicePixelRatio)` (cap 2 per D8 in national mode) | — |
| 34 | Origin-switch fade (`#map.switching`) | `MapCanvas.tsx` | Same class on the deck host `div#map` | — |
| 35 | Legend sync | `render.ts` | From `M.render()` | SVG, stays |
| 36 | Animation clock | `anim.ts` | **Kept**; calls `M.render()` | Scrubber/modal subscribe unchanged (Phase 2 adds two labels, C10) |
| 37 | Loading / error / stale overlay, isolation chip, timeline button | `MapCanvas.tsx`, `MapOverlays.tsx` | **Unchanged** | — |

Everything outside `components/map/` and `MapCanvas.tsx` stays unchanged except the small,
named edits in the task lists (`App.tsx`, `Toolbar.tsx`, `TimelineScrubber.tsx`,
`useUrlState.ts`, `useAtlasData.ts`, `bundle.mjs`, `index.template.html`, `staleReload.ts`).
**The `MapApi` interface in `context.ts` is the seam**; it does not change.

### 1.1 Target module layout (after Phase 1c)

```
web/src/lib/               (pure, bun-testable; no deck imports)
  camera.ts      View {scale,tx,ty} <-> viewState {target,zoom}; fit maths; zoom clamps; scale-bar distance
  mapModel.ts    flow passes for every selection/animation/isolation state; chord gating; station
                 states (radius inputs, ripple, alpha); isolatedCorridor; selection cache rule
                 (getSelCache / isTrainShown, moved from map/trains.ts; delegates to stopEffects)
  labels.ts      label candidates + collision placement (from drawLabels; returns boxes + text)
  tooltip.ts     tooltip HTML builders (from interaction.ts)
  ferry.ts       one-time land/water split of the ferry sections
  pick.ts        pickPriority(candidates, px, py, project)
  national.ts    (Phase 2) national per-train timelines on section refs
  (unchanged)    decode, filter, origin, timeline(+prepTrainPath in Phase 2), stopEffects, palette(+RGBA), format, geo
web/src/components/map/
  deck/DeckHost.tsx          Deck instance, controller, lifecycle, context loss, onAfterRender → overlay
  deck/TailLayer.ts          LineLayer subclass with the source→target alpha fade (C1)
  deck/layers/{backdrop,flows,stations,trains}.ts   props builders only (pure given inputs)
  deck/layers/national.ts    (Phase 2)
  deck/labelsOverlay.ts      thin 2D canvas: labels, origin diamond, train tag
  deck/load.ts               lazy import() of the deck chunk + stale-chunk recovery (C4)
  anim.ts, api.ts, camera.ts, context.ts   kept (camera.ts shrinks to resize/report glue)
```

### 1.2 Why labels stay outside deck (D5 adopted: overlay canvas)

| Option | Pros | Cons |
|---|---|---|
| **Overlay 2D canvas (adopted)** | Pixel-identical text (native CJK shaping, system font fallback); keeps today's placement; ≈ 40 lines of drawing | One extra canvas; redraw on every deck frame (≤ ≈ 60 labels, cheap) |
| `TextLayer` (`characterSet:'auto'`, `background:true`) **[source]** | All on GPU | SDF text at 10.5–14 px is softer than native, especially thin CJK strokes; atlas rebuilds on new characters; collision still JS |
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
| `atlas-v2-out-tables` (1,650 KB: `paths`, `stop_pos`, `chords`, per-origin `dep_off`) | `expandOutTables` → `DepVM.secs / path / stopPos / chordLegs` | Origin timeline; **national timelines** (Phase 2 retains the raw `paths`/`stop_pos`/`chords` in `useAtlasData`) |
| `atlas-v2-in-tables` (1,796 KB) | `ArrVM` rows | Inbound panels/flows |
| `atlas-v2-schedules` (416 KB) | `DecodedAtlas.schedules` | Dwells; national stops (already fetched together with out-tables) |

`lib/` changes are additive only: `palette.ts` RGBA helpers; `camera.ts`, `mapModel.ts`,
`labels.ts`, `tooltip.ts`, `ferry.ts`, `pick.ts` extracted (Phase 1); `national.ts` and
`timeline.ts prepTrainPath` (Phase 2). `filter.ts`, `origin.ts`, `stopEffects.ts`,
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
- **Animated dots (origin and national).** CPU writes an interleaved `Float32Array`
  (6 floats per dot: lon, lat, ux, uy, speed, flags). `getPosition: {value: buf, size: 2, stride: 24, offset: 0}`;
  colour from a parallel `Uint8Array(c·4)` filled in the same loop. A **new** `data` object
  `{length: c, attributes}` per frame (deck recalculates that layer's attributes when `data`
  changes **[docs]**; for external typed arrays that is a re-upload of ≈ c × 28 B).
- **Tails.** `Float32Array(c·4)` (source xy, target xy) in the same loop → `TailLayer`.
- **Small per-frame sets** (ripples, dwell rings, highlight rings, isolated corridor): plain
  arrays (≤ a few hundred items).

### 2.3 National timelines and memory (A, Phase 2)

The spike (`lib/national.ts buildNational`) expands every train's path into its own vertex
arrays: **3.97 M vertices ≈ 48 MB** CPU, against **≈ 691 K section refs** **[measured, spike]**.
At ≈ 12k trains: ≈ 6.8 M vertices ≈ 82 MB **[estimate, linear]**.

**Dedup (P2.1).** Keep per-train **section refs plus cumulative starts**, like the origin
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
`n ≈ 12,000` (perf runs only; never on by default).

### 2.4 TripsLayer (optional comet mode; after Phase 2, only if M4n passes)

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
vertices **[estimate]**, which Phase 0 M4n measures if time allows.

### 2.5 Picking

| Target | Phase 1 (origin view) | Phase 2 (national) |
|---|---|---|
| Train dots | deck GPU picking on the dots layer (`pickable: !animPlaying`, Deck `pickingRadius: 14`); `info.index` → slot in the frame buffer → train | Same |
| Stations / origin | Stations layer pickable; radius rule (`14·zoomK`, origin 15 px, origin wins ties) applied in `pickPriority` over `pickMultipleObjects({x, y, radius: 15, depth: 10})` candidates | — (D13: no station dots in national mode) |
| Sections / chords | D6: candidates from `pickMultipleObjects`; `lib/pick.ts pickPriority` recomputes the exact screen distance (`distToSeg` over the ≤ 10 candidates' polylines via `viewport.project`) and applies today's order and the ±0.75 px "busier section wins" tie-break. `flows-context` is `pickable: false` (today a filtered-out section is not pickable either) | Phase 3 (B) |

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

Conventions for every task: one PR per task unless marked "same PR", **base branch `deckgl`**;
`bun run typecheck`, `bun run build` and `bun test` green; **no `test.skip`/`.only`/TODO
stubs**; the PR description quotes the acceptance numbers it measured. "Parallel" means the
task touches no file another in-flight task touches. Tasks marked **[owner]** are performed
by the owner, reported in §11, and never block agent tasks unless stated. "Baseline shots"
means the 28 PNGs produced by building `deckgl` at the merge-base of the PR (the Canvas
renderer) with `web/tools/shots/`.

### Phase 0: tooling + origin-view spike on deck (1.5–2.5 days). Go / no-go gate

**P0.0 Integration branch** — done: `origin/deckgl` exists at `cecf4d2` and PR #24 targets
it. Each agent starts a task with `git fetch origin && git checkout -b <task> origin/deckgl`
and verifies `git merge-base --is-ancestor origin/main origin/deckgl` (if not, a sync PR comes
first). Sequential first.

**P0.1 Commit the measurement drivers (PR → `deckgl`)** — *sequential after P0.0; everything else waits on it.*
Files: new `web/tools/shots/shots.mjs`, `web/tools/shots/cmp.mjs` (pixelmatch-style diff,
ported from scratchpad `drv/shots.mjs`, `clsshots.mjs`, `hcshots.mjs`, `minshots.mjs`,
`cmp.py`), new `web/tools/perf/origin.mjs` and `web/tools/perf/national.mjs` (from
`drv/nat2.mjs`/`perf.mjs`), `web/tools/serve.mjs` (static `dist/` server with a `--404 <path>`
flag for the stale-chunk check), `web/package.json` (`devDependencies`: `puppeteer-core`;
scripts `shots`, `perf`), `web/src/App.tsx` (expose `window.__M` next to the existing
`window.__mapApi` debug handle). Scenarios in `shots.mjs` (each a named step and a PNG):
`national-fit`, `guangzhou-initial`, `city-zoom-x10`, `selected-city`,
`selected-city-minimized`, `isolated-train-mid`, `class-filter-G`, `inbound`, `infra-on`,
`night`, `anim-0600`, `anim-1815`, `anim-2350`, `labels-on`, at DPR 1 and 2 (28 PNGs).
Perf drivers print `UNMASKED_RENDERER_WEBGL` and **exit non-zero if it contains
"SwiftShader"** (C7); `--headed` relaunches with `headless: false`. `origin.mjs` plays the
origin animation on 广州 and sweeps `animTime` 360 → 1440 in 0.5-min steps for 300 frames.
Tests: none (tooling). Acceptance: `bun run shots -- http://localhost:8766 out/` writes 28
PNGs; `cmp.mjs a/ b/ --max 0.5` prints per-scenario mismatch % and exits 1 above the threshold.

**P0.2 Spike branch `spike/deckgl` (forked from `deckgl`, never merged)** — *sequential after P0.1.*
Files: `web/package.json` (add `@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/extensions`,
`@deck.gl/geo-layers` at exact `9.4.0`), a throwaway deck host behind `?renderer=deck` that
draws the **origin view**: backdrop (outline, graticule, network), flows (binary `PathLayer`
with per-section width/colour from `cur.flows`, context + focus passes for a selected city),
station dots, train dots + `TailLayer`, dwell rings, picking on dots and stations (hover
tooltip via the existing `showTooltip`), labels on an overlay canvas (reusing `drawLabels`
with a `project` shim). Secondary: a national dots path behind `?national=deck` reusing
`lib/national.ts` from `600b3de` as is, plus `?natSynth=N`. Spike code may be ugly; it is
deleted. Results appended to §11; screenshots attached to PR #24.

| # | Metric | How | Pass threshold | Who |
|---|---|---|---|---|
| **Origin view (primary)** | | | | |
| M1 | Frame time, origin animation playing on 广州, national fit, DPR 2, 1280×800 | `web/tools/perf/origin.mjs`: `deck.metrics.cpuTimePerFrame`, `gpuTimePerFrame` (`deviceProps: {debugGPUTime: true}`, C8), rAF interval p50/p95 over 300 frames | p95 rAF ≤ 16.7 ms; CPU ≤ 4 ms | agent (gate) |
| M2 | M1 under CDP `Emulation.setCPUThrottlingRate {rate: 4}` | as M1 | p95 ≤ 33 ms | agent (gate) |
| M4 | GPU memory, origin layer stack (广州 + selected city + infra on) | `deck.metrics.gpuMemory`/`bufferMemory` | ≤ 64 MB | agent (gate) |
| M6 | Bundle | `bundle.mjs` deck chunk min / gzip / brotli | ≤ 300 KB brotli | agent (gate) |
| M7 | Time to first deck frame on `?renderer=deck`, packs cached | `performance.now()` from `atlas` ready to first `onAfterRender` with flows drawn | ≤ 1.0 s on M4 Max; report at 4× throttle | agent (gate) |
| M8 | Projection exactness | unit test `OrthographicViewport.project` vs `camera.ts X/Y`, 1,000 random points × 5 zooms | ≤ 1e-6 px | agent (gate) |
| M9 | Headless SwiftShader smoke | `--use-angle=swiftshader --enable-unsafe-swiftshader`: build → serve → `?renderer=deck` | No `pageerror`; `onAfterRender` fired; non-paper pixels | agent (gate) |
| M12 | Context loss path | puppeteer: `WEBGL_lose_context.loseContext()` then `restoreContext()` | `onError` receives the loss; after re-creating `Deck` the map draws again, no `pageerror` | agent (gate) |
| M13 | `TailLayer` renders a fade | Zoomed moving train: pixel probe alpha at the source end < 10 %, head ≥ 90 % | Pass, or fall back per C1 and record which | agent (gate) |
| M14 | **Parity feasibility** | `shots.mjs` on the spike's `?renderer=deck` vs baseline shots for `national-fit`, `guangzhou-initial`, `city-zoom-x10`, `selected-city`, `anim-1815`, `night`, `labels-on` (DPR 2) | Each ≤ 5 % differing pixels (pixelmatch tolerance 0.1); any structural difference (missing element, wrong width class) listed with a cause | agent (gate; the real target is P1b.5) |
| M10 | Label rendering options | Side-by-side PNGs overlay vs `TextLayer` at national fit and city zoom | Eyeball | **[owner]**, informational |
| M3 | Real devices (origin view, animation playing): one mid-range Android (Snapdragon 7-series, Chrome), one iPhone (A15 class, Safari) | On-page FPS meter from `deck.metrics.fps` behind `?fps=1` | ≥ 30 fps sustained | **[owner]**, not a gate |
| **National (secondary; feeds the Phase 2 gate)** | | | | |
| M1n | Frame time at the national peak (18:15 = minute 1095, 2,668 trains; `?natSynth=12000` ≈ 4.6k active) | `web/tools/perf/national.mjs`, time sweep `1095 + i·0.2`, 300 frames | Report; Phase 2 needs p95 ≤ 16.7 ms, CPU ≤ 4 ms | agent (report) |
| M2n | M1n at 4× CPU throttle | as M1n | Report; Phase 2 needs p95 ≤ 33 ms | agent (report) |
| M4n | GPU memory, dots-and-tails; TripsLayer if built (simplified) | `deck.metrics` | Report; Phase 2 needs ≤ 64 MB (dots); Trips ≤ 150 MB to be eligible | agent (report) |
| M5n | CPU heap of the national build | heap delta | Report (spike ≈ 48 MB expected; P2.1 target ≤ 30 MB) | agent (report) |
| M7n | Time to first national frame | toggle → first `onAfterRender` with `c > 0` | Report; Phase 2 needs ≤ 1.5 s | agent (report) |
| M11 | TripsLayer dwell / zero-length segments | visual at a known long dwell | Report (only if Trips built) | agent (report) |

**Stop/go (G0).** Phase 1 starts only if **M1, M2, M4, M6, M7, M8, M9, M12, M13, M14** pass.
If M1–M2 or M14 fail structurally, stop: write the numbers into §11 and close PR #24 with a
recommendation (keep Canvas; optionally keep the spike's sprite variant for national). The
national numbers never block Phase 1.

### Phase 1: migrate the origin view on `deckgl` (10–14 days)

Dependency graph:
`P1.0` → (`P1.1` ∥ `P1a.1` ∥ `P1a.2` ∥ `P1a.3`) → `P1b.1` (needs P1.1, P1a.1) → `P1b.2`
(needs P1a.2) → `P1b.3` (needs P1a.3) → `P1b.4` → `P1b.5` → `P1c.1` → `P1c.2`.
`P2.1` (national timelines, pure) may start any time after P1.0; its files are disjoint.

**P1.0 Render seam in `MapCtx`** — *sequential first (touches files the 1a tasks edit).*
Files: `web/src/components/map/context.ts` (`render: () => void` on `MapCtx`, set by the
host), `render.ts` (export `draw`; `scheduleDraw` calls `M.render`), `anim.ts`, `camera.ts`,
`api.ts`, `pointer.ts`, `MapCanvas.tsx` (replace direct `draw(M)` calls with `M.render()`;
`MapCanvas` sets `M.render = () => draw(M)`), `camera.ts resize()` (measure `wrapRef`; size
the 2D canvas only when `canvasRef.current` exists). Tests: none new (behaviour-neutral).
Acceptance: `shots.mjs` vs baseline = **0 differing pixels** on all 28 scenarios; typecheck green.

**P1.1 Build: lazy hashed deck chunk + stale-chunk recovery** — *parallel after P1.0.*
Files: `web/bundle.mjs` (delete the `Bun.build` branch per D14; esbuild
`format: 'esm', splitting: true, outdir: 'dist', entryNames: '[name]', chunkNames: 'assets/[name]-[hash]',
metafile: true, write: false`; order: bundle → `rmSync('dist')` → copy `public/` → write hashed
packs → write chunk outputs → inline the entry output into the template → assert via the
metafile that **no input under `node_modules/@deck.gl` or `node_modules/@luma.gl` is in the
inlined entry**, exit 1 otherwise → print each chunk's min/gzip/brotli size, exit 1 if the
deck chunk > 300 KB brotli), `web/index.template.html` (`<script type="module">/*__BUNDLE__*/</script>`),
`web/package.json` (`@deck.gl/*` at exact `9.4.0`, `bun.lock` updated), `web/src/staleReload.ts`
(`importFailureDecision(lastReloadAt, now, online)` pure; `maybeReloadForFailedImport()` with
the same `RELOAD_KEY` cooldown and notice), new `web/src/components/map/deck/load.ts`
(`loadDeck()` wrapping `import('./DeckHost')`, calling `maybeReloadForFailedImport` on
rejection; `DeckHost.tsx` may be a stub exporting a placeholder until P1b.1),
`web/tests/staleReload.test.ts` (+ offline → error; within cooldown → error; otherwise reload).
Acceptance: `dist/index.html` contains the entry only; `dist/assets/` has exactly one
`DeckHost-*.js` chunk (plus shared chunks, each listed in the build log); loading the page
without `?renderer=deck` fetches **zero** `assets/*.js` (puppeteer request log); M6 ≤ 300 KB
brotli; `serve.mjs --404 <chunk>` shows `RELOAD_NOTICE` and reloads once, then shows the
error on the second failure within 60 s; `vercel.json` `immutable` header applies (path under
`/assets/`).

**Phase 1a: extract the semantics (pure; both renderers consume them). Zero-diff PRs.**
Each 1a PR ends with `shots.mjs` vs baseline = **0 differing pixels** on all 28 scenarios or
it does not merge. P1a.1 ∥ P1a.2 ∥ P1a.3 touch disjoint files.

**P1a.1 `lib/camera.ts`, `lib/ferry.ts`, `lib/tooltip.ts`** — Files: new `lib/camera.ts`
(`viewToViewState(view, W, H)`, `viewStateToView(vs, W, H)`, `zoomBounds(fitScale)`,
`fitExtentView`, `fitCountryView`, `fitHomeView`, `stationT(view, fitScale)`;
`components/map/camera.ts` delegates), new `lib/ferry.ts` (`splitFerry(set) → {landPieces, waterPieces}`
by the existing lat 20.10/20.18, lon 109.9–110.4 rule; one `isFerrySection(bb, s)` replacing
the 6 copies in `backdrop.ts`, `flows.ts` ×3, `interaction.ts`), new `lib/tooltip.ts` (HTML
builders moved from `interaction.ts`, which imports them), `lib/index.ts`. Tests: new
`camera.test.ts` (round trip 1e-9 on random views; M8 projection ≤ 1e-6 px using
`@deck.gl/core` under Bun **[measured: imports without WebGL]**; clamps
`log2(fitScale·0.55)`/`log2(fitScale·60)`; fit maths equals the current `fitExtent` on 100
random extents), new `ferry.test.ts` (the ferry sections split into exactly one water piece
each; every other section unchanged), new `tooltip.test.ts` (builders return today's strings
for a fixture train/station/segment, captured once from the current `showTooltip`).

**P1a.2 `lib/mapModel.ts` for flows / chords / infra / isolation** — Files: new
`lib/mapModel.ts` (`flowPasses(state) → {items: {s, n}[], alpha, maxN, pickable}[]`,
`chordVisibility`, `infraPasses`, `isolatedCorridor`, `getDestSectionCounts`,
`getActiveDestSectionCounts` as pure functions of `{cur, baseCur, dir, animTime, animEnabled,
showInfra, panelDest, iso, dark}` + caches passed in), `components/map/flows.ts` (drawing only;
calls `mapModel`), `interaction.ts pickSegment` (uses `flowPasses` for pickability). Tests:
new `mapModel.test.ts` on the fixture origins: (a) no selection, not animated → one pass α 1;
(b) selected city → context α 0.16/0.18 + focus pass equal to `getDestSectionCounts`;
(c) filtered view → context = `baseFlows` α 0.16/0.18, focus = filtered; (d) isolated →
context α 0.06/0.08 + corridor; (e) animated at step k → focus items equal
`secFlowSteps[s][k]`; (f) chord visible only after its first departure; (g) `flowPasses` at
`animTime ≥ totalMins` equals the static flows.

**P1a.3 `lib/mapModel.ts` stations + `lib/labels.ts`** — Files: `lib/mapModel.ts`
(`stationStates(state, sel) → {idx, r0, kd, alpha, ripple?: {frac}}[]` with the
destination-window rule via `lib/stopEffects.ts`; `getSelCache`/`isTrainShown` moved here from
`map/trains.ts`), new `lib/labels.ts` (`placeLabels(points, view, W, H, measure) →
{text, x, y, align, box, style}[]` ported from `drawLabels`, `measureText` injected),
`components/map/stations.ts` (draw only), `components/map/trains.ts` (imports from `mapModel`),
`anim.ts` (imports `getSelCache` from `mapModel`). Tests: `mapModel.test.ts` (+ (h) with a
destination selected, no ripple time is later than the train's `arrMins` at the destination
and no train is shown after it — the `82e0f22` rule; (i) dimmed alpha 0.16/0.18 for
non-selected cities), new `labels.test.ts` (deterministic placement for 北京/上海/广州 at
national fit with a stub `measure = 7·chars`; the origin label always placed; no two boxes overlap).
*Note:* P1a.2 and P1a.3 both add to `lib/mapModel.ts`; P1a.3 appends a separate section and
rebases on P1a.2 before merge (or P1a.3 starts from P1a.2's branch). Everything else is disjoint.

**Phase 1b: deck origin renderer behind `?renderer=deck`.** Sequential (shared `DeckHost.tsx`).

**P1b.1 Deck host + camera + backdrop** — *after P1.1, P1a.1.* Files: `deck/DeckHost.tsx`
(imperative `Deck` with `canvas` = our own `<canvas>` inside `div#map`,
`views: [new OrthographicView({id: 'map', flipY: false})]`, controlled `viewState` from
`S.current.view`, `onViewStateChange` → `viewStateToView` → `S.current.view` +
`interacted = true` + `M.render()`, `controller` per row 28, `useDevicePixels`, `onError` →
context-loss notice + `finalize()` + new `Deck`, `onAfterRender` → overlay + Legend + scale
bar + view report, `window.__deck` debug handle), new `deck/labelsOverlay.ts` (canvas sizing;
draws `placeLabels` output, origin diamond, boxed origin/selected), new `deck/layers/backdrop.ts`
(outline fill/stroke, dashes, graticule, network, ferry water pieces), new `deck/TailLayer.ts`,
`MapCanvas.tsx` (`renderer` prop: mounts `DeckHost` via `React.lazy(loadDeck)` instead of
`<canvas id="map">`; loading overlay while the chunk loads), `App.tsx` (`renderer` from
`?renderer=`, default `canvas`), `lib/palette.ts` (RGBA helpers + test that RGBA equals the
parsed CSS strings). Acceptance: with `?renderer=deck`, backdrop + labels draw; pan/zoom with
the same clamps; wheel factor within 5 % of `exp(−deltaY·0.0016)` for deltaY ±100 (driver
dispatches wheel, reads `S.current.view.scale`); `fitCountry`/`fitHome`/`panZoomTo`/URL
camera restore move the deck view; renderer switch keeps centre within 1e-6° and scale within
1e-6 (same `S.current.view`); Canvas path shots vs baseline = 0 differing pixels.

**P1b.2 Flow / infra / chord / highlight layers** — *after P1b.1, P1a.2.* Files: new
`deck/layers/flows.ts` (binary `PathLayer` per set, `DataFilterExtension` for `n = 0`,
context pass pre-blended per D3, focus pass, infra, chords with `PathStyleExtension`,
highlight, isolated corridor), `DeckHost.tsx` wiring. Tests: new `layers.test.ts`: given a
`flowPasses` output, the builder returns the expected `data.length`, `updateTriggers` keys,
`getWidth(index) = n·WIDTH_K/fitScale`, `getFilterValue(index) = n` (no GPU; `@deck.gl/layers`
constructs under Bun). Acceptance: `shots.mjs` deck vs baseline on `national-fit`,
`guangzhou-initial`, `city-zoom-x10`, `infra-on`, `night` ≤ 0.5 % differing pixels.

**P1b.3 Station / origin / train layers** — *after P1b.2, P1a.3.* Files: new
`deck/layers/stations.ts`, `deck/layers/trains.ts`, `deck/labelsOverlay.ts` (+ train tag),
`DeckHost.tsx` wiring (animation frames call `M.render()` as today). Tests: `layers.test.ts`
(+ station radius `stationR(n)·stationZoomK(r0, t)`; ripple radius `r + frac·7·kd`, alpha
`1 − frac`; dots exclude trains with `isTrainShown === false`). Acceptance: `shots.mjs` deck
vs baseline on `selected-city`, `selected-city-minimized`, `isolated-train-mid`,
`class-filter-G`, `inbound`, `anim-0600/1815/2350`, `labels-on` within the P1b.5 thresholds.

**P1b.4 Interaction parity** — *after P1b.3.* Files: new `lib/pick.ts` (`pickPriority`),
`DeckHost.tsx` (`onHover` only when `event.srcEvent.pointerType === 'mouse'`; `onClick` →
station select / train select / pinned tooltip / clear; `clearStationHover`,
`selectDestByZh`, `refreshTooltip` over the deck state), `interaction.ts` (pick maths kept
for the Canvas path until P1c.2). Tests: new `pick.test.ts`: `[train, station, seg]` → train;
`[station d=10, origin d=10]` → origin; two segments within 0.75 px → the busier; a segment
1 px closer than a busier one beyond 0.75 px → the closer; chords only when no segment,
`direction === 'out'` and no destination; train only when paused. Acceptance (driver):
`onClick` with nothing under the pointer clears the selection (`info.picked === false`); tap
on station pins the panel; tap on train opens `TrainScheduleModal`; tap on segment pins the
tooltip; no hover tooltips from `page.touchscreen`.

**P1b.5 Parity sign-off (gate G1)** — *after P1b.4.* Files: `web/tools/shots/cmp.mjs`
thresholds; §11 results. Acceptance: all 28 scenarios Canvas vs deck **≤ 0.5 % differing
pixels** (pixelmatch tolerance 0.1), except `selected-city`, `selected-city-minimized`,
`class-filter-G`, `isolated-train-mid` where D3's opaque context pass is allowed **≤ 2 %**;
any scenario above threshold is listed with a side-by-side PNG and needs an explicit owner
sign-off line in the PR. Every §6.1 check green. Interaction checklist (pan, wheel, pinch,
fit buttons, URL camera restore, scale bar km/mi, selection, isolation, class filter,
histogram filter, inbound, play/seek, night, DPR 1/2/3) recorded. Perf: M1/M2/M4/M7 re-run
on the real build and recorded. **[owner]**: M3 on two phones and the R8 feel checklist
(informational; a fail re-opens D8/R8, not the gate).

**Phase 1c: flip and delete, on `deckgl` only.**

**P1c.1 Flip** — *after G1.* `App.tsx`: default renderer `deck`; `?renderer=canvas` stays
as an escape hatch until P1c.2. Acceptance: `shots.mjs` default build = the P1b.5 deck shots.

**P1c.2 Delete Canvas** — *after P1c.1; its own PR.* Files deleted: `backdrop.ts` (240),
`flows.ts` drawing (`traceInto`, `tracePartialSec`, `strokeFlowList`, `drawInfra`,
`drawChords`, `drawHighlightSeg`), `stations.ts` and `trains.ts` drawing, `render.ts`,
`pointer.ts`, the `interaction.ts` pick maths, `BackdropCache`/`tailGradRef`/pointer state
in `context.ts`, the wheel and canvas handlers in `MapCanvas.tsx` (which becomes the thin
host of `DeckHost`); `?renderer=` removed. Acceptance: no TS errors; tests green;
`shots.mjs` vs the P1c.1 build = 0 differing pixels.

**G-MAIN (owner, D16).** After P1c.2 the owner decides whether `deckgl` merges to `main` now
(origin view on deck, no national mode) or after Phase 2. Agents do not open that PR.

### Phase 2: national animation (A) on deck (4–6 days). Gate G2 to start

**G2.** Phase 2 starts after P1c.1 and only if the Phase 0 national numbers (M1n, M2n, M4n
dots, M7n) meet the Phase 2 thresholds listed in the §4 table, re-checked on the real build in
P2.2. If they do not, the owner decides (D13 scope reduction, e.g. cull to the viewport, or stop).

Dependency: `P2.1` (may run during Phase 1) → `P2.2` (after P1c.1, P2.1) → `P2.3` → `P2.4`.

**P2.1 National timelines on section refs** — *parallel with Phase 1 (disjoint files).*
Files: new `web/src/lib/national.ts` (reworked from the spike), `web/src/lib/timeline.ts`
(export `prepTrainPath`; `buildDayTimeline` calls it), `web/src/lib/index.ts`,
`web/src/types.ts` (`NationalTimeline`), `web/src/hooks/useAtlasData.ts` (retain the raw
`OutTablesPack` `paths`/`stop_pos`/`chords`; expose `outTablesRaw`), new
`web/tests/national.test.ts`. Tests: (a) `natPositions` at minute 1095 returns **2,668**
dots on the committed pack; (b) wrap-around: every dot at m = 30 belongs to a train with
`start ≤ 30 + 1440k ≤ end` for some integer k, and at least one has `start > 30`; (c)
positions equal the spike's expanded-vertex method within 1e-6° for a 200-train sample (the
spike's `natXY` ported into the test as the oracle); (d) snapshots unchanged (`prepTrainPath`
is a pure refactor). Acceptance: heap delta of `buildNational` ≤ 30 MB (logged in the test).

**P2.2 National layers + mode + clock** — *after P1c.1, P2.1.* Files: new
`deck/layers/national.ts` (dots, tails, dwell rings from the frame buffer; `pickable: !animPlaying`),
`DeckHost.tsx` (national frame loop: `M.render()` → `natPositions` → `setProps({layers})`;
D8 DPR cap), `MapCanvas.tsx` (`national` prop), `App.tsx` (`national` state from
`?national=1`; `TimelineScrubber` shown when `direction === 'out' || national`; city panel
closed on entering national), `Toolbar.tsx` (toggle "National · beta", D11),
`hooks/useUrlState.ts` (`national=1`), `map/anim.ts` + `context.ts` (`AnimState.national`,
`AnimState.running`; in national mode `activeTimeline()` is `undefined` so `totalMins` is
1440 and the clock wraps; `departed = running`, `total = nat.n`, `arrived = 0`),
`TimelineScrubber.tsx` (labels "Running" / "Trains" when `state.national`; "jump to finish"
hidden). Tests: national clock state in `animation.test.ts` (`totalMins 1440`, wrap 1440 → 0).
Acceptance: M1n/M2n/M4n/M7n thresholds hold on the real build (perf driver, numbers in the
PR); dots at 00:30 include trains that left the day before (count equals the P2.1 test value);
national ↔ origin switch keeps centre/scale (same `S.current.view`); origin-view shots
unchanged vs P1c.1.

**P2.3 National picking + tooltip + modal** — *after P2.2.* Files: `DeckHost.tsx` (`onHover`
mouse-only when paused on national dots; `onClick` → `onSelectTrain(code)`),
`lib/tooltip.ts` (train builder reused). Acceptance: pause → hover → tooltip; click →
`TrainScheduleModal` for that code; no hover from touch.

**P2.4 Device pass** — *after P2.3.* Agent: `?fps=1` meter; a11y live region ("2,668 trains
running at 18:15") from `getAnimState`; §11 updated. **[owner]**: M3 on the two phones in
national mode (a fail re-opens D8, not Phase 2).

### Phase 3: B (national flows) and A+B (3–5 days web + pipeline task)

**P3.1 Pipeline (D12)** — a national per-section flow table (`byClass` sums over all trains),
shipped as `atlas-v2-national.json.br` (fmt 7 or a new file; `DATA_FMT` check extended);
`pack-audit` goldens extended. Scheduled with the ≈ 12k-train data.

**P3.2 B layer** — `deck/layers/national.ts` (+ flows `PathLayer`, class filter =
`Σ byClass[selected]` into `widthArr`). Test: per-section totals equal the pack audit.

**P3.3 A+B** — per-section cumulative entry counts per 5-min step from the national
timelines' `trainEntries` (≈ 7.5k sections × 288 × 2 B ≈ 4.3 MB) or precomputed by the
pipeline; D7 wrap semantics. Test: A+B at 24:00 equals B.

**P3.4 Optional comet mode** — only if D2 is toggled on and M4n (Trips) passed.

---

## 5. Interim coexistence (two renderers)

| Concern | Plan |
|---|---|
| **Shape** | Mode switch, not stacking. On `deckgl`, `?renderer=deck` selects the deck origin renderer (P1b); after P1c.1 deck is the default and `?renderer=canvas` the hatch; after P1c.2 only deck exists. Never both on screen |
| **Camera** | One source of truth for both: `S.current.view {scale, tx, ty}` in `MapCtx`. deck gets a controlled `viewState` from `lib/camera.ts viewToViewState` on every `M.render()`; `onViewStateChange` writes back through `viewStateToView`. No hand-off step, no per-frame mirror; the URL format is unchanged |
| **Input** | Whichever renderer is mounted owns pointer and wheel (deck controller vs `pointer.ts`); no shared listeners |
| **Shared state** | `anim.ts` clock, `MapApi`, tooltip DOM, scale-bar DOM, Legend: renderer-agnostic. `M.render()` is the only per-renderer dispatch |
| **If stacking is ever needed** | deck canvas on top with `pointer-events: none`, `controller: false`, `viewState` pushed from `S.current.view` inside the Canvas `draw()`. Not planned |
| **Duration** | Phase 1 is ≈ 2–3 weeks of calendar time on `deckgl`; `main` is untouched throughout. The Canvas hatch lives from P1c.1 to P1c.2 only |
| **Avoiding getting stuck** | (1) 1a makes both renderers consumers of `mapModel`; (2) Canvas drawing is frozen on `deckgl` from P1b.1 (D10), and Canvas changes arriving from `main` are mirrored in the weekly sync PR; (3) P1c.2 is its own PR right after the flip; (4) if 1b slips > 2 weeks, the owner re-decides, no third state |

---

## 6. Testing strategy

| Layer | What | Where / CI |
|---|---|---|
| Data-level (existing) | 62 tests / 7 files (`decode`, `animation`, `snapshots`, `stopEffects`, `headingCount`, `stationBreakdown`, `staleReload`) **[measured: 62 pass]** | `bun test` in CI, unchanged |
| New pure tests | `camera`, `ferry`, `tooltip`, `mapModel`, `labels`, `pick`, `staleReload` (+ import failure), `national` (Phase 2) | `bun test` |
| Layer-props tests | `layers.test.ts`: builders return expected `data.length`, trigger keys, accessor values (no GPU; `@deck.gl/*` constructs under Bun **[measured for core]**) | `bun test` |
| Screenshot diff | `web/tools/shots/` (P0.1), 14 scenarios × DPR 1/2; baseline = Canvas build at the merge-base | Local macOS GPU only (SwiftShader AA differs) |
| Headless WebGL smoke | build → serve → puppeteer `--use-angle=swiftshader --enable-unsafe-swiftshader` → no `pageerror`, `onAfterRender` fired, non-paper pixels | Added to CI in P1b.1 |
| Context loss | `WEBGL_lose_context` lose/restore → notice, then a working map | Local + CI smoke |
| Perf | `web/tools/perf/{origin,national}.mjs`: `deck.metrics` + rAF p50/p95/max, CDP CPU throttle, renderer-string check | Local; numbers in §11 and `docs/benchmarks/` |
| Build assertions | deck chunk ≤ 300 KB brotli; no `@deck.gl`/`@luma.gl` input in the inlined entry; `--frozen-lockfile` | `bun run build` in CI (P1.1) |

### 6.1 Preserved behaviour rules and their checks

| Rule (where it lives today) | Check |
|---|---|
| Destination window: a train exists only until its arrival at the selected destination; stop effects only from visible trains at stops on that leg (`lib/stopEffects.ts`, `82e0f22`) | `stopEffects.test.ts` (unchanged); `mapModel.test.ts` (h); `shots` `selected-city` + `anim-1815` |
| Class-filtered heading count and station breakdown (`headingCount.test.tsx`, `stationBreakdown.test.ts`, `05bea87`, `f396026`) | Unchanged tests; the components are untouched |
| Minimize keeps the selection (`DestinationPanel.tsx`, `574f0cd`) | `shots` `selected-city-minimized` (map highlight identical to `selected-city`) |
| Stale-asset reload once per 60 s on a hashed pack 404 (`staleReload.ts`, `a58ccf1`) | `staleReload.test.ts` (unchanged) + new import-failure cases (P1.1) + the `serve.mjs --404` driver check |
| Backdrop toggles (`showNetwork`, `showOutline`) redraw correctly; no visible cache behaviour to preserve | `shots` `infra-on`, `national-fit`; toggle item in the P1b.5 checklist |
| Hover priority train > station/origin (origin wins ties) > segment (busier within ±0.75 px) > chord; train hover only when paused; hover only for mouse | `pick.test.ts`; P1b.4 driver checks |
| Tap on station selects, tap on train opens the modal, tap on segment pins the tooltip, tap on empty clears | P1b.4 driver checks |
| Camera clamps `fitScale·[0.55, 60]`; URL zoom format; keep centre on resize; Guangzhou initial fit | `camera.test.ts`; `shots` `guangzhou-initial`; P1b.1 wheel check |
| Animation: wrap and tail speed-up ×2.5 after day 1 (origin); 1440 wrap (national, Phase 2) | `animation.test.ts` (+ national clock in P2.2) |
| Isolated train corridor and chip | `mapModel.test.ts` (d); `shots` `isolated-train-mid` |
| `MapApi` contract (`fitCountry`, `fitHome`, `zoomCenter`, `refreshTooltip`, `clearStationHover`, `selectDestByZh`, `panZoomTo`, clock methods) | `context.ts` interface unchanged (typecheck); P1b.1/P1b.4 driver checks call each through `window.__mapApi` |

---

## 7. Risks and mitigations

| # | Risk | L / I | Mitigation |
|---|---|---|---|
| R1 | Version churn in deck.gl 9.x minors / luma.gl | M / M | Pin exact `9.4.0` for all `@deck.gl/*`; `bun.lock` committed; upgrades as deliberate PRs through the screenshot suite |
| R2 | Build integration: single inlined IIFE today, `index.html` `max-age=0` | H / M | P1.1: esbuild ESM + `splitting` with `chunkNames: 'assets/[name]-[hash]'` (immutable header already covers `/assets/(.*)`); entry inlined as `<script type="module">`; `</script` escaping kept; metafile assertion; stale-chunk recovery (C4) |
| R3 | WebGL2 unavailable / context loss. deck 9 requires WebGL2; on loss it calls `onError('WebGL context is lost')` and does not restore **[source]** | L / M | `onError` → notice "Map paused — tap to resume", `finalize()`, new `Deck` from retained CPU state. No WebGL2 → notice; panels/tables keep working (D9). M12 gates the path |
| R4 | Mobile GPU memory | M / H (Trips), L (dots) | Section-ref dedup; no TripsLayer by default; DPR cap 2 per D8; M3 owner check |
| R5 | Accessibility | — | DOM surfaces unchanged; live region in P2.4 |
| R6 | Regression in selection/filter semantics | M / H | 1a extracts into `mapModel` **before** deck code, with zero-diff screenshots; one visibility function for dots, picking, counters and stop effects |
| R7 | Picking semantics drift | M / L | `pick.test.ts`; exact distances recomputed for the candidates |
| R8 | Interaction feel (wheel speed, inertia, tap threshold, pinch) | M / M | `scrollZoom.speed` calibrated (P1b.1 numeric check); `inertia: false`; owner feel checklist in P1b.5 |
| R9 | Hairline shimmer under MSAA | M / L | Raise 0.45–0.5 floors to 0.6 if the screenshot review shows it |
| R10 | Long-lived `deckgl` drifts from `main` | M / H | Weekly sync PRs with the `components/map` diff check; D10 freeze on `deckgl`; owner's small main-only tweaks (colour/copy) are mirrored by the sync author |
| R11 | Data growth to ≈ 12k trains | certain / M | Dedup scales with refs; `?natSynth=12000` in every national perf run |
| R12 | Bundler branches diverge | — | Resolved by D14 (esbuild only) |
| R13 | `TailLayer` shader injection breaks on a deck minor | L / L | 15 lines, covered by M13 and the screenshot suite; fallback `ArcLayer` |

---

## 8. What stays unchanged

- React UI outside the map: `DeparturesTable.tsx`, `Histograms.tsx`, `Legend.tsx`,
  `MapOverlays.tsx`, `CityPicker.tsx`, `ActiveFilterBar.tsx`, `DestinationPanel.tsx`,
  `TrainScheduleModal.tsx`, `AppHeader.tsx`. Small named edits only: `App.tsx` (renderer /
  national state), `Toolbar.tsx` (Phase 2 toggle), `TimelineScrubber.tsx` (Phase 2 labels).
- Hooks: `useSelection`, `useAnimationClock`, `useDialog`; `useUrlState` (+ `national`,
  Phase 2), `useAtlasData` (+ retained raw out-tables, Phase 2).
- `lib/`: `decode`, `filter`, `origin`, `stopEffects`, `format`, `geo`; `timeline`
  (+ exported `prepTrainPath`, Phase 2), `palette` (+ RGBA).
- Data packs (fmt 6) through Phase 2; `web/vercel.json` headers (the active config; the root
  `vercel.json` mirrors it); `staleReload` behaviour (extended, not changed).
- `main` itself, until the owner's G-MAIN merge.
- Owner rules: no MapLibre, no basemap tiles, no API keys. deck.gl standalone with
  `OrthographicView`, drawing our own outline and network.

---

## 9. Maintainability: custom render code before and after

`wc -l` of `web/src/components/map/*.ts` plus `MapCanvas.tsx` today **[measured]**; other
columns **[estimate]**.

| Module | Today | After P1c.2 (origin on deck) | After Phase 2 (+ national) |
|---|---:|---:|---:|
| `backdrop.ts` | 240 | 0 (→ ≈ 60 `deck/layers/backdrop.ts`) | same |
| `flows.ts` | 853 | 0 (→ ≈ 250 `mapModel` + ≈ 120 layers) | same |
| `stations.ts` | 432 | 0 (→ ≈ 200 `lib/labels.ts` + ≈ 80 layers + ≈ 50 overlay) | same |
| `trains.ts` | 278 | 0 (→ ≈ 90 `mapModel`, ≈ 60 layers) | same |
| `interaction.ts` | 439 | ≈ 80 glue + ≈ 190 `lib/tooltip.ts` + ≈ 60 `lib/pick.ts` | same |
| `pointer.ts` | 119 | 0 | same |
| `camera.ts` | 187 | ≈ 60 glue + ≈ 110 `lib/camera.ts` | same |
| `render.ts` | 82 | 0 | same |
| `context.ts` | 275 | ≈ 150 | ≈ 160 |
| `anim.ts` / `api.ts` | 241 | ≈ 245 | ≈ 270 |
| `MapCanvas.tsx` | 216 | ≈ 120 | ≈ 130 |
| deck host (new) | — | ≈ 200 `DeckHost.tsx` + ≈ 400 layers + ≈ 50 overlay + ≈ 40 load + 15 `TailLayer` | + ≈ 120 `layers/national.ts` + ≈ 40 host; + ≈ 250 `lib/national.ts` (tested) |
| **Total render-side** | **≈ 3,360** | **≈ 1,500** glue/layers + **≈ 750** pure tested `lib` | **≈ 1,700** + **≈ 1,000** `lib` |

---

## 10. Owner decisions: adopted defaults (override in writing)

| # | Question | Adopted default | Changed in review? |
|---|---|---|---|
| D1 | Phase 0 as go/no-go before any production change? | **Yes.** Phase 0 spikes the **origin view**. Agent gates: M1, M2, M4, M6, M7, M8, M9, M12, M13, M14. M3/M10 are owner steps; national numbers are secondary | Re-cut to origin-first (C15); gate set explicit (C7) |
| D2 | TripsLayer comet trails vs today's short straight tails? | **Straight tails** (`TailLayer`, C1). Comet mode only as a later optional toggle, only if M4n passes with simplified paths | Implementation changed (C1) |
| D3 | Faded context flows: opaque pre-blended colours? | **Yes** | — |
| D4 | "+400 KB" as transfer or minified size? | **Transfer size**; deck is a hashed chunk (217–262 KB) | — |
| D5 | Labels: overlay canvas / `TextLayer` / DOM? | **Overlay canvas**; DOM labels revisited for a11y later | — |
| D6 | Segment/chord picking: GPU + priority, or CPU picker? | **GPU candidates + `lib/pick.ts pickPriority`** with exact distances recomputed for the candidates (keeps the ±0.75 px rule) | Sharpened |
| D7 | A+B wrap semantics | **Cumulative since 00:00**; at 24:00 equals B | — |
| D8 | DPR cap on weak devices? | **Cap 2 in national mode when `navigator.deviceMemory ≤ 4` or `navigator.maxTouchPoints > 0`** | Changed (C11) |
| D9 | Canvas fallback after the migration? | **No.** Notice + working tables/panels | — |
| D10 | Freeze Canvas drawing features once deck layers start? | **Yes**, on `deckgl` from P1b.1; `main` changes are mirrored by the sync PR | Scope clarified (C15) |
| D11 | National entry point | **Toolbar toggle "National · beta" + `?national=1`** (Phase 2) | — |
| D12 | Separate pipeline task for B? | **Yes**, with the ≈ 12k-train data | — |
| D13 | What national mode shows and ignores | **Map-only mode:** outline, graticule, network, every covered train's dot/tail/dwell ring, wrap at 1440. Origin-specific map state (selection, filters, isolation, inbound flows, station dots, labels) is not drawn; entering national closes the city panel; the departures table and panels keep working for the current origin; the scrubber shows Running / Trains | New |
| D14 | Production bundler | **esbuild via `node bundle.mjs`** (already the case on Vercel and CI); the `Bun.build` branch is deleted in P1.1 | New (C5) |
| D15 | `@deck.gl/react` or imperative `Deck`? | **Imperative `Deck`** owned by `DeckHost.tsx`, one `setProps` per `M.render()` | New (C14) |
| D16 | When does `deckgl` merge to `main`? | **One owner gate (G-MAIN).** Default timing: after Phase 2 (origin + national together); the owner may pull it forward to after P1c.2 if the origin view alone should ship. Agents never open or merge that PR | New (C15) |

---

## 11. Phase 0 results (filled in by P0.2; re-run in P1b.5 / P2.2)

**Verdict for gate G0: GO.** All ten agent gates (M1, M2, M4, M6, M7, M8, M9, M12, M13, M14) pass on the
spike, with the caveats and plan corrections listed below. M3 and M10 are owner steps and do not block.
Spike: branch `spike/deckgl` @ `f04acf8` (forked from `deckgl` @ `feaf69a`, never merged; reference only). Measured
2026-10-25 on an M4 Max (`ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max)`, real GPU; the driver refuses SwiftShader), headless
Chrome, 1280×800, DPR 2, light theme, deck.gl 9.4.0, packs from HTTP cache. The machine was shared with other agents
(load average 3–10); every perf number is the median of 3 repetitions unless stated, and the spread is given where it
mattered.

### 11.1 Gate and report-only metrics

| Metric | Spike (P0.2): value (threshold) | Real build (P1b.5 / P2.2) | Pass? | Who / date |
|---|---|---|---|---|
| M1 frame time, origin anim on 广州, national fit | rAF p95 **16.7–16.8 ms** in 3/3 reps (≤ 16.7); draw+raster (forced `readPixels` flush) p95 **8.5–8.9 ms**; JS draw p95 1.1–1.3 ms; `deck.metrics.cpuTimePerFrame` **2.4–2.9 ms** (≤ 4); `gpuTimePerFrame` 2.8–3.1 ms | — | PASS | agent, 10-25 |
| M2 M1 at 4× CPU throttle | rAF p95 **33.3 / 16.8 / 16.7 ms** (reps 1–3; median 16.8; ≤ 33); draw+raster p95 11.9–13.9 ms; JS draw p95 4.5–6.2 ms; cpuTimePerFrame 8.7–11 ms | — | PASS (one rep at exactly 2 vsyncs, 33.3) | agent, 10-25 |
| M3 phones | not run | — | owner step, §11.4 | owner |
| M4 GPU memory, 广州 + selected city + infra on | **10.4 MB** buffer memory (≤ 64); equals the sum of layer attribute buffers (10.35 MB: flows 2×2.55, infra 2×1.95, network 0.88) | — | PASS | agent, 10-25 |
| M6 bundle | deck chunk (all deck/luma/math/loaders code the spike uses): **907 KB min, 253 KB gzip, 209 KB brotli** (≤ 300 brotli). The spike inlines it (`index.html` JS 392,735 → 1,348,019 B) because the lazy split is P1.1, so the chunk is measured standalone (`web/tools/spike/size.mjs`) | — | PASS | agent, 10-25 |
| M7 time to first deck frame, packs cached | **84 ms** (1×; 3 warm runs 82–85 ms, cold first run 571 ms) and **240–268 ms** at 4× (≤ 1.0 s) | — | PASS | agent, 10-25 |
| M8 projection exactness | **7.3e-11 px** worst over 1,000 random points × 5 zooms (≤ 1e-6); `web/tests/deckProjection.test.ts` on the spike | — | PASS | agent, 10-25 |
| M9 SwiftShader smoke | `--use-angle=swiftshader --enable-unsafe-swiftshader`: renderer `SwiftShader Device`, 0 `pageerror`, `onAfterRender` fired 3×, 66,578 non-empty canvas pixels | — | PASS | agent, 10-25 |
| M10 label options | spike only has the overlay-canvas variant (§11.3 side-by-side); no `TextLayer` variant built | — | owner step, §11.4 | owner |
| M12 context loss | `loseContext()` then `restoreContext()`: **0 `pageerror`; the map draws again after re-creating `Deck`** (245,760 non-empty px). **`Deck.onError` is never called on context loss in 9.4.0** (`_onContextLost` is defined but not wired, see §11.2); the loss is caught by our own `webglcontextlost`/`webglcontextrestored` listeners on the canvas | — | PASS with the criterion reworded (§11.2 G3) | agent, 10-25 |
| M13 `TailLayer` fade | 120 px probe tail, alpha at 0.5 / 5 / 30 / 60 / 90 / 115 / 119.5 px = 0.008 / 0.043 / 0.25 / 0.50 / 0.75 / 0.96 / **0.996** (source < 10 %, head ≥ 90 %); linear. Injection `vs:#main-end: vColor.a *= positions.x` works; no fallback needed | — | PASS (C1 injection) | agent, 10-25 |
| M14 parity feasibility | Canvas vs deck, DPR 2, per-scenario differing pixels (tolerance 25/255 per channel, our `cmp.mjs`, the closest match to pixelmatch 0.1): `national-fit` **0.91 %**, `guangzhou-initial` **1.60 %**, `city-zoom-x10` **3.35 %**, `selected-city` **1.68 %**, `anim-1815` **1.27 %**, `night` **1.01 %**, `labels-on` **2.69 %** (all ≤ 5 %). Other 7: `anim-0600` 0.75, `anim-2350` 1.13, `class-filter-G` 1.38, `inbound` 1.65, `infra-on` 1.89, `isolated-train-mid` 0.77, `selected-city-minimized` 1.68. Structural differences in §11.3 | — | PASS | agent, 10-25 |
| M1n national peak, 18:15 (`natSynth` 0 = 2,668 trains; 12,000 = 4,715 active) | `natSynth=0`: rAF p95 16.7 ms, draw+raster p95 10.3 ms, cpuTimePerFrame 1.7 ms. **`natSynth=12000`: rAF p95 16.7–16.8 ms in 3/3 reps, draw+raster p95 12.5–13.9 ms, cpuTimePerFrame 1.3–1.4 ms, JS draw p95 2.5–2.6 ms (CPU position loop 1.5 ms)** | — | report (meets the Phase 2 bar: p95 ≤ 16.7, CPU ≤ 4) | agent |
| M2n M1n at 4× throttle | `natSynth=0`: rAF p95 16.8 ms; `natSynth=12000`: rAF p95 16.7 / 16.8 / 16.8 (national fit), 33.3 on the origin-initial view; draw+raster p95 19.5–20.3 ms; cpuTimePerFrame 5.1 ms | — | report (meets the Phase 2 bar: p95 ≤ 33) | agent |
| M4n GPU memory, dots + tails | 4.5 MB total layer stack at 2,570 dots (tails 0.42 MB, dots 0.25 MB); 5.0 MB at 4,715 dots (tails 0.72 MB). TripsLayer not built | — | report (≤ 64 MB) | agent |
| M5n CPU heap of the national build | **47.5 MB** (3.97 M vertices, 6,972 trains; `usedSize + backingStorageSize` after GC, `natSynth` adds < 1 MB); build 119 ms | — | report (spike expectation ≈ 48 MB; P2.1 target ≤ 30 MB) | agent |
| M7n time to first national frame | **0.18 s** (fetch+parse 62 ms, build 119 ms, from toggle to first `onAfterRender` with dots) | — | report (≤ 1.5 s) | agent |
| M11 TripsLayer dwell | not built | — | n/a | — |

Counts check: 2,668 national trains at minute 1095 on the current pack, as the plan says.

### 11.2 Surprises: API gaps and plan corrections (fold into §1–§4 before Phase 1)

| # | Finding | Consequence |
|---|---|---|
| G1 | **`ScatterplotLayer` strokes are centred on `radius`, not inside it** (`outerRadiusPixels = radius + lineWidth/2`, vertex shader of 9.4.0). C2 and rows 15–23 assumed "inside". | Match the Canvas outer edge with `radius = outer − lineWidth/2`: train dots `getRadius 3`, `getLineWidth 2` (ring 2–4 px, core < 2 px, outer 4); isolated `4.15` / `2.7`; station dots `radius = r` (Canvas strokes are centred at `r` too); rings use their centre-line radius; dwell ring 6.5. Before the fix dots were visibly too big at night (M14 `night` 2.4 %, now 1.0 %). |
| G2 | **Binary `PathLayer` draws in section-index order; Canvas strokes widest first** (`flows` is sorted by `n` descending, so narrow bands lie on top). | One layer: `city-zoom-x10` 3.35 %, wide bands overlap the wrong way near the origin (§11.3). Width-bucketed layers via `DataFilterExtension` ranges fix it (5 layers, `city-zoom-x10` 1.46 %) **but** attributes are computed per layer: `cpuTimePerFrame` 7.3 ms at 1× (fails the 4 ms CPU gate), buffer memory 31 MB. Two buckets: 3.9 ms, no parity gain. Measured, not guessed. **Phase 1 (P1b.2) decision**: keep one layer and live with ≤ 3.4 %, or upload geometry permuted into width order once per origin (static; the sort key `n` is fixed per `cur`) so one layer keeps the Canvas order. The spike default is 1 bucket (`?buckets=1|2|5`). |
| G3 | **`Deck.onError` never receives context loss in 9.4.0**: `_onContextLost` exists but nothing calls it (luma only exposes `onContextLost` on the device creation props, deck does not pass it). M12's "`onError` receives the loss" cannot pass. | Add our own `webglcontextlost` (call `preventDefault`) and `webglcontextrestored` listeners on the canvas; on restore `finalize()` and create a new `Deck` on a **new canvas element**. Reword M12 as "own listener fires; after re-creating `Deck` the map draws, no `pageerror`" (done above). |
| G4 | **A new layer type's first frame may not draw** (luma compiles pipelines asynchronously); the M13 probe only produced pixels after several `redraw` calls 100 ms apart. | Deterministic screenshots and tests must wait for a settled frame (e.g. two consecutive `onAfterRender` with an unchanged layer set), not a fixed sleep after `setProps`. `shots.mjs` already waits several hundred ms and was stable on all 14 scenarios. |
| G5 | **`deck.redraw('reason')` draws synchronously**, and `setProps({layers})` updates attributes synchronously. | `M.render()` can be a plain `setProps` + `redraw('x')` with Canvas-identical semantics (this is what the spike does). `deck.metrics` is only refreshed by deck's own loop, so for synchronous drivers read `_getFrameStats()/_getMetrics()` (private) or time `draw` yourself. |
| G6 | `deck.metrics.gpuMemory` agrees with the sum of attribute buffer byte lengths (10.44 vs 10.35 MB). `preserveDrawingBuffer` is true by default, so `readPixels` works any time after a draw (bind framebuffer `null` first). | Fine for tests and for the M13 probe. |
| G7 | Separate (non-interleaved) typed arrays were used for dots and tails; `stride`/`offset` interleaving from §2.2 was not exercised. | Not a blocker; untested. Keep §2.2's interleave as an optimisation, not a requirement. |
| G8 | The "rAF reads a constant 33.3 ms" caveat from P0.1 **did not reproduce**: headless gives 16.7 ms (60 Hz), `--headed` gives **8.3 ms (120 Hz ProMotion)** with draw+raster p95 4.9–6.1 ms. The 33.3 ms was very likely display-link or contention related, not Chrome throttling. | rAF numbers are valid on this setup, but under agent contention (load average > 8) they degrade sharply while `draw` time stays flat (one 4× run went to 150 ms rAF with the machine busy). Gate on draw+raster and `cpuTimePerFrame`; treat rAF as supporting evidence and rerun on a quiet machine. |

### 11.3 What the spike drew, parity, and what it left out

Drawn: outline (fill, stroke, lines, nine-dash), graticule, network, chords (dashed, gated), routed flows (binary `PathLayer`,
`DataFilterExtension` for `n = 0`, context pass pre-blended per D3 + focus pass), infrastructure overlay, hover segment,
station dots with growth and ripples, selection/hover rings, origin disc, train dots + `TailLayer` + dwell rings + hover rings,
labels on the old `#map` canvas (reusing `drawLabels` with a `project` shim built from `deck.getViewports()[0]` inside `onAfterRender`),
deck GPU picking for train dots (paused), stations and origin with the existing `showTooltip`, `?national=deck&natSynth=N`
(`lib/national.ts` from `600b3de` copied unchanged). Verified by driver: hover on a paused train and on a station shows the existing tooltip.

Not in the spike (do not count against M14, all listed in P1b): Qiongzhou ferry split (water crossing is drawn solid), progressive
isolated corridor (static full path) and the train code tag, `OrthographicController` (camera still the existing pointer handlers,
deck derives its `viewState` from `S.current.view` each frame), GPU picking of sections/chords (existing CPU `pickSegment` used),
`onClick`, lazy chunk loading.

Structural differences seen in the side-by-sides (all four screenshots are in `docs/deckgl-spike/`, Canvas on top, deck below):

- `city-zoom-x10`: wide flow bands overlap in a different order near the origin (G2). Same colours and widths.
- `selected-city`: the D3 opaque context pass is a little lighter than Canvas's alpha-blended one (allowed ≤ 2 % at P1b.5).
- `labels-on`, `anim-1815`, `night`: no structural difference found; remaining differences are anti-aliasing of the 0.45–2.5 px
  network and flow edges and the 0.65 px outline (§3 "Antialiasing").

![city-zoom-x10](deckgl-spike/city-zoom-x10.png)
![labels-on](deckgl-spike/labels-on.png)
![night](deckgl-spike/night.png)
![anim-1815](deckgl-spike/anim-1815.png)

### 11.4 Owner steps (M3 phones, M10 labels)

Build and serve the spike on your LAN (the spike branch is reference only; never merge it):

```bash
git fetch origin && git checkout spike/deckgl && cd web && bun install && bun run build
HOST=0.0.0.0 node tools/serve.mjs --dir dist --port 8766        # any free port except 8090
```

Open `http://<your-mac-LAN-IP>:8766/?renderer=deck&fps=1` on each phone. A green meter (top-left) shows frames/s and
`deck.metrics.fps` and the train count.

- **M3**: on one mid-range Android (Snapdragon 7-series, Chrome) and one iPhone (A15 class, Safari): expand "24h Flow Animation",
  press play (30 s per day), leave it running 60 s at the Guangzhou start view, then 60 s zoomed to the Pearl River Delta
  (pinch). Write down the lowest steady frames/s. Pass: ≥ 30 sustained. Optional national stress:
  `?renderer=deck&national=deck&natSynth=12000&fps=1` (~4,700 dots).
- **M10**: compare `http://localhost:8766/?renderer=deck` (overlay-canvas labels, toggle "City labels") against
  `http://localhost:8766/` (Canvas) at national fit and at the Pearl River Delta close-up; the spike has no `TextLayer`
  variant, so the useful question is only whether the overlay labels look identical to Canvas (they use the same code).
  The `TextLayer` comparison is a Phase 1 option if you want it; say so and a task is added.

Record the numbers in the table above (rows M3, M10).

### 11.5 Updated Phase 1 effort

Phase 0 took about 1 day of agent time against the 1.5–2.5 day estimate. The spike showed that the layer set, shaders and picking
work and that the effort risk is in parity edge cases, not in feasibility. **Phase 1 estimate: 9–12 days (was 10–14)**: P1b.1–P1b.3 shrink
because the host, TailLayer, binary flows, stations and trains already have working reference code; add back about 1.5 days for the
G2 decision (draw order), G3 (context-loss re-creation on a fresh canvas), the ferry split and progressive isolated corridor,
`OrthographicController` wheel/pinch calibration and `onClick` semantics, and the stale-viewState-trigger class of bugs seen in the
spike (a missing `dark` in an `updateTriggers` key left night mode half light; add the theme to every colour trigger, §2.6 already
says so). Phase 2 estimate unchanged at 4–6 days; the national numbers (M1n/M2n, 47 MB heap) say the plan's dedup in P2.1 is still needed
for memory but not for speed.


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
  `shots.mjs`, `clsshots.mjs`, `hcshots.mjs`, `minshots.mjs`, `cmp.py` (committed in P0.1).
- Bundle measurement: esbuild 0.28.2, `--bundle --minify --format=iife --target=es2020`;
  today's build re-run for this review: `bundle bytes: 392735`, `dist/index.html` 454,611 B,
  133,146 B gzip.
