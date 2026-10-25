# deck.gl migration plan: from the Canvas 2D renderer to deck.gl

Status: **proposal, for owner review.** This document is a plan only; no code changes yet.
Baseline: `origin/main` @ `05bea87`. Target library: **deck.gl 9.4.0** (npm `latest` as of
2026-10-24) on **luma.gl 9.4.2**. Spike reference: `spike/national-anim` @ `600b3de`.

Where this plan states a number, the source is given: **[measured]** means measured for
this plan or in the spike, **[source]** means read from the deck.gl 9.4.0 package source,
and **[estimate]** means a guess that Phase 0 must replace with a measurement.

---

## 0. TL;DR

- **The camera maps exactly onto deck.gl.** `camera.ts` uses `px = lon·scale + tx`,
  `py = −lat·scale + ty`. That equals `OrthographicView({flipY: false})` with positions
  `[lon, lat]`, `zoom = log2(scale)` and `target = [(W/2 − tx)/scale, (ty − H/2)/scale]`.
  It is also equal to the default `flipY: true` with positions `[lon, −lat]`. Both forms were
  checked in Node and Bun against `@deck.gl/core` 9.4.0 `OrthographicViewport.project`:
  the largest error was 4.6e-13 px **[measured]**. We recommend `flipY: false`, because then
  no coordinate has to be negated.
- **The bundle grows less than feared, but it should still be split out.** Core plus
  Path/Scatterplot layers minify to 833 KB (234 KB gzip). With the full set (Trips, Text,
  Line, DataFilter, PathStyle) it is 949 KB minified, 262 KB gzip, 217 KB brotli
  **[measured, esbuild 0.28.2]**. Today's whole app JS is 393 KB minified, and
  `index.html` is 455 KB (133 KB gzip). Putting deck inline in the single, always-revalidated
  `index.html` would roughly triple it. Plan: emit deck as a **hashed, immutable, lazily
  loaded chunk** under `assets/`.
- **The spike's 16.6 ms Canvas cost comes from the tails, not from the position maths.**
  On deck, the dots become one `ScatterplotLayer` (a stroke trick gives glow plus white core
  in a single layer). The tails become one `LineLayer` with
  `getSourceColor`/`getTargetColor` gradients. Both read the spike's interleaved
  `Float32Array` as **binary attributes**, with no per-object JS work. We expect this to be
  well under 2 ms of CPU per frame **[estimate]**.
- **TripsLayer is optional, not the core of A.** It needs the per-train expanded vertex
  set: 3.97 M vertices today and about 6.8 M at 12k trains. With 64-bit positions, that is
  roughly 200–400 MB of GPU memory **[estimate from attribute layout]**. That is a
  non-starter on phones unless paths are simplified about 10×. For A we recommend CPU
  positions on *shared section geometry* (the dedup), with TripsLayer kept as an opt-in
  "long comet trails" mode.
- **Most of the complexity is semantics, not drawing.** `flows.ts` (853 lines) is mostly
  "which sections, at what alpha and width, under which selection, animation or isolation
  state". That logic moves to pure, tested `lib/` view-model functions. deck.gl removes the
  drawing boilerplate: `traceInto`, ferry splitting at draw time, width/colour bucket
  batching, gradient caches, the backdrop blit cache and pointer maths. Expect custom render
  code to drop from about **3,150 to about 1,500 lines** in `components/map/`.
  Section 9 has the numbers.
- **Coexistence should be a switch, not a stack.** Phase 1 runs the national view as its
  own mode, where deck owns the whole map. Phase 2 swaps the origin view behind
  `?renderer=deck` and then deletes the Canvas modules. Both renderers never draw on screen
  at the same time, so camera sync is a one-time state hand-off, not a per-frame
  mirror.
- **Labels stay off-deck.** A thin 2D overlay canvas keeps today's collision placement and
  native CJK text. `TextLayer` with `characterSet: 'auto'` is technically viable, and is
  evaluated in Phase 0 as an option.
- **Effort.** Phase 0 is 1 day. Phase 1 is 4–6 days. Phase 2 is 8–12 days. Phase 3 is 3–5
  days of web work, plus pipeline work for the national flow layer.

---

## 1. Current client inventory (what has to be replaced)

`web/src/components/map/` is **3,146 lines** across 11 modules, all imperative Canvas 2D
driven from one `draw(M)` in `render.ts`. The paint order is: backdrop → chords → flows →
infra → trains → hover segment highlight → stations → labels → legend sync → scale bar.

