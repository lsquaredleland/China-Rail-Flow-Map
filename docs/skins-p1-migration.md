# Skins P1: migration brief (temporary; delete before merge)

Goal: every presentation value comes from one `MapStyle` built by
`mapStyle(skin, mode)` (web/src/lib/style/index.ts). **No visual change**: light and dark
screenshots stay pixel-identical, and the tooltip golden stays byte-identical.

Already done on `skins-p1-design` (commit e55a002): `lib/style/` (types, the paper skin,
encodings, `resolveMode`), `layers/flows.ts`, `layers/stations.ts`, `DeckHost.buildLayers`
(flows + stations), and bridge calls in `national/flows.ts` and `national/cities.ts`.
Read those diffs first; they show the pattern.

## Rules for every chunk

1. **Replace values with the field that holds the same value.** Each `MapStyle` field was built
   from the literal it replaces. Check the mapping in `lib/style/index.ts` (the `PAPER.build`
   body) before you swap a literal. If no field has the exact value, **stop and report**.
   Don't add a near match.
2. Forms: deck.gl props take `style.ink.X.rgba`. Canvas, SVG, HTML and inline styles take
   `style.ink.X.css`. If a colour needs a dynamic alpha, use `rgba(style.ink.X.css, alpha)`, the
   same call as today. Palette helpers (`flowColor`, `rampColor`) take `style.pal`.
3. Solid PathLayers: replace `capRounded: true, jointRounded: true` with `...style.line`.
   Dashed layers keep `capRounded: false` and take `jointRounded: style.line.jointRounded`, but
   only where they set `jointRounded: true` today. Don't add props a layer doesn't set today.
4. Where a function received `dark: boolean` only for looks, change the parameter to
   `style: MapStyle`. At the boundary that still holds the boolean (`P.current.dark`, React
   `dark` props, `TooltipInput.dark`), build the style with
   `mapStyle(DEFAULT_SKIN, modeOf(dark))`. Don't rename the React props or `MapCtx.dark` in P1.
5. updateTriggers or memo keys that held `dark` now hold `style.key` (a string) or the style
   object. The style is memoised, so identity is stable.
6. No `as any`. No new dependencies. Don't touch `pipeline/` or `web/public/assets`.
7. Run the gate after each chunk. Each chunk is one commit.

### Gate (every chunk)

```sh
cd web && npm run typecheck && npm run lint && bun test
```

lint must report 0 errors (9 pre-existing `exhaustive-deps` warnings are expected).

### Pixel gate (chunks A–D; once at the end is acceptable)

```sh
cd web && npm run build && cp -R dist /tmp/p1-new
# baseline = the same commands on branch `skins` into /tmp/p1-base
node tools/shots/shots.mjs /tmp/p1-base /tmp/sb-l --dpr 1 && node tools/shots/shots.mjs /tmp/p1-new /tmp/sn-l --dpr 1
node tools/shots/cmp.mjs /tmp/sb-l /tmp/sn-l            # must print 0 images over threshold
```

For dark, prefix both shots runs with `SHOTS_THEME=dark` (commit 64455d7 on `skins`), then compare the results with cmp.mjs. Light animation scenes (`anim-*`, `isolated-train-mid`) show 1–5 px run-to-run noise, so compare light with `--pixelmatch`. Dark must be exact.

---

## Chunk A: the remaining deck layers (backdrop, national, trains)

