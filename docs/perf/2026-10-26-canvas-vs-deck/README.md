# Canvas vs deck.gl benchmark, 2026-10-26

**Status:** historical snapshot (2026-10-26, before the deck.gl merge). The Canvas renderer it compares against has since been removed; the raw files are kept as the evidence behind `docs/history/AUDIT_PRE_MAIN.md` §4.

Raw results behind `docs/history/AUDIT_PRE_MAIN.md` §4. Everything here was produced by
`web/tools/perf/compare.mjs` (PR #88) on the same machine in one sitting; the tables in the
report are `node web/tools/perf/summarize.mjs docs/perf/2026-10-26-canvas-vs-deck` over these files.

## Builds

| label | tree | notes |
|---|---|---|
| `canvas` | `origin/main` @ `cecf4d2` (Canvas 2D renderer, 12306 pack, 7,157 trains) | built with `bun install && bun run build` in a detached worktree; one local, uncommitted patch added the two measurement hooks the harness needs (`window.__M`, `window.__draw` in `web/src/components/MapCanvas.tsx`, identical to what `deckgl` exposes). Nothing else differs from `main`. |
| `deck` | `origin/deckgl` @ `4c2dde4` (deck.gl 9.4.0, 11k train-export pack, 11,248 trains) | `web/dist` of that head |

Both builds are served by `web/tools/serve.mjs` from the `deckgl` tree (ETag/304, brotli for
JS/HTML/CSS, pre-compressed `.json.br` packs with `Content-Encoding: br`, the `vercel.json` headers).

The two packs differ (7,157 vs 11,248 trains, 7,922 vs 9,106 sections), so the comparison is
"the site as deployed today" vs "the site as it will be deployed", not renderer vs renderer on
identical data. Where that matters (origin switch, heap, load) the report says so.

## Machine and browser

Apple M4 Max, 36 GB, macOS 26.6.2; Google Chrome 155.0.8059.85 (headless new, real GPU:
`ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max)`; the harness refuses SwiftShader); node
22.23.0. The machine was shared with other agents during the run (load average 3–5, printed per
run in the JSON `machine.loadavg`). rAF intervals degrade under contention while draw time does
not (migration plan §11.2 G8), so draw+raster p95 is the primary figure and rAF p95 the
supporting one.

## Scenarios

Viewport 1280×800, `?theme=light`, DPR 1 and 2, CPU throttle 1× and 4×
(`Emulation.setCPUThrottlingRate`), 3 repetitions each in fresh browser contexts.

- `origin-initial`: 广州, the opening camera (Guangzhou fit), animation enabled and paused,
  `animTime` swept 360 → 1440 over 300 rAF frames (3.6 min per frame, the `origin.mjs` sweep).
- `city-x10`: `panZoomTo(113.26, 23.13, fitScale × 10)`, same sweep.
- `anim-peak`: opening camera, sweep 1035 → 1155 (0.4 min per frame around the 18:15 peak).
- `switch`: `__selectOrigin` 北京 → 上海 → 广州 from the national fit; Long Tasks and rAF gaps
  in the 2 s after each call.
- national (deck only): `?national=1`, the 24h bar expanded (the dots exist only then), paused,
  sweep 1095 → 1155 (0.2 min per frame, the `national.mjs` sweep) on the opening camera, the
  national fit and city ×10; `trains` = A (`&natLayer=none` today; it was `&natLayer=trains` when measured), `both` = A+B (default).
- `load`: a fresh context, navigate, record FCP, "map ready" (`__mapApi` and `__M` present,
  `#loading` gone; on deck this is after the lazy chunk mounted), the first deck frame, bytes
  before ready and total (Resource Timing `transferSize`), then a warm reload in the same context.
  On localhost, and under Lighthouse's mobile network preset (1.6 Mbps down, 150 ms RTT,
  `--net slow4g`).

Per frame the harness calls `window.__mapApi.setTime(t)` (a synchronous draw in both renderers)
and, in the second pass of each sweep, forces the raster with `gl.readPixels(1×1)` on deck or
`ctx.getImageData(1×1)` on Canvas ("draw+raster"). After each sweep: `HeapProfiler.collectGarbage`
then `Performance.getMetrics` (`JSHeapUsedSize`), the DOM canvases' backing-store bytes
(`width × height × 4`; the Canvas renderer also keeps an offscreen backdrop cache of the same
size that is not in the DOM), and on deck `deck.metrics` before and after one `pickRect`
(the picking framebuffer is allocated on the first pick, the migration plan's M4 rule).

## Files

- `canvas-frames.json`, `deck-frames.json`: origin-view sweeps and switches.
- `deck-national-trains.json` (A), `deck-national-both.json` (A+B).
- `canvas-load-localhost.json`, `deck-load-localhost.json`, `canvas-load-slow4g.json`, `deck-load-slow4g.json`.

Each file: `rows[]` (one per sweep: `rafIntervalMs`, `drawJsMs`, `drawPlusRasterMs` as
mean/p50/p95/max, `droppedPct` (> 20 ms), `memory`, `deckMetrics`, `camera`, `zoomRatio`,
`natDots`, `natFlows`) or per switch (`switches[]`), `loads[]` (cold/warm), `machine`, `browser`.
In these files the scenario name was overwritten by the camera object (a bug fixed in the
audit PR); `summarize.mjs` recovers it from `zoomRatio` and `sweep`.

## Reproduce

```bash
cd web && bun install && bun run build
node tools/perf/compare.mjs dist --label deck --reps 3 --dpr 1,2 --throttle 1,4 --out out/deck-frames.json
node tools/perf/compare.mjs dist --label deck --national both --reps 3 --out out/deck-national-both.json
node tools/perf/compare.mjs dist --label deck --scenarios load --net slow4g --dpr 1 --out out/deck-load-slow4g.json
# a Canvas baseline needs a main checkout with the two hooks patched in (see "Builds")
node tools/perf/summarize.mjs out
```