| # | Visual element / behaviour | Where today | deck.gl target | Notes |
|---|---|---|---|---|
| 1 | Paper background | `backdrop.ts paintBackdrop` (`pal.paper` fillRect) | CSS `background` on `#mapwrap` plus a transparent deck canvas | No layer needed |
| 2 | Country outline rings (fill + stroke) | `backdrop.ts drawOutline` | `SolidPolygonLayer` (fill `pal.landFill`) + `PathLayer` (stroke) | Width `max(0.65, scale·0.015)` becomes `widthUnits:'common'`, `getWidth 0.015`, `widthMinPixels 0.65` |
| 3 | Open boundary lines and the nine-dash line | `drawOutline` (lines with `len ≤ 4` are dashed) | `PathLayer` + `PathStyleExtension({dash:true})`, `dashUnits:'pixels'` **[source]** | Dash sizes as today: `[max(6,2.2w), max(4,1.8w)]` |
| 4 | Graticule (5° grid) | `drawGraticule`, rebuilt per view | Static `LineLayer` over a fixed lon 60–150 / lat 0–60 grid, 0.5 px | No per-view rebuild |
| 5 | Base network | `drawNetwork` | `PathLayer` on `atlas.net` (binary, `startIndices`); `common` width 0.008, min 0.45 px, max 2.5 px | Today's clamp maps one-to-one onto `widthMinPixels`/`widthMaxPixels` |
| 6 | Qiongzhou ferry (dashed blue, water part only) | `isFerry` bbox test plus `traceInto(..., "landOnly"/"waterOnly")`, **re-split every frame** | Split the ferry polylines once at decode into land and water pieces (new `lib/ferry.ts`); water pieces go to a dashed `PathLayer` | The bbox test is duplicated 6× today (`backdrop`, `flows` ×3, `interaction`); it becomes one helper |
| 7 | Backdrop offscreen cache | `drawBackdrop` + `BackdropCache` | **Deleted.** GPU layers are cheap to redraw | — |
| 8 | Routed flows: width ∝ trains, colour ramp `flowColor` | `flows.ts drawFlows / strokeFlowList` (0.25 px width buckets) | `PathLayer` on `sec`/`inSec` (binary geometry uploaded once); `getWidth = n·WIDTH_K/fitScale` with `widthUnits:'common'` and `widthMinPixels:0.5`; `getColor` from the `flowColor` RGBA | Width becomes zoom-invariant in world units, so pan and zoom cost **zero** attribute updates |
| 9 | Flow dimming passes (selected city, filtered view, isolated train) | `drawFlows` branches, faded pass α 0.06–0.18 | Two `PathLayer` instances: `flows-context` (faded) and `flows-focus` | Alpha differs where paths overlap; see §3 |
| 10 | Animated flow growth (`secFlowSteps`, `maxFlowSteps`) | `drawFlows` (`step = floor(t/stepMins)`) | Same data; `updateTriggers: {getWidth: step, getColor: step}` | Updates once per 5-minute step, not per frame |
| 11 | Isolated-train corridor (progressive partial path) | `drawFlows` isoTrain branch + `tracePartialSec` | `PathLayer` with one path built in `lib` (sections up to the current one + partial tail to the dot) | Rebuilt per frame for one path only: trivial |
| 12 | Infrastructure overlay (HSR / conventional hairlines) | `drawInfra` | `PathLayer` (shared geometry), 1.25 px, colour by `hsr[s]` | Connected/unconnected passes use `DataFilterExtension` or two layers |
| 13 | Chord legs (dashed straight lines) | `drawChords`, gated by first departure | `PathLayer` + `PathStyleExtension`, `dashUnits:'pixels'` | Gating (`chordDepCache`) moves to `lib` |
| 14 | Hover highlight (segment / chord), width +1.6 | `drawHighlightSeg`, the end of `drawChords` | `PathLayer` with 0–1 items (`flowHi`) | Or `autoHighlight`; see §3 |
| 15 | Station / city dots: radius `stationR · stationZoomK(t)`, colour `rampColor(fastest)`, edge `dotEdge` | `stations.ts drawStations / drawDot` | `ScatterplotLayer`, `radiusUnits:'pixels'`, `stroked`, `lineWidthUnits:'pixels'` | Radius depends on zoom: `updateTriggers.getRadius = stationT` (≤ 300 points, cheap) |
| 16 | Dot growth while animating (arrivals so far) | `drawDot` (`cityArrTimes` count ≤ t) | Same `lib` maths; `getRadius` trigger on `animTime` (per frame, ≤ 300 points) | — |
| 17 | Arrival ripple (gold ring, 20 min) | `drawDot` `recentArrival` | `ScatterplotLayer` `filled:false`, per-point radius and `getLineColor` alpha, per frame | Few points; exact parity possible |
| 18 | Selected / hovered rings, origin hover ring | end of `drawStations` | `ScatterplotLayer` (0–3 points) | — |
| 19 | Origin marker (disc + white diamond) | `drawStations` | `ScatterplotLayer` (disc) + `IconLayer` (diamond from a 2-icon SVG atlas) | Or draw it on the label overlay canvas |
| 20 | Train dots: glow r4 + white core r2, α 0.45 on chords | `trains.ts drawTrains` | One `ScatterplotLayer`: `getFillColor` white, `getRadius 3`, `stroked`, `getLineWidth 2` px, `getLineColor` class colour, giving rings 2–4 px and core 0–2 px | One draw call |
| 21 | Gradient tails, 12 px × speedFrac (22 px isolated) | `drawTrains` (save/rotate/stroke per train), the spike's 16.6 ms | `LineLayer`: source = pos − heading·len/scale, `getSourceColor` = class colour α 0, `getTargetColor` = class colour α 255, `widthUnits:'pixels'` 2.5 | Recomputed per frame from the same buffer; zoom changes length via `1/scale` |
| 22 | Dwell ring (r 6.5, α 0.85) | `drawTrains` | `ScatterplotLayer` stroked-only, filtered to dwelling trains | — |
| 23 | Hover / selected / isolated train ring + code tag (`G123 · 45%`) | `drawTrains` | Ring: `ScatterplotLayer` (0–2 pts). Tag: label overlay canvas | Avoids `TextLayer` for 1–2 strings |
| 24 | City labels (collision-aware, tiers by zoom, boxed origin / selected) | `stations.ts drawLabels` (≈ 250 lines) | **Kept off-deck**: placement becomes pure `lib/labels.ts`; drawing goes to a thin overlay `<canvas>` | §1.2 has the justification |
| 25 | Hover tooltip (HTML) | `interaction.ts showTooltip` (≈ 190 lines of HTML) | **Unchanged** DOM `#tooltip`; the HTML builders move to `lib/tooltip.ts` (pure) | Positioned from deck `info.x/y` |
| 26 | Hit-testing: train > station/origin > segment (tie-break to the busier section within ±0.75 px) > chord | `interaction.ts pick*` (CPU, screen space) | Phase 1: deck picking for national dots. Phase 2: **owner decision D6** (§10) | §2.5 |
| 27 | Tap-to-select / tap-empty-to-clear / pinned tooltip | `pointer.ts endPointer` | `Deck.onClick(info)` (fires only on taps, not drags) | — |
| 28 | Pan / wheel zoom / pinch, clamp `fitScale·[0.55, 60]` | `pointer.ts`, `camera.ts zoomAt`, the wheel listener in `MapCanvas.tsx` | `OrthographicController` (`dragPan`, `scrollZoom`, `touchZoom`, `inertia`), `minZoom/maxZoom = log2(fitScale·0.55 / ·60)` | Wheel speed is calibrated to `exp(−deltaY·0.0016)` in Phase 1 |
| 29 | Fit country / fit home / fit Guangzhou initial / `panZoomTo` / `initialCamera` / keep the centre on resize | `camera.ts fit*`, `resize` | Same maths, producing a deck `viewState` (`lib/camera.ts`, pure) | `MapApi` contract unchanged |
| 30 | Scale bar | `camera.ts updateScaleBar` (direct DOM) | **Unchanged** logic; called from `onViewStateChange` | — |
| 31 | URL view report (debounced) | `reportViewChange`, `scheduleViewReport` | Unchanged; zoom formula `log2(scale·360/256)` kept for URL compatibility | — |
| 32 | Day / night themes | `lib/palette.ts palette(dark)` (CSS colour strings) | Add `rgba()` tuple variants (`flowColorRGBA`, `rampColorRGBA`, palette tuples) in `palette.ts`; theme becomes an `updateTriggers` key | String versions stay for DOM and Legend |
| 33 | DPR handling (cap 3) | `resize` sets the backing store | `useDevicePixels: Math.min(3, devicePixelRatio)` (Deck accepts a number) | Possibly cap at 2 on national mode (D8) |
| 34 | Origin-switch fade (`#map.switching`) | `MapCanvas.tsx` | Same CSS class on the deck canvas wrapper | — |
| 35 | Legend sync (`legendRef.current.draw(...)`) | `render.ts` | Called from `onAfterRender` (or on view change) | Legend is SVG and stays |
| 36 | Animation clock (`anim.ts`: play / seek / speed / listeners, tail speed-up ×2.5 after day 1) | `anim.ts` | **Kept** (renderer-agnostic); `draw(M)` becomes `deck.setProps({layers})` | `TimelineScrubber`, `TrainScheduleModal` subscribe unchanged |
| 37 | Loading / error / stale-reload overlay, isolation chip, timeline expand button | `MapCanvas.tsx`, `MapOverlays.tsx` (DOM) | **Unchanged** | — |