| file:line | before | after |
|---|---|---|
| `components/map/deck/layers/backdrop.ts:11` | `import { isFerrySection, paletteRGBA, splitFerry }` | `import { isFerrySection, splitFerry }` + `import type { MapStyle }` |
| `backdrop.ts:20` (BackdropInput) | `dark: boolean;` | `style: MapStyle;` |
| `backdrop.ts:108-112` | `const { …, dark, scale } = inp; const pal = paletteRGBA(dark); … const themeKey = dark ? "dark" : "light";` | `const { …, style, scale } = inp; const ink = style.ink; … const themeKey = style.key;` |
| `backdrop.ts` every `pal.X` | `pal.landFill`, `pal.outline`, `pal.graticule`, `pal.network`, `pal.ferry` | `ink.landFill.rgba`, `ink.outline.rgba`, `ink.graticule.rgba`, `ink.network.rgba`, `ink.ferry.rgba` |
| `backdrop.ts:132-133, 144-145, 187-188` | `capRounded: true, jointRounded: true,` | `...style.line,` |
| `DeckHost.ts:132` | `dark: P.current.dark,` (backdropLayers input) | `style,` (already in scope at :126) |
| `layers/national/index.ts` top of `nationalBuildLayers` | — | `const style = mapStyle(DEFAULT_SKIN, modeOf(P.current.dark));` |
| `national/index.ts:75` | `dark: P.current.dark,` (nationalFlowLayers input) | `style,` |
| `national/index.ts:89` | `nationalInfraLayers(atlas, view.counts, P.current.dark, flowAlpha)` | `nationalInfraLayers(atlas, view.counts, style, flowAlpha)` |
| `national/index.ts:101` | `nationalHighlight(…, st.fitScale, P.current.dark)` | `nationalHighlight(…, st.fitScale, style)` |
| `national/index.ts:102` | `nationalCityLayers(st.natCities, P.current.dark, …)` | `nationalCityLayers(st.natCities, style, …)` |
| `national/flows.ts:24` (NationalFlowsInput) | `dark: boolean;` | `style: MapStyle;` |
| `national/flows.ts:43,54,58` (dayMemo) | `dark: boolean` / `dayMemo.dark !== dark` / `dark,` | `style: MapStyle` / `dayMemo.style !== style` / `style,` |
| `national/flows.ts:50-51` | `…, dark, scale, …} = inp; const style = mapStyle(DEFAULT_SKIN, modeOf(dark));` | `…, style, scale, …} = inp;` |
| `national/flows.ts:84` | `nationalHighlight(…, fitScale: number, dark: boolean)` | `…, fitScale: number, style: MapStyle)` |
| `national/flows.ts:94-96` | `getColor: rgba(palette(dark).flowHi), capRounded: true, jointRounded: true,` | `getColor: style.ink.flowHi.rgba, ...style.line,` |
| `national/flows.ts:105,115` | `(…, dark: boolean, alpha = 1)` / `infraLayers(atlas.sec, passes, mapStyle(DEFAULT_SKIN, modeOf(dark)))` | `(…, style: MapStyle, alpha = 1)` / `infraLayers(atlas.sec, passes, style)` |
| `national/flows.ts:6` | imports `DEFAULT_SKIN, mapStyle, modeOf, palette` | drop all four, add `import type { MapStyle }` |
| `national/cities.ts:142-143` | `(d, dark: boolean, hoverIdx = -1) { const pal = palette(dark);` | `(d, style: MapStyle, hoverIdx = -1) {` |
| `national/cities.ts:156` | `rgba(pal.dot, dark ? 0.4 : 0.35)` | `rgba(style.ink.dot.css, style.alpha.natCityFill)` |
| `national/cities.ts:157, 198` | `rgba(pal.dotEdge)` | `style.ink.dotEdge.rgba` |
| `national/cities.ts:158` | `Math.min(dark ? 3 : 1.5, 0.3 * d.r[i])` | `Math.min(style.marker.edgeWidth, 0.3 * d.r[i])` |
| `national/cities.ts:160` | `getLineWidth: [d, dark]` | `getLineWidth: [d, style.key]` |
| `national/cities.ts:165` | `rippleRing(…, mapStyle(DEFAULT_SKIN, modeOf(dark)))` | `rippleRing(…, style)` |
| `national/cities.ts:197` | `rgba(pal.dot, 1)` | `rgba(style.ink.dot.css, 1)` (keep the `, 1`: identical cached tuple either way) |
| `national/cities.ts:7` | imports `DEFAULT_SKIN, mapStyle, modeOf, palette` | drop them; `import type { MapStyle }` |
| `national/trains.ts:163-164` | `capRounded: true, jointRounded: true,` | `...style.line,`. This needs a `style` argument on that corridor builder; pass it from `national/index.ts` (`nationalCorridor(tlAll.tl, atlas, iso.q, style)`) |
| `layers/trains.ts:20-22` | `const AMBER: RGBA = [245, 158, 11, 255]` / `CYAN [6,182,212,255]` / `SLATE [226,232,240,255]` | `const PAPER = mapStyle(DEFAULT_SKIN, "light").ink; const AMBER = PAPER.trainHs.rgba; const CYAN = PAPER.trainConv.rgba; const SLATE = PAPER.trainOther.rgba;` These colours don't depend on the mode. Threading a style through `glowOf` waits until a skin changes them (P3). |
| `trains.ts:164`, `national/trains.ts:129` | `[255, 255, 255, 255]` (plain train ring) | leave as is in P1 (`ink.trainCore.rgba` has the same value; it moves in P3 with glowOf) |