Everything outside `components/map/` and `MapCanvas.tsx` stays unchanged: panels, modals
(`TrainScheduleModal.tsx`, `DestinationPanel.tsx`), tables, histograms, Legend and the
toolbar. The **`MapApi` interface in `context.ts` is the seam.** The deck renderer
implements the same `MapApi`, so `App.tsx`, `Toolbar.tsx`, `TimelineScrubber.tsx` and
`TrainScheduleModal.tsx` do not change.

### 1.1 Target module layout (after Phase 2)

```
web/src/lib/               (pure, bun-testable; no deck imports)
  camera.ts      viewState <-> {scale,tx,ty}; fitExtent/fitCountry/fitHome; zoom clamps; scale-bar distance
  mapModel.ts    flow passes (items, alpha, maxN) for every selection/animation/isolation state;
                 chord gating; station sizes/ripples; the getSelCache rule (moved from map/trains.ts)
  labels.ts      label candidate + collision placement (ported from drawLabels; returns boxes)
  tooltip.ts     tooltip HTML builders (moved from interaction.ts)
  ferry.ts       one-time land/water split of the ferry sections
  national.ts    national per-train timelines (from the spike, reworked onto section refs; §2.3)
  (unchanged)    decode, filter, origin, timeline, stopEffects, palette(+RGBA), format, geo
web/src/components/map/
  deck/          DeckMap.tsx (Deck instance + controller + lifecycle + context loss),
                 layers/{backdrop,flows,stations,trains,national}.ts  (props builders only)
  labelsOverlay.ts   thin 2D canvas: draws placed labels, origin box, train tag
  anim.ts, api.ts    kept (api re-implemented over viewState)
```

### 1.2 Why labels stay outside deck (for now)

| Option | Pros | Cons |
|---|---|---|
| **Overlay 2D canvas (recommended)** | Pixel-identical text (native CJK shaping and system font fallback); keeps today's placement algorithm; about 40 lines of drawing on top of the pure placement | One extra canvas; must redraw on view change (cheap: ≤ about 60 labels) |
| `TextLayer` (`characterSet:'auto'`, `background:true`, `getBorderColor`) **[source]** | All on GPU; background boxes supported | SDF text at 10.5–14 px looks softer than native, especially thin CJK strokes. The atlas is built at `fontSize 64` on a 1024 px-wide canvas **[source]**, so a few hundred distinct glyphs is fine, but `'auto'` re-builds the atlas whenever the label set brings new characters (origin switch). Collision still has to be done in JS (`CollisionFilterExtension` uses a different, priority-only rule) |
| DOM labels (absolutely positioned) | Crisp; **screen-reader accessible** city names | About 60 elements re-positioned per pan frame; z-order against the tooltip; still needs JS collision |

Phase 0 takes side-by-side screenshots of the overlay vs `TextLayer` at the national view
and at city zoom. The owner picks (decision D5).

---

## 2. Data flow: pack to layers

### 2.1 What the pack provides (fmt 6, `lib/decode.ts DATA_FMT = 6`)

| Pack | Decoded into | Used by |
|---|---|---|
| `atlas-v2-shared` | `DecodedAtlas.sec / inSec / net / thr` (`DecodedSet`: `pts` Float32 flat lon/lat, `off` float offset, `len`, `bb`, `hsr`) | All path layers. **Geometry is uploaded to the GPU once per set** as binary paths (`startIndices = off/2`) |
| `atlas-v2-out-map` / `in-map` | `OriginVM.flows / inFlows / chords / dests / srcs` (`lib/origin.ts buildOrigin`) | Flow widths/colours, chords, station dots |
| `atlas-v2-out-tables` (`paths`, `stop_pos`, `chords`, per-origin `dep_off`) | `expandOutTables`, then `DepVM.secs / path / stopPos / chordLegs` | Origin timeline (`buildDayTimeline`); national timelines |
| `atlas-v2-in-tables` | `ArrVM` rows | Inbound panels; inbound flows |
| `atlas-v2-schedules` | `DecodedAtlas.schedules` (station-level times) | Dwells (`PrepTrainStop`), national stops |

`lib/` stays unchanged in Phases 1–2 apart from these additions: `palette.ts` gets RGBA
helpers; `camera.ts`, `mapModel.ts`, `labels.ts`, `tooltip.ts` and `ferry.ts` are extracted
from `components/map`; `national.ts` is promoted from the spike. `filter.ts`, `origin.ts`,
`timeline.ts`, `stopEffects.ts` and `decode.ts` stay byte-for-byte unchanged, which is what
lets the 62 existing tests keep guarding the semantics.

### 2.2 Layer data shapes

- **Static geometry (flows, infra, network, outline).** One binary `PathLayer` data object
  per `DecodedSet`:
  `data: {length: nSec, startIndices, attributes: {getPath: {value: set.pts, size: 2}}}`.
  Per-section width and colour come from **typed arrays indexed by section**
  (`widthArr[s]`, `colorArr[s*4..]`) through accessors `(_, {index}) => widthArr[index]`,
  with `updateTriggers`. A section with `n = 0` gets width 0 and is discarded in the shader.
  The geometry buffer never re-uploads when the selection or animation step changes; only
  the width and colour attributes are rebuilt. That costs O(vertices of the set) per
  trigger: about 1–4 ms at the 5-minute step rate **[estimate]**.
  - Alternative where the visible subset is small (the focus pass for a selected city):
    a non-binary `data = subFlows` (`{s, n}[]`) with `getPath` returning
    `set.pts.subarray(off, off + 2·len)`. That builds only the focus subset.
- **Animated dots (origin and national).** The CPU computes positions into the spike's
  interleaved `Float32Array` (6 floats per dot: lon, lat, ux, uy, speed, flags). Layers read
  it as binary attributes with `stride: 24`:
  `getPosition: {buffer: buf, size: 2, stride: 24, offset: 0}`. Colour comes from a parallel
  `Uint8Array(c·4)` filled in the same loop (or `DataFilterExtension` categories; §2.4).
  `data.length = c` changes per frame. deck re-uploads only the changed attributes, which is
  about 2.7k dots × 28 B = 75 KB/frame at the national peak.
- **Tails.** A second `Float32Array(c·4)` (source xy, target xy) filled in the same loop.
  `LineLayer` reads `getSourcePosition` and `getTargetPosition` binary.
- **Small per-frame sets** (ripples, dwell rings, highlight rings, isolated corridor):
  plain JS arrays (≤ a few hundred items).

### 2.3 National timelines and memory (A)