Tests to update: `tests/nationalLayers.test.ts:179,191` (`dark: false` → `style: mapStyle("paper", "light")`),
and any `nationalCityLayers` / `nationalHighlight` / `nationalInfraLayers` / `backdropLayers`
calls (`grep -rn "nationalCityLayers\|nationalHighlight\|nationalInfraLayers\|backdropLayers" tests`).

Verify: gate. Also check `grep -n "dark" web/src/components/map/deck/layers -r`. The only hits left should be in comments.

## Chunk B: lib/mapModel state carries the style (alphas, corridor colour, node size)

| file:line | before | after |
|---|---|---|
| `lib/mapModel.ts:38` (ModelState) | `dark: boolean;` | `style: MapStyle;` (import type from `./style`) |
| `mapModel.ts:224` | `export const isoFlowAlpha = (dark: boolean) => (dark ? 0.06 : 0.08);` | `export const isoFlowAlpha = (style: MapStyle) => style.alpha.isoFlow;` |
| `mapModel.ts:276` | `const ctxAlpha = s.dark ? 0.16 : 0.18;` | `const ctxAlpha = s.style.alpha.context;` |
| `mapModel.ts:282` | `isoFlowAlpha(s.dark)` | `isoFlowAlpha(s.style)` |
| `mapModel.ts:353` | `color: isHs ? "#F59E0B" : "#06B6D4"` | `color: isHs ? s.style.ink.trainHs.css : s.style.ink.trainConv.css` (flows.ts corridorLayers still does `rgba(corridor.color)`, which gives the same tuple) |
| `mapModel.ts:420` | `alpha: s.dark ? 0.08 : 0.1` | `alpha: s.style.alpha.isoInfra` |
| `mapModel.ts:422` | `alpha: s.dark ? 0.18 : 0.2` | `alpha: s.style.alpha.contextInfra` |
| `mapModel.ts:446` | `? s.dark ? 0.05 : 0.08` | `? s.style.alpha.isoChord` |
| `mapModel.ts:448` | `? s.dark ? 0.16 : 0.18` | `? s.style.alpha.context` |
| `mapModel.ts:757` (StationInput) | `dark: boolean;` | `style: MapStyle;` |
| `mapModel.ts:790` | `const dim = s.dark ? 0.16 : 0.18;` | `const dim = s.style.alpha.context;` |
| `mapModel.ts:830` | `const r0 = stationR(effectiveTrains);` | `const r0 = s.style.enc.nodeSize.radius(effectiveTrains);` |
| `mapModel.ts:773` comment | "0.16 / 0.18 (dark / light)" | "style.alpha.context" |
| `components/map/flows.ts:17` | `dark: P.current.dark,` | `style: mapStyle(DEFAULT_SKIN, modeOf(P.current.dark)),` |
| `deck/DeckHost.ts:151` (ms) | `dark: P.current.dark,` | `style,` |
| `deck/DeckHost.ts:180,190` | `const dark = P.current.dark;` … `dark,` (stationStates input) | delete the const; `style,` |
| `deck/layers/flows.ts` memoFlowPasses / memoInfraPasses keys | `ms.dark` | `ms.style` |
| `deck/layers/national/index.ts:61` | `isoFlowAlpha(P.current.dark)` | `isoFlowAlpha(style)` (after chunk A; otherwise build the style in place) |
| `components/map/interaction.ts:61` | `stationR(c.trains)` (twice) | `mapStyle(DEFAULT_SKIN, modeOf(P.current.dark)).enc.nodeSize.radius(c.trains)`. Hoist it to one `const size = …` above the loop. Confirm `P` is in scope there first. |

Check `lib/mapModel.ts` for a lib-internal import cycle: `./style` imports only `../palette`
and `./encodings`, so importing it from mapModel is safe.

Tests: `tests/mapModel.test.ts:32,49,80` and `tests/mapModelStations.test.ts:19,87`. Replace
`dark: false|true` / `dark` with `style: mapStyle("paper", dark ? "dark" : "light")` (or
`modeOf(dark)`). `tests/layers.test.ts` `st()` / `stIn()` also have `dark: false` → `style`.
Also check `grep -rn "isoFlowAlpha\|dark:" tests`.

Verify: gate. The expected alphas in the tests stay numerically the same. Don't edit the numbers.

## Chunk C: canvas, DOM and HTML consumers (labels, legend, cards, tooltip, timeline)

| file:line | before | after |
|---|---|---|
| `deck/labelsOverlay.ts:36-37` | `const dark = P.current.dark; const pal = palette(dark);` | `const style = mapStyle(DEFAULT_SKIN, modeOf(P.current.dark)); const ink = style.ink;` |
| `labelsOverlay.ts:16-20` fontOf | `"px Inter, -apple-system, …, sans-serif"` | pass the style: `fontOf(style, fs, weight)` → `weight + " " + fs + "px " + style.font.family`. This must equal the old string character for character; `style.font.family` is the same text |
| `labelsOverlay.ts:74,76,79` | `dark ? "#1A1B1E" : "#ffffff"` / `dark ? "#EDEDEA" : "#111111"` / `dark ? "#EDEDEA" : "#111111"` | `ink.labelBox.css` / `ink.labelBoxEdge.css` / `ink.labelBoxText.css` |
| `labelsOverlay.ts:81,83` | `pal.labelHalo`, `pal.label` | `ink.labelHalo.css`, `ink.label.css` |
| `labelsOverlay.ts:98` | `dark ? "#1A1B1E" : "#ffffff"` (origin diamond) | `ink.originMark.css` |
| `labelsOverlay.ts:63` | `natCityR(n * LABEL_TRAINS_PER_UNIT)` | `style.enc.natNodeSize.radius(n * LABEL_TRAINS_PER_UNIT)` |
| `labelsOverlay.ts:119` closeupLabels | `stationR(c.trains)` (twice) | pass `style` in; `style.enc.nodeSize.radius(c.trains)` |
| `labelsOverlay.ts:153,158,165` paintTag | `"bold 10px monospace"`, `"rgba(15, 23, 42, 0.90)"`, `"#FFFFFF"` | `"bold 10px " + style.font.tag`, `ink.tagPlate.css`, `ink.tagText.css` (pass the style down through drawTrainTags / drawNationalTags) |
| `components/Legend.tsx:16-…` LegendHandle.draw | `draw(pal: Palette, …)` | `draw(style: MapStyle, …)` |
| `Legend.tsx:134` | `rampColor(BAND_STOPS[i], pal)` | `rampColor(BAND_STOPS[i], style.pal)` |
| `Legend.tsx:156` | `flowColor(steps[i], steps[steps.length - 1], pal)` | `style.enc.lineColor.color({ n: steps[i], maxN: steps[steps.length - 1] }, style.pal)` |
| `Legend.tsx:96` rOf | `scaleRef.current.nat ? natCityR(n) : stationR(n)` | keep as is. rOf runs during render, where no style is available. Optionally switch to `NODE_SIZE.callsAtCity.radius` / `NODE_SIZE.directTrains.radius` (same functions). |
| `Legend.tsx:211,213` | `pal.infraHsr`, `pal.infraConv` | `style.ink.infraHsr.css`, `style.ink.infraConv.css` |
| `Legend.tsx:59` BAND_HEX (initial SVG stops, overwritten by draw) | literal array | `BAND_STOPS.map((m) => rampColor(m, LIGHT.pal))` with `const LIGHT = mapStyle(DEFAULT_SKIN, "light")`. This gives the same strings: `rgb(20,116,111)` replaces `#14746F`, and both have the same computed colour. If you want byte-identical SVG, keep the literal. |
| `Legend.tsx:61-63` band label inks | `"#ffffff"`, `"#111111"`, `"#ffffff"` | `LIGHT.ink.bandLabelOnDark.css`, `LIGHT.ink.bandLabelOnLight.css`, `LIGHT.ink.bandLabelOnDark.css` |
| `Legend.tsx:425-427, 433-435` class swatches | `"#F59E0B"`, `"#06B6D4"`, `"#ffffff"` | `LIGHT.ink.trainHs.css`, `LIGHT.ink.trainConv.css`, `LIGHT.ink.trainCore.css` |
| `Legend.tsx:464,484` initial infra strokes | `"#FF6A00"`, `"#111111"` | `LIGHT.ink.infraHsr.css`, `LIGHT.ink.infraConv.css` (draw() overwrites them per mode) |
| `Legend.tsx:70` FONT | `'Inter, …, "Segoe UI", …'` | keep as is (SVG attribute; same family list as `style.font.family` but with double quotes; don't change the bytes in P1) |
| `Legend.tsx:130,154` stale comments | "(the bands are identical in the light and dark schemes)" / "In the dark scheme flowColor is the flat flow colour" | correct them: the 12–24h band is periwinkle at night; both schemes have a flow ramp |
| `components/map/camera.ts:9,207` | `palette as makePalette` / `const pal = makePalette(P.current.dark);` … `draw(pal, …)` | `mapStyle, modeOf, DEFAULT_SKIN` / `const style = mapStyle(DEFAULT_SKIN, modeOf(P.current.dark));` … `draw(style, …)` |
| `components/MapCards.tsx:33-41` cardBand | `cardBand(mins, dark: boolean)` with the saffron pattern match | `export function cardBand(mins: number, style: MapStyle): string { return rampColor(mins, style.cardPal); }` |
| `App.tsx:137` | `cardBand(isolatedVM ? isolatedVM.dur : 0, dark)` | `cardBand(…, mapStyle(DEFAULT_SKIN, modeOf(dark)))` |
| `TrainScheduleModal.tsx:290` | `cardBand(trainVM ? trainVM.dur : 0, dark)` | `cardBand(…, mapStyle(DEFAULT_SKIN, modeOf(dark)))` |
| `lib/tooltip.ts:111` | `rampColor(fastest, palette(t.dark))` | `rampColor(fastest, mapStyle(DEFAULT_SKIN, modeOf(t.dark)).pal)` (import from `./style`, not `./index`) |
| `tooltip.ts:202` | `isHighSpeed ? "#F59E0B" : "#0284C7"` | `isHighSpeed ? ink.badgeHs.css : ink.badgeConv.css` |
| `tooltip.ts:218` | `color:#fff` | `color:${ink.badgeText.css}` |
| `tooltip.ts:223,226` | `color:#F59E0B` | `color:${ink.statusDwell.css}` |
| `tooltip.ts:225` | `color:#10B981` | `color:${ink.statusArrived.css}` |
| `tooltip.ts:229` | `color:#9CA3AF` | `color:${ink.statusMuted.css}` |
| `TimelineScrubber.tsx:151` | `dark ? "#E54035" : "#C8302A"` | `ink.rushPeak.css`, with `const ink = mapStyle(DEFAULT_SKIN, modeOf(dark)).ink;` at the top of that effect |
| `TimelineScrubber.tsx:154-155` | `"#10B981"` | `ink.rushDone.css` |
| `TimelineScrubber.tsx:166-167` | `dark ? "#6B7280" : "#9CA3AF"` | `ink.rushNight.css` |
| `TimelineScrubber.tsx:170-171` | `dark ? "#F59E0B" : "#D97706"` | `ink.rushTail.css` |
| `TimelineScrubber.tsx:174-175` | `dark ? "#4B5563" : "#6B7280"` | `ink.rushRegular.css` |

The tooltip strings are compared byte for byte against `tests/tooltip.golden.json`. Every ink
used there has exactly the literal's spelling (`#fff`, not `#ffffff`). Don't regenerate the golden.

Tests: `tests/mapCards.test.tsx` (cardBand callers, if any), plus the Legend draw callers
(`grep -rn "cardBand\|\.draw(" tests`).

Verify: gate, plus `bun test tests/tooltip.test.ts` (golden unchanged: `git diff --exit-code web/tests/tooltip.golden.json`).

## Chunk D: CSS tokens (no TypeScript)

Rule: **the computed colour of every element stays the same.** Move each literal into a
custom property with the same value, then use `var(--x)` at the old site. Don't round values,
don't convert `#fff` to `#ffffff`, and don't merge two tokens whose values differ.

1. `web/src/styles/theme.css` holds the tokens three times: `:root, :root[data-theme="light"]`
   (1-30), `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) … }` (31-61), and
   `:root[data-theme="dark"]` (62-90). The two dark blocks are identical (check with `diff`).
   The media block applies only when `data-theme` is missing. The pre-paint script in
   `web/index.template.html:33-41` always sets the attribute, except when
   `sessionStorage.getItem` throws inside its single `try`.
   - Fold: delete the media block. Then make the pre-paint script always set the attribute. Read
     storage in its own inner `try`, so a throwing `sessionStorage` falls through to the
     `matchMedia` check (the same order as `useUrlState.initialDark`, `hooks/useUrlState.ts:68-85`).
   - CSP: `bundle.mjs:186-195` hashes the inline scripts at build time, so editing the script is
     fine. Don't add a third inline script (the build expects exactly 2).
   - Do the same for `web/src/styles/map.css:209-211`: `.lg-band-label`'s duplicated dark rule.
2. `modal.css` already uses `--tsm-*` tokens in two blocks. Move the remaining literals into tokens
   on `.tsm-backdrop` / its dark block: `:68-69` (`#0284C7`, `#FFFFFF`), `:76` (`#F59E0B`), `:150`
   (`#fff`), `:234` (`rgba(200, 48, 42, 0.12)`, dark only). List the rest with
   `grep -nE "#[0-9A-Fa-f]{3,6}\b|rgba?\(" web/src/styles/modal.css | awk -F: '$1>50'`.
3. `timeline.css` uses `--tl-*` tokens. Move the literals outside the two token blocks onto `--tl-*`
   (for example `:65` `#F4F4F0`, `:96-97` `#C8302A`, `:47,89` shadows). Same grep with `$1>38`.
4. `departures.css:166,171,179,287-292` (`#ffffff`, `rgba(0,0,0,0.22)`, `rgba(128,128,128,0.25)`,
   `#2563EB`, `#FFFFFF`, `#1D4ED8`): add `--dep-*` tokens on the `.dep-chip` scope, or on `:root` in theme.css
   if both modes use the value.
5. Any token that is the same in both modes is declared once in the light/`:root` block.

Verify: gate, `npm run build`, then the pixel gate in light **and** dark. This chunk touches all
of the UI chrome, so run the full 14-scenario shots (`--dpr 1,2`) in both modes.

## Chunk E: audit and close-out

1. `grep -rnE "\bdark \?|palette\(|paletteRGBA\(" web/src | grep -v "lib/style\|lib/palette"` must
   find nothing except `hooks/useUrlState.ts` and `Toolbar.tsx` (the theme selection itself)
   and the `dark` React props.
2. `grep -rnE "#[0-9A-Fa-f]{3,6}\b" web/src --include=*.ts --include=*.tsx | grep -v "lib/style\|lib/palette"`
   must find only `Histograms.tsx` (UI chrome, out of P1 scope) and comments.
3. If `paletteRGBA` has no callers left outside tests, keep it anyway: `tests/style.test.ts` and
   `tests/palette.test.ts` use it as the independent reference for the inks. Removing it is a
   P2 decision.
4. Full pixel gate, light and dark, DPR 1 and 2. Paste the cmp summaries into the PR body.

## Later (not P1): where the seam goes next

- Skin selection: `useUrlState` gains `skin` (URL `?skin=` + storage, like the theme). Use
  `resolveMode(skin, requested)` for the mode. When `!skinHasModeToggle(skin)`, hide or disable
  the Toolbar day/night pair (`Toolbar.tsx:267-292`). `data-theme` takes the resolved mode, and a
  new `data-skin` attribute selects the CSS tokens. The pre-paint script must resolve the mode
  the same way. The terminal skin is dark-only: `modes: ["dark"], defaultMode: "dark"`.
- `MapCtx` / `P.current` carry `style` instead of `dark`. Then every `mapStyle(DEFAULT_SKIN,
  modeOf(…))` bridge above collapses to `P.current.style`.
- P2 encodings: `LineColorEncoding.by` gains `"section"`, and `LineFact` gains `s` plus a speed
  column. buildPassData then memoises colours per section instead of per count when
  `by === "section"`.