The spike (`lib/national.ts buildNational`) expands every train's full path into its own
vertex arrays: `vx`, `vy`, `vd` (Float32). That is **3.97 M vertices ≈ 48 MB** of CPU
memory, against **≈ 691 K section refs** in the pack **[measured, spike]**. At about 12k
trains, expect roughly 6.8 M vertices (≈ 82 MB) if nothing changes **[estimate, linear]**.

**Dedup plan (Phase 1).** Keep per-train **section refs plus cumulative starts**, exactly
like the origin `PrepTrain` (`secStarts`, `throatSpans`, `chordSpans`). Position-at-distance
then becomes "binary-search the path entry, then binary-search inside the shared section's
`secCumLens`". `getSecGeometry` in `timeline.ts` already caches those per `DecodedSet`.
Memory is about 691 K refs × (4 B id + 8 B start) ≈ **8 MB**, plus the shared geometry that
is already loaded. Per-frame cost is two binary searches per active train (≤ about 4.5k at
12k trains) **[estimate: < 1 ms]**.

Concretely: generalise `buildDayTimeline`'s per-train prep into an exported
`prepTrainPath(train, atlas)` in `timeline.ts`. Origin and national code then share one
implementation of distance space, chord gaps, throats and dwells. This is the only change
to `timeline.ts`, and the snapshot tests pin its output.

**Wrap-around (dots).** Keep the spike's rule: a train is drawn at display minute `m` for
every `k` with `start ≤ m + 1440k ≤ end` (`natPositions`). It already handles overnight and
multi-day trains, and it produces two dots when a train's run is longer than 24 h.

### 2.4 TripsLayer (optional "comet trails" mode; Phase 1 stretch / Phase 3)

TripsLayer 9.4.0 (`@deck.gl/geo-layers`) **[source]** works as follows:

- `getPath` and `getTimestamps` are per vertex.
- `currentTime` and `trailLength` are in the same unit as the timestamps (we use minutes).
- `fadeTrail` defaults to true.
- The shader interpolates time linearly along each segment and discards fragments where
  `vTime > currentTime` or `vTime < currentTime − trailLength`.
- It draws **only the trail, never a head**, so the dot heads still come from the
  `ScatterplotLayer` above.

Timestamp generation, from `lib/national.ts` / `prepTrainPath`:

1. **Per vertex** of the train's full path, `timestamp = timeAtDist(pt, cumDist[v])`. This
   is the existing inverse of `trainDistAt`, so the trail eases exactly as the dot does
   (`trainEase`), up to vertex resolution.
2. **Dwells.** Insert a duplicate vertex at the stop position, with
   `timestamp = arrMins` on the first copy and `depMins` on the second. A zero-length
   segment gives `vPathLength = 0`. To avoid a 0/0 in the shader, offset the second copy
   by about 1e-6° along the heading. This needs a Phase 0 check: the path tesselator's
   `normalize` may drop exact duplicates.
3. **Wrap-around.** TripsLayer has one `currentTime`. For trains with `end > 1440`, add a
   *shifted copy* (timestamps − 1440·k) for each extra day. That adds data only for
   overnight and multi-day trains, not for all trains. Phase 0 counts this share; the
   alternative is a second layer instance at `currentTime + 1440`, which doubles the GPU
   attributes.
4. **Precision.** Timestamps up to 4,320 min in float32 have a resolution of about 5e-4 min.
   That is fine.

Memory is the blocker:

- The PathLayer family stores positions as 64-bit (CPU Float64, plus high and low parts on
  the GPU) in the default and cartesian coordinate systems.
- Add timestamps, widths, colours, segment types and picking colours on top.
- That is about **50–60 B per vertex on the GPU plus about 30 B on the CPU [estimate]**.
- So: 3.97 M vertices ≈ 200–240 MB GPU; 6.8 M vertices ≈ 340–400 MB.
- **Too much for phones.** It only works with per-train **path simplification for trails**
  (Douglas–Peucker at about 0.005°, roughly sub-pixel below zoom ≈ 200 px/°). We expect 5–10×
  fewer vertices **[estimate]**, which Phase 0 measures.

### 2.5 Picking

| Target | Phase 1 (national) | Phase 2 (origin view) |
|---|---|---|
| Train dots | deck GPU picking on the dots layer (`pickable: true`, `pickingRadius: 10`); `info.index` → slot in the frame buffer → train | Same; still only when paused (today's rule in `pickTrain`) |
| Stations / origin | — | deck picking on the stations layer (radius is already in pixels) |
| Sections / chords | — | **D6**: (a) GPU picking with today's priority applied over `deck.pickMultipleObjects({x, y, radius: 10})`. Or (b) keep the CPU `pickSegment` from `interaction.ts`, moved to `lib` and fed with `viewport.project`. (b) keeps today's ±0.75 px "busier section wins" tie-break exactly; (a) deletes about 150 lines. Recommendation: **(a) with the tie-break re-implemented over the picked candidates** |

Picking only ever sees what the layers hold. Most of today's gating code ("not pickable
unless active at `animTime`", destination subset, isolated train's reached sections) is
needed only because the CPU pick walks *all* flows. Under deck that gating falls away,
because each layer's data **is** the visible set.

### 2.6 Update strategy

| Change | Layers touched | Mechanism |
|---|---|---|
| Pan / zoom | none, or `stations` (radius via `stationT`), `labelsOverlay`, tails (length ∝ 1/scale) | `viewState` only; `updateTriggers.getRadius = round(stationT, 3)` |
| Animation frame | dots, tails, dwell rings, ripples, station growth, isolated corridor | New binary attributes per frame (`data.length` changes); everything else memoised |
| Animation step (5 min) | flows width/colour | `updateTriggers: {getWidth: step, getColor: step}` |
| Origin / direction | everything except backdrop | New `cur` identity is the trigger key |
| Class / histogram / train filter (new `cur` from `lib/filter.ts`) | flows (context + focus), chords, stations, dots | Same: `cur` identity. `isFilteredView` logic moves to `mapModel` |
| Selected city (`panelDest`) / isolated train | flows-focus, infra, stations, dots (via `getSelCache`) | Rebuild focus-layer data; `trainShownAt` / `stopArrivalTimes` (`lib/stopEffects.ts`) stay the single visibility rule |
| Theme | all colours | `dark` in every colour trigger |

**`DataFilterExtension` (9.4: `filterSize` up to 4, `filterSoftRange`, categories,
`countItems`) [source].** Use it only where the geometry is static and only visibility
changes:

- national dots by class category (G/D/C vs Z/T/K/S vs other) without touching the CPU loop;
- infra "connected vs not" passes;
- Phase 3: hide B sections below a threshold.

Do **not** use it for flow widths. Class filters change *n*, and therefore width, which a
visibility filter cannot express.

---

## 3. Visual parity

| Element | Expected difference | Option to get closer | Decision needed? |
|---|---|---|---|
| Faded flow passes (α 0.06–0.18) | Canvas strokes one bucket path at a time, so overlaps *within* a bucket do not compound alpha. In deck each path blends separately, so joints and parallel overlaps get **darker** | Draw the context pass **opaque** with colours pre-blended against `pal.paper` (`mix(col, paper, 1−α)`). Visually identical except that the network no longer shows through faded flows | **D3** |
| Flow joints / caps | Canvas `lineCap/lineJoin: round`; deck `capRounded`/`jointRounded` are equivalent, but the miter at sharp section joins differs subtly | `jointRounded: true, capRounded: true`, `miterLimit` default | No |
| Width quantisation | Canvas rounds widths to 0.25 px steps; deck is continuous | None needed (deck is more correct) | No |
| Gradient tails | Same straight tail and length. The colour interpolation may differ at the transparent end (Canvas interpolates premultiplied; `LineLayer` interpolates vertex colours un-premultiplied) | Use class colour α 0 as the source colour (not transparent white) to avoid a whitish fringe. `LineLayer` has no round cap, but the cap is hidden under the head | No (screenshot check) |
| Tails, TripsLayer mode | Track-following trail measured in **minutes**, so on-screen length varies with speed and zoom | Only if the owner wants the comet look (D2) | **D2** |
| Dots | Stroke-trick dot is a crisp antialiased ring; Canvas arcs look the same | — | No |
| Arrival ripples / dwell rings | Exact (same radius and alpha maths) | — | No |
| Flow "glow" | There is **no glow** in today's renderer (hover is width +1.6 in `flowHi`). Nothing to match | — | No |
| Dashes (chords, ferry, nine-dash) | `PathStyleExtension` dashes restart per path, as Canvas does with `setLineDash` per stroke; with `dashJustified: false` they behave the same. Phase 1 confirms on screen | `dashUnits: 'pixels'` | No |
| Labels | Identical (overlay canvas) | — | **D5** if `TextLayer` |
| Antialiasing | WebGL MSAA vs Canvas AA: hairlines (0.45–0.5 px floors) can look thinner or shimmer during pan | `widthMinPixels` 0.6 instead of 0.45–0.5 if needed | Maybe (screenshot review) |

---

## 4. Phases

### Phase 0: spike (1 day). Go / no-go for the whole migration

**Scope.** Throwaway branch `spike/deckgl`. A deck national view behind `?national=deck`,
reusing `lib/national.ts` from `600b3de` as is. Layers: network `PathLayer`, dots
`ScatterplotLayer` (stroke trick), tails `LineLayer`, optional `TripsLayer` on a simplified
subset. A synthetic 12k load is produced by duplicating trains with a time shift (e.g. +37
min) until n ≈ 12,000.

**Measurements to collect** (extend the scratchpad drivers `drv/nat2.mjs` / `perf.mjs`;
see §6):

| # | Metric | How | Pass threshold |
|---|---|---|---|
| M1 | Frame time at national peak (18:15, 2,668 trains today; synthetic about 4.6k at 12k) on M4 Max, DPR 2 | `deck.metrics.cpuTimePerFrame` + `gpuTimePerFrame` + rAF interval p50/p95 over 300 frames | p95 rAF interval ≤ 16.7 ms; CPU ≤ 4 ms |
| M2 | Same with CDP `Emulation.setCPUThrottlingRate {rate: 4}` (and 6) | as M1 | p95 ≤ 33 ms at 4× |
| M3 | Real low-end GPU: one mid-range Android (Snapdragon 7-series class, Chrome) + one iPhone (A15 class, Safari), DPR native | Remote DevTools / Safari Web Inspector timeline; on-page FPS meter from `deck.metrics.fps` | ≥ 30 fps sustained at peak, national view, no tab reload |
| M4 | GPU memory | `deck.metrics.gpuMemory` / `bufferMemory` (luma stats) **[source]** | Dots-and-tails path ≤ 64 MB; TripsLayer path reported, gated ≤ 150 MB after simplification |
| M5 | CPU memory | `performance.measureUserAgentSpecificMemory()` (cross-origin-isolated) or heap snapshot | National timelines ≤ 30 MB with section-ref dedup (prototype the dedup in the spike if time allows; else report the spike's 48 MB) |
| M6 | Bundle | `bundle.mjs` output: deck chunk min / gzip / brotli | ≤ 300 KB brotli for the deck chunk (measured 217 KB for the full set) |
| M7 | Time to first national frame | `performance.now()` from mode toggle to first `onAfterRender` with dots | ≤ 1.5 s on M4 Max after packs are cached; report the 4× number |
| M8 | Projection exactness | unit test: `OrthographicViewport.project` vs `camera.ts X/Y` | ≤ 1e-6 px (already shown: 4.6e-13) |
| M9 | Headless SwiftShader | `--use-angle=swiftshader` run of M1 | Renders non-blank, no errors (perf is not judged) |
| M10 | Label options | screenshots of overlay vs `TextLayer` at national view and at city zoom | Owner eyeball (D5) |
| M11 | TripsLayer dwell / zero-length segments | visual check at a known long dwell | Trail pauses with no artefacts |

**Fail handling.**

- If M1–M3 fail on the dots-and-tails path: deck does not buy national performance. Stop,
  and keep Canvas with the spike's sprite variant.
- If only TripsLayer fails M4: drop comet mode (D2) and continue.

**Deliverable.** A results table appended to this doc (§11), plus screenshots. **Deleted:**
the spike branch is not merged.

### Phase 1: national animation (A) on deck.gl (4–6 days)

**Scope.**

- `lib/national.ts` promoted and reworked onto section refs (§2.3), with
  `prepTrainPath` shared with `timeline.ts`.
- New `components/map/deck/DeckMap.tsx` owning a `Deck` instance with
  `views: new OrthographicView({id: 'map', flipY: false, controller: {...}})`, controlled
  `viewState` and `useDevicePixels`.
- The national mode toggle (toolbar or URL `?national=1`) shows `DeckMap` *instead of* the
  Canvas. Layers: outline, graticule, network, national dots, tails, dwell rings, picking
  on paused dots, and the tooltip via `lib/tooltip.ts`.
- `anim.ts` drives national time (0–1440 wrap) through the existing `MapApi` / `subscribeAnim`.
- Build: deck becomes a separate hashed chunk loaded on first national toggle (§7, R2).
- Context-loss handling (§7, R3).
- Version pins (exact `9.4.0`, lockfile).

**Acceptance.**

- The M1–M4 thresholds hold on the real build.
- Overnight trains visibly wrap: dots present at 00:30 on trains that left the day before.
  A test on `natPositions` counts at 00:30 vs the schedules covers this.
- Pause → hover a dot → tooltip; click → `TrainScheduleModal` opens.
- Switching national ↔ origin keeps the geographic centre and zoom (`viewState` ↔ `View`
  hand-off through `lib/camera.ts`).
- `bun test` stays green (62 tests) and adds new `national` tests: wrap-around, peak count
  (2,668 at 18:15 on the current pack) and dedup position equality against the spike's
  expanded vertices (≤ 1e-6°).
- With national mode never opened, the bundle downloads no deck bytes (network panel check).

**Deleted:** nothing in the origin view. `components/map/national.ts` (spike) is not
carried over.

**Effort:** 4–6 days (1 for the dedup and tests, 1–2 for DeckMap, controller and lifecycle,
1 for the bundle split, 1–2 for interaction, tooltip, polish and device testing).

### Phase 2: migrate the origin view, then remove Canvas (8–12 days)

**Phase 2a: extract the semantics (pure, both renderers use them), 3–4 days.**

- `lib/mapModel.ts`: `flowPasses(state)`, the logic of `drawFlows` / `drawInfra` /
  `drawChords` / `drawHighlightSeg` as data. `state` holds `{cur, baseCur, dir,
  animTime, animEnabled, panelDest, iso, showInfra}`, and the function returns
  `{items: {s, n}[], alpha, maxN}[]`. Also `chordVisibility`, `stationStates` (radius
  inputs, ripple frac, alpha), `isolatedCorridor`, and `getSelCache` / `isTrainShown`
  (moved from `map/trains.ts`, still delegating to `lib/stopEffects.ts`).
- `lib/labels.ts` (placement returns boxes and text), `lib/tooltip.ts`, `lib/camera.ts`,
  `lib/ferry.ts`.
- The Canvas modules are refactored to call these, with **no visual change**: the
  screenshot diff against `main` is zero.
- New tests on `mapModel`: selected-destination passes, filtered-view passes, isolation
  passes, the destination-window rule (dots and ripples end at the destination, the recent
  `stopEffects` rule), and chord gating.

**Phase 2b: deck adapters behind `?renderer=deck`, 4–6 days.**

- Layers per the §1 table, all as thin props builders over `mapModel` outputs.
- Pointer and wheel move to the deck controller; `onHover` / `onClick` reproduce `pointer.ts`
  semantics (hover tooltip only for mouse; tap on station → `onSelectDest`; tap on train →
  `onSelectTrain`; tap on segment/chord → pinned tooltip; tap on empty → clear).
- The `labelsOverlay` canvas is drawn in `onAfterRender` from `viewport.project`.

**Phase 2c: flip the default, then delete, 1–2 days.**

- `?renderer=canvas` stays as an escape hatch for **one release (≤ 2 weeks)**, then it is
  removed.

**Acceptance (2b/2c).**

- Screenshot-diff suite (§6) within agreed tolerance on every scenario.
- Interaction checklist passes: pan, wheel, pinch, fit buttons, URL camera restore, scale
  bar km/mi, selection, isolation, class filter, histogram filter, inbound direction,
  animation play/seek, night mode, DPR 1/2/3.
- Perf: origin view at 60 fps on M4 Max and ≥ 30 fps on the M3 devices during animation.
- No TS errors; 62 + new tests green.

**Deleted in 2c:**

- `backdrop.ts` (240)
- `flows.ts` drawing code (`traceInto`, `tracePartialSec`, `strokeFlowList`, `drawInfra`,
  `drawChords`, `drawHighlightSeg`; about 700 of 853, the remainder having moved to
  `mapModel`)
- `stations.ts` drawing (about 180) and the `drawLabels` drawing half
- `trains.ts drawTrains` (about 140)
- `render.ts` (82)
- `pointer.ts` (119)
- the `interaction.ts` pick maths (about 200)
- `BackdropCache` / `tailGradRef` / pointer state in `context.ts` (about 80)
- the wheel and canvas handlers in `MapCanvas.tsx`

**Effort:** 8–12 days.

### Phase 3: B (national flows) and A+B (flows growing over time), 3–5 days of web work

- **B.** A national section-flow layer from the pipeline (separate pipeline task: a
  national `flows` table per section with `byClass`, aggregated over all trains; format
  bump to fmt 7 or a new `atlas-v2-national.json.br`). Rendered with the same binary
  `PathLayer` as origin flows. Class filter = `Σ byClass[selected]` into `widthArr`
  (trigger on the class set).
- **A+B.** Per-section cumulative entry counts per 5-minute step. Today that is
  `secFlowSteps: Map<sec, Uint16Array(numSteps)>`; nationally it becomes about 7.5k sections
  × 288 steps × 2 B ≈ 4.3 MB, computed from the national timelines' section entry times
  (already produced as `trainEntries` in `timeline.ts`), or shipped precomputed by the
  pipeline. Width and colour triggers fire per step.
- **Wrap semantics for A+B (owner decision D7).** Either "cumulative since 00:00, reset at
  midnight" or "rolling 24 h window (always full)". Only the former shows growth.
- **Optional comet mode** (TripsLayer, simplified paths) if D2 is yes and Phase 0 M4 passed.

**Acceptance.** B totals per section equal the pipeline's audit (`pack-audit` goldens
extended); A+B at 24:00 equals B (a test); 60 fps on M4 Max.

**Deleted:** nothing more. Phase 3 is additive.

---

## 5. Interim coexistence (two renderers)

| Concern | Plan |
|---|---|
| **Shape** | Mode switch, not stacking. In Phase 1, deck is mounted only in national mode; in Phase 2b it is selected by `?renderer`. The two never draw at once, so draw order between renderers never arises |
| **Camera sync** | One source of truth: `lib/camera.ts` converts `{scale, tx, ty, W, H}` ↔ `viewState {target, zoom}` (formulas in §0). Handed off on mode switch and on `initialCamera`. The URL format is unchanged |
| **Input ownership** | Whichever renderer is mounted owns pointer and wheel. The deck controller in deck mode; `pointer.ts` in Canvas mode. No shared listeners |
| **Shared state** | `anim.ts` clock, `MapApi`, tooltip DOM, scale-bar DOM and Legend are shared and renderer-agnostic. `draw(M)` is the only call that dispatches per renderer |
| **If stacking is ever needed** (e.g. deck dots over Canvas flows) | deck canvas on top with `pointer-events: none`, `controller: false`, `viewState` pushed from `S.current.view` inside Canvas `draw()`. Not planned |
| **Duration** | From the start of Phase 1 to the end of Phase 2c: about 3–4 weeks of calendar time. The `?renderer=canvas` hatch lives at most one release after the default flips |
| **Avoiding getting stuck** | (1) Phase 2a makes both renderers consumers of the same `mapModel`, so a semantic fix lands once. (2) Feature freeze on Canvas drawing code once 2b starts: new visual features land deck-only. (3) The 2c deletion is a dated checklist item with its own PR. (4) If 2b slips more than 2 weeks past its estimate, the owner re-decides (keep Canvas for origin, deck for national only), with no third state |

---

## 6. Testing strategy

| Layer | What | Where / CI |
|---|---|---|
| Data-level (existing) | 62 tests / 7 files (`decode`, `animation`, `snapshots`, `stopEffects`, `headingCount`, `stationBreakdown`, `staleReload`) **[measured: 62 pass]** | Unchanged; `bun test` in CI |
| New pure tests | `lib/camera.ts` (deck projection equality, fit maths, zoom clamps); `lib/mapModel.ts` (passes per state, destination-window rule, chord gating); `lib/labels.ts` (placement deterministic for fixture origins); `lib/national.ts` (wrap-around, peak count, dedup equality); `lib/ferry.ts` | `bun test` (deck's `OrthographicViewport` imports and runs under Bun without WebGL **[measured]**) |
| Layer-props tests | Each `layers/*.ts` builder: given a `mapModel` output, it returns expected `data.length`, trigger keys and accessor values (no GPU) | `bun test` |
| Screenshot diff | Promote the scratchpad puppeteer drivers (`drv/shots.mjs`, `clsshots.mjs`, `hcshots.mjs`, `minshots.mjs`) to a committed `web/tools/shots/`. Scenarios: national fit, Guangzhou initial, city zoom ×10, selected city, isolated train mid-journey, class filter, inbound, infra on, night, animation at 06:00 / 18:15 / 23:50, DPR 1/2. Compare `canvas` vs `deck` (2b) and deck vs a baseline (later) with pixelmatch-style tolerance (`drv/cmp.py`) | **Local / macOS with GPU**, not in CI (see the SwiftShader note) |
| Headless WebGL | Linux CI Chrome falls back to **SwiftShader** (software WebGL2). It works for smoke tests but is slow, and its antialiasing differs from real GPUs, so pixel diffs there are meaningless | CI gets a smoke job: build → serve `dist` → puppeteer with `--use-angle=swiftshader --enable-unsafe-swiftshader` → assert no `pageerror`, deck `onAfterRender` fired, the canvas has non-paper pixels |
| Context loss | Puppeteer: `gl.getExtension('WEBGL_lose_context').loseContext()`, then expect the recovery notice and a working map after restore | Local + CI smoke |
| Perf | Phase 0 M1–M4 method: fixed time sweep through the peak (`nat2.mjs` pattern: `animTime = PEAK + i·0.2`), `deck.metrics` + rAF intervals, CPU throttle via CDP; report p50/p95/max | Local; numbers recorded in `docs/benchmarks/` (existing folder) |
| CI changes | (1) `bun run build` must also check the deck chunk exists and print its size (fail if > 300 KB brotli). (2) The new smoke job above. (3) `--frozen-lockfile` already guards the deck version pin | `.github/workflows/ci.yml` |

---

## 7. Risks and mitigations

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | **Version churn.** deck.gl 9.x minors change APIs (e.g. `PathStyleExtension dashUnits` is new); luma.gl moves fast (WebGPU work) | Medium / medium | Pin exact `9.4.0` (no caret) for all `@deck.gl/*`; `bun.lock` committed; upgrades only as deliberate PRs run through the screenshot suite |
| R2 | **Bundle and build integration.** `bundle.mjs` emits one IIFE inlined into `index.html` (no code splitting); `index.html` is `max-age=0, must-revalidate` | High / medium | Switch `bundle.mjs` to `format: "esm", splitting: true` (esbuild path; the Bun.build branch has the same option), write chunks to `dist/assets/*.<hash>.js` (covered by the existing `immutable` header in `vercel.json`), keep the small entry inline as `<script type="module">`, and `import()` deck lazily on first national toggle (Phase 1) / renderer mount (Phase 2). Keep the `</script` escaping only for the inline entry. Alternative with a smaller diff: build deck as a second IIFE exposing `window.deck`, content-hashed like the data packs, and add it to `__ASSET_MANIFEST__` |
| R3 | **WebGL2 unavailable or context loss.** deck 9 requires WebGL2; on context loss it only calls `onError('WebGL context is lost')` and does not restore **[source]** | Low availability risk (WebGL2 ≈ universal on current browsers); medium loss risk on mobile (backgrounded tabs, GPU memory pressure) | `onError`: detect loss, show a "Map paused, tap to resume" notice, `deck.finalize()` and create a new `Deck` from the retained CPU data (layers are pure functions of state). No WebGL2: show a notice; panels and tables keep working. **D9** decides whether to keep a Canvas fallback (we recommend no) |
| R4 | **Mobile GPU memory** | Medium / high for TripsLayer, low for dots and tails | Section-ref dedup; no TripsLayer by default; cap DPR at 2 in national mode on `navigator.deviceMemory ≤ 4` (D8); M3/M4 gates |
| R5 | **Accessibility.** Canvas content is not accessible today either. A11y comes from the DOM: tables, panels, tooltip `role=status` | Unchanged | Keep the DOM surfaces; optional DOM labels (D5) would *improve* a11y; add a visually hidden live summary of the national animation ("2,668 trains running at 18:15") from `getAnimState` |
| R6 | **Regression in selection and filter semantics.** Examples: the destination-window rule (`trainShownAt`, `stopArrivalTimes` in `lib/stopEffects.ts`, commit `82e0f22`); the station-count and heading class filters (`headingCount.test.tsx`, `stationBreakdown.test.ts`); the dimming rules; chord gating; "pickable only if active" | Medium / high (subtle and easy to miss) | Phase 2a extracts these into `mapModel` **before** any deck code and tests them; the Canvas renderer consumes the same functions, so a mismatch shows as a screenshot diff of zero vs non-zero. Train-visibility is one function used by dots, picking, counters and stop effects, as it is today |
| R7 | **Picking semantics drift** (the ±0.75 px busier-section tie-break; paused-only train hover) | Medium / low | D6; tests on a `pickPriority(candidates)` pure function |
| R8 | **Interaction feel** (wheel speed, inertia, tap threshold 5 px vs mjolnir's defaults, pinch) | Medium / medium | Calibrate `scrollZoom.speed`; `inertia: false` initially to match today; manual checklist on trackpad, mouse and touch |
| R9 | **Hairline appearance** (0.45–0.5 px floors under MSAA) | Medium / low | Screenshot review; raise the floors slightly if they shimmer |
| R10 | **Getting stuck with two renderers** | Medium / high (maintenance) | §5 exit rules |
| R11 | **Data growth to about 12k trains** | Certain / medium | Dedup makes memory scale with refs, not vertices; Phase 0 synthetic 12k load; per-frame CPU ∝ active trains |
| R12 | Bun.build vs esbuild branches in `bundle.mjs` diverge with splitting | Low / medium | Choose one bundler for production (esbuild is already a devDependency); drop the other branch |

---

## 8. What stays unchanged

- All React UI outside the map: `App.tsx` (except the renderer and mode switch),
  `Toolbar.tsx`, `TimelineScrubber.tsx`, `TrainScheduleModal.tsx`, `DestinationPanel.tsx`,
  `DeparturesTable.tsx`, `Histograms.tsx`, `Legend.tsx` (SVG), `MapOverlays.tsx`,
  `CityPicker.tsx`, `ActiveFilterBar.tsx`.
- Hooks: `useAtlasData`, `useSelection`, `useUrlState` (URL camera format kept),
  `useAnimationClock`, `useDialog`.
- `lib/`: `decode`, `filter`, `origin`, `timeline` (plus the one exported
  `prepTrainPath`), `stopEffects`, `format`, `geo`, `palette` (plus RGBA helpers).
- Data packs (fmt 6) through Phase 2; `vercel.json` headers; `staleReload` behaviour.
- Owner rules: no MapLibre, no basemap tiles, no API keys. deck.gl runs standalone with
  `OrthographicView` and draws our own outline and network.

---

## 9. Maintainability: custom render code before and after

Lines are `wc -l` of `web/src/components/map/*.ts` plus `MapCanvas.tsx` today
**[measured]**; the other columns are **[estimate]**.

| Module | Today | After P1 | After P2c | Notes |
|---|---:|---:|---:|---|
| `backdrop.ts` | 240 | 240 | 0 (→ about 60 in `deck/layers/backdrop.ts`) | Cache and ferry split go |
| `flows.ts` | 853 | 853 | 0 (→ about 250 `mapModel` + about 120 layers) | Drawing boilerplate goes; semantics stay, tested |
| `stations.ts` | 432 | 432 | 0 (→ about 200 `lib/labels.ts` + about 80 layers + about 50 overlay) | — |
| `trains.ts` | 278 | 278 | 0 (→ about 90 to `mapModel`, about 60 layers) | — |
| `interaction.ts` | 439 | 439 | about 80 (hover/click glue) + about 190 `lib/tooltip.ts` | The pick maths goes (D6a) |
| `pointer.ts` | 119 | 119 | 0 | deck controller |
| `camera.ts` | 187 | 187 | about 110 (`lib/camera.ts`) | — |
| `render.ts` | 82 | 82 | 0 | — |
| `context.ts` | 275 | 275 | about 150 | Pointer, backdrop and gradient state go |
| `anim.ts` / `api.ts` | 241 | 241 | about 240 | Kept |
| `MapCanvas.tsx` | 216 | about 230 | about 160 (`DeckMap.tsx`) | — |
| spike `national.ts` (render) | (244 on spike) | 0 (→ about 120 `deck/layers/national.ts` + about 150 `DeckMap.tsx` lifecycle) | — | — |
| **Total custom render-side code** | **≈ 3,360** | **≈ 3,630** (national added) | **≈ 1,500** of glue/layers + ≈ 750 pure, tested `lib` | Pure `lib` code is testable without a browser; today almost none of `components/map` is |

So after Phase 2 the render-side code shrinks by about 55%, and the semantic code moves
into tested pure modules. The remaining custom drawing is the label overlay (about 50 lines).

---

## 10. Owner decision list

| # | Question | Recommended answer |
|---|---|---|
| D1 | Proceed with Phase 0 (1 day) as the go/no-go gate before any production change? | **Yes.** Phase 1 starts only if M1–M4 pass |
| D2 | Do you want a TripsLayer "comet trail along the track" look, or today's short straight tails (exact parity, far cheaper)? | **Straight tails by default.** Comet mode only as an optional toggle in Phase 3, and only if M4 passes with simplified paths |
| D3 | Faded context flows: accept opaque pre-blended colours (network no longer shows through faded flows) to avoid alpha build-up at overlaps? | **Yes, pre-blended opaque** |
| D4 | Bundle: is "+400 KB" measured as transfer size or minified size? deck is 217–262 KB transferred but 833–949 KB minified | **Accept as transfer size**, with deck as a lazily loaded hashed chunk (no cost until the deck view is used) |
| D5 | Labels: overlay canvas (pixel parity), `TextLayer` (all-GPU, softer CJK), or DOM labels (accessible)? | **Overlay canvas now**; revisit DOM labels for a11y after Phase 2 |
| D6 | Segment and chord picking: GPU picking plus a re-implemented priority (deletes about 150 lines, may shift edge cases by about 1 px) or keep the CPU picker? | **GPU picking with the priority function**, tested |
| D7 | A+B wrap semantics: cumulative since 00:00 (shows growth, resets at midnight) or a rolling 24 h window? | **Cumulative since 00:00**; at 24:00 it equals B |
| D8 | On low-memory devices (`deviceMemory ≤ 4`), cap DPR at 2 in national mode? | **Yes** |
| D9 | Keep a Canvas fallback after Phase 2 for no-WebGL2 / lost-context devices? | **No.** Show a notice and keep the tables and panels working; a fallback would keep about 1,900 lines alive |
| D10 | Freeze new Canvas drawing features from the start of Phase 2b (new visuals land deck-only)? | **Yes** (it prevents getting stuck with two renderers) |
| D11 | National mode entry point: URL flag only for Phase 1, or a visible toolbar toggle? | **Toolbar toggle**, labelled beta, plus the `?national=1` URL flag |
| D12 | Is a separate pipeline task for B (a national per-section flow table, fmt bump) acceptable once Phase 1 has shipped? | **Yes.** It is scheduled with the new about-12k-train schedule data so the pack changes once |

---

## 11. Phase 0 results (to be filled in)

| Metric | Result | Pass? |
|---|---|---|
| M1 … M11 | — | — |

## Sources

- deck.gl 9.4.0 / luma.gl 9.4.2 package source (npm `latest`, inspected locally):
  `@deck.gl/geo-layers/dist/trips-layer/trips-layer.js`,
  `@deck.gl/core/dist/viewports/orthographic-viewport.js`, `@deck.gl/core/dist/lib/deck.js`
  (metrics, `_onContextLost`, `useDevicePixels`), `@deck.gl/layers/dist/text-layer/*`
  (`characterSet`, font atlas `fontSize 64`, `MAX_CANVAS_WIDTH 1024`, background props),
  `@deck.gl/extensions/dist/{data-filter,path-style}` (`filterSize`, categories,
  `dashUnits`).
- Docs: https://deck.gl/docs/api-reference/core/orthographic-view,
  https://deck.gl/docs/api-reference/geo-layers/trips-layer,
  https://deck.gl/docs/api-reference/layers/text-layer,
  https://deck.gl/docs/api-reference/extensions/data-filter-extension,
  https://deck.gl/docs/api-reference/core/deck (picking, `onError`, metrics).
- Spike: `spike/national-anim` @ `600b3de` (`web/src/lib/national.ts`,
  `web/src/components/map/national.ts`), measurements quoted from the spike report.
- Bundle measurement: esbuild 0.28.2, `--bundle --minify --format=iife --target=es2020`,
  three import sets (core+Path+Scatter / +Trips / +Text+Line+DataFilter+PathStyle).
