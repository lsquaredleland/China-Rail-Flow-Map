# Pre-main audit of `deckgl` (2026-10-26)

## Status after follow-ups (updated 2026-10-26)

The findings below (§0–§12) are the historical record and are not edited. ✅ merged into
`deckgl`, ⏳ in progress, ❌ open.

| Item | Status |
|---|---|
| **§0 top actions** | |
| 1. Merge with `--no-ff` (Vercel ignore rule) | ✅ merge commit, PR #139 (2026-10-27) |
| 2. Route-change review (8 rows) | ✅ owner accepted the shipped pack as is (2026-10-26) |
| 3. Surface a failed national index load | ✅ #127 |
| 4. ABOUT window from the pack | ✅ #109, pack swap #116 |
| 5. Decide the trials | ✅ Zoom clarity kept as a parameter #107; `NatLayer` simplified #111 |
| 6. Phone: cap the card column | ✅ superseded by the mobile redesign (#133, collapsed KEY legend, stacked bottom row) |
| 7. Accessibility | ✅ #128 (the animation live-region announcer is being removed at the owner's request) |
| 8. Tests and flake | ✅ #106, #108, #117, #118 |
| 9. Maintainability | ✅ see §1 |
| 10. Hygiene | ✅ mostly, see §9 |
| **§1 Code structure** | |
| S1 `useNationalMode` out of `App` | ✅ #112 |
| S2 national builder out of `DeckHost` | ✅ #102 |
| S3 `layers/national/{timeline,trains,flows,cities,index}.ts` | ✅ #102 |
| S4 timetable modal unroll, `lib/tripStatus` | ✅ #103 |
| S5 `Histograms` takes rows | ✅ #110 |
| S6 `MapCanvas` → `MapHost` | ✅ #119 |
| S7 `atlas.rs` `main()` split (byte-identical pack) | ✅ #100 |
| S8 `audit.rs` split (identical output) | ✅ #104 |
| §1.2 unused exports | ✅ #123 |
| §1.3 stale comments, `NatData` move | ✅ #96 |
| §1.4 trials | ✅ #107, #111 |
| §1.5 one `stationName` / `fmtDurationWords`; one dot/ring builder | ✅ #101, #105 |
| §1.6 caller-side logging | ✅ #98 |
| **§2 Component reuse** | |
| R3 one `DestinationPanel` | ✅ #113 |
| R4 windowed origin tables | ✅ #121 |
| R5 one `Histograms` input | ✅ #110 |
| R10 `dotLayers` / `ringLayer` | ✅ #105 |
| R12 `LabelPoint` | ✅ #105 |
| **§3 Merge readiness** | ✅ fast-forward, no conflicts; only the `--no-ff` note remains |
| **§4 Performance report** | ✅ this document, `docs/perf/2026-10-26-canvas-vs-deck/` |
| **§5 Unused files, stale docs** | ✅ #89, #90, #91 |
| **§6 Tests / CI** | ✅ #106, #108, #117, #118 |
| **§7 Accessibility and mobile** | ✅ #128; mobile redesign #133, #134 and direct pushes |
| **§8 Docs** | ✅ #99, #115 |
| **§9 Hygiene** | ✅ 38 merged branches deleted, spikes kept as tags `spike/deckgl-f04acf8` and `spike/national-anim-600b3de`, stale worktrees removed, root `vercel.json` removed #95; `exp/canonical-production-geometry` and `backup/handoff-local-main-3484031` deleted (owner, 2026-10-26) |
| **§10 Upstream data note** | ✅ recorded as a known property of the export, not necessarily a bug (owner): the stop lists of discovered trains are empty in `trains-all.json` and come from `train-operating-days.json` |
| **§11 Before merge** | ✅ 11.1 security headers #93 (no CSP and fonts not self-hosted, owner: no); ✅ 11.2 index-failure notice #127; ✅ 11.5 provenance #109/#116; ✅ 11.8–11.9 pinning and `engines` #94 |

Other changes since the audit: footer style and the 21/28 Oct copy #97, swipe hint only on
overflow #114, docs refreshed #115/#120, faster CI (path filters, split and parallel layout
check) #124/#130/#135, departures table columns #131/#132, mobile redesign #133 and desktop
layers popover #134, plus direct pushes for small mobile tweaks (title, station list, class
button, top bar, 36px controls, city list, default phone view). Vercel: only `main` and
`deckgl` deploy (`git.deploymentEnabled`), and `deckgl` only on a `[deploy]` commit.


Audit of the long-lived integration branch `deckgl` before it merges into `main`. Read-only
review of the tree at `4c2dde4` (merge of PR #87) plus four cleanup PRs merged during the audit
(#88–#91, table in §12); every claim is tied to a file and line on that tree. Owner rules
honoured: nothing touched `main`, `web/public/assets`, `data/` or `output/`; no external rail
API was queried; the pack is unchanged. Perf numbers are measured (§4, raw data in
`docs/perf/2026-10-26-canvas-vs-deck/`); everything else is read from the code, the docs, the
GitHub state and the committed pack.

Severity scale: **blocker** (do not merge), **should-fix** (land with or right after the
merge), **nice-to-have**.

---

## 0. Executive summary

**Merge-ready: yes.** No blocker was found. `main` has not moved since `deckgl` branched
(`git log origin/main ^origin/deckgl` is empty; `cecf4d2` is the merge base and `main`'s head),
so the merge is a fast-forward with no conflicts. Typecheck, build, 266 `bun test`s, the
headless WebGL smoke and `cargo fmt/clippy/test` are green on the final head. The renderer
switch is justified by the numbers in §4: deck.gl's frame cost stays flat where Canvas's grows
with pixels and strokes (DPR 2 under a 4× CPU throttle at the 18:15 peak: Canvas draw+raster
p95 36.5 ms and 100 % of frames dropped, i.e. 20 fps; deck 12.4 ms with a third of frames at
the 2-vsync mark, i.e. ≥ 30 fps), and national mode, 3,600 dots over 9,000 lit sections, holds
60 fps unthrottled and sits on the 16.7 ms line at 4×. Where Canvas was better (origin-switch stall, JS heap, bundle,
first-frame latency on a slow network) is stated in §4.5.

**Top 10 actions, ranked**

1. **Merge with a merge commit, or fix the Vercel ignore rule first** (should-fix, at merge).
   `web/vercel.json:6` builds `main` only when `git diff --quiet HEAD^ HEAD -- .` finds a
   change under `web/`. A fast-forward makes `HEAD^` the previous `deckgl` merge, so if the
   last commit on `deckgl` is docs-only (the audit PR is), `main` will not redeploy and the
   live site stays on Canvas. `git merge --no-ff origin/deckgl` compares against old `main`
   and builds; or change the rule to `$VERCEL_GIT_PREVIOUS_SHA`. §3.3.
2. **Owner review of six route changes in the shipped 11k pack** (data; should-fix):
   温州–缙云 +60 km on 金温货线 ("looks wrong" in the staging report), 丽水/青田–温州 moved onto the
   freight 金温货线, C562/C556 昆明–昆阳 via 中老昆万线, 怀化–鹰潭 +34 km, 济南西↔济南东 picking
   opposite corridors per direction, and the 沧州–天津 near-tie (7 K trains, +12.5 km). These are
   facts on the live map after the merge. §3.5.
3. **Surface a failed national index load** (should-fix). `useAtlasData` sets
   `nationalIndexFailed` (`web/src/hooks/useAtlasData.ts:81,266`) but `App.tsx:92` never reads it:
   the hour / distance / duration / train filters silently stop answering and the national
   histograms stay empty. Show the notice the flows get (`App.tsx:226-232`). §11.2.
4. **Derive the schedule window in `data.ts` `ABOUT` from the pack** (should-fix).
   `web/src/data.ts:60-65` hard-codes "23 October to 6 November 2026"; `shared.calendar` and
   `fmtCalendarSpan` already exist (`App.tsx` computed it and threw it away, PR #91). The next
   pack swap would ship a wrong sentence; the pipeline owns this fact. §11.5.
5. **Decide the two leftover trials** (owner): the Zoom-clarity toggle
   (`web/src/lib/palette.ts:108-127`, a `globalThis` switch because the deck chunk duplicates
   the module) and the `?natLayer=both|trains|none` back-compat with the four-state `NatLayer`
   type (`web/src/types.ts:572`). Keep-or-drop options with line ranges in §1.4.
6. **Phone layout: cap the card column** (should-fix). On a ≤640 px map the expanded city panel
   sits in the top-right card column (`web/src/styles/cards.css:119-148`), which may grow to the
   map's full height and cover the 24h button (bottom 66–110 px), legend toggle and scale bar
   (bottom 10 px) on short viewports. Reserve the bottom 130 px and let the panel scroll
   (`overflow-y: auto` is already set); add a 390×664 case to `tools/cards-layout.mjs`. §7.3.
7. **Accessibility of the new surfaces** (should-fix): the timetable's clickable rows are not
   keyboard-operable (`TrainScheduleModal.tsx:597-612`), the `aria-live` "now" block
   (`:543`) re-announces every frame while the clock plays, and the non-modal map cards declare
   `role="dialog"` (`MapCards.tsx:71,150`). §7.1–7.2.
8. **Tests and flake** (should-fix): no tests for `Histograms` (912 lines), `DeparturesTable`'s
   modes, `TimelineScrubber`, `DestinationPanel`, `useAtlasData`'s failure flags or `App`'s
   origin-reset; `shots.mjs` never awaits `document.fonts.ready`, the likely cause of the one-off
   `labels-on@1x` / `national-fit` flakes; `cards-layout.mjs` is not in CI. §6.
9. **Maintainability** (nice-to-have, no behaviour change): `pipeline/analyze/src/bin/atlas.rs`
   `main()` is 1,958 lines (`:722-2679`) with 19 phase comments; `DeckHost.buildLayers`
   carries an 88-line national branch (`:151-238`); `App.tsx` holds the national mode's state
   and five effects (`:41-48,131-136,150-154,184-232`). Split per §1.1/§1.5, proven by the
   existing tests and a byte-identical pack.
10. **Hygiene** (nice-to-have): 33 merged remote branches, two spike branches to tag-and-delete,
    `exp/canonical-production-geometry` and the two `backup/*` to decide, 9 stale agent worktrees
    and 4 scratch worktrees to remove; the root `vercel.json` has drifted from `web/vercel.json`;
    send the upstream note on the 4,303 placeholder stop lists (§10). §9.

---

## 1. Code structure, readability, maintainability

### 1.1 Module boundaries (web)

The target layout of `docs/history/DECKGL_MIGRATION.md` §1.1 is what shipped: `web/src/lib/` (21
modules, 4.9k lines) is pure and bun-tested; `components/map/` (7 modules, 1.2k lines) and
`components/map/deck/` (9 modules, 2.9k lines) are the engine and the lazy renderer; `components/map/` holds the renderer-agnostic
engine (`context.ts`, `anim.ts`, `api.ts`, `camera.ts`, `pointer.ts`, `interaction.ts`);
`components/map/deck/` is the lazy chunk (`DeckHost.ts`, `TailLayer.ts`, `labelsOverlay.ts`,
`layers/{backdrop,flows,stations,trains,national}.ts`), imperative and React-free as C23
requires (`bundle.mjs:58-64` enforces it). `lib/` never imports deck; the deck layers import
only `lib/` and `types`. The seam `MapApi`/`MapCtx` (`components/map/context.ts:46-61,201-235`)
is unchanged in shape from `main`. This is a clean boundary and the main reason the Canvas →
deck swap landed with 28 zero-diff screenshots.

Findings:

| # | Finding | Where | Severity | Recommendation |
|---|---|---|---|---|
| S1 | `App.tsx` (581 lines) owns the national mode's state machine: flows toggle, drawn-layer derivation, city card, train lookup, five `useEffect`s that fetch files | `web/src/App.tsx:41-48,131-136,150-154,184-232` | nice-to-have | Extract `hooks/useNationalMode.ts` returning `{natFlowsOn, toggle, natLayerDrawn, natCity, setNatCity, natLoadError, nationalTrainT}`; `App` keeps composition only. Pure move, covered by `natDefaults`, `nationalTrain`, `toolbarPanels` tests. |
| S2 | `DeckHost.buildLayers` is 180 lines with an 88-line national branch that also mutates engine state (`st.natCities`, `st.natCounts`, `st.natPick`, `st.natN`) | `web/src/components/map/deck/DeckHost.ts:139-318` (national `:151-238`) | should-fix (maintainability) | Move the branch to `layers/national.ts` as `nationalBuildLayers(M, stats): Layer[]`; `buildLayers` becomes backdrop + `P.current.national ? national : origin`. |
| S3 | `layers/national.ts` (720 lines) mixes four concerns and seven module-level memo singletons (`built`, `viewMemo`, `keepMemo`, `isoMemo`, `dayMemo`, `atMemo`, plus three `WeakMap`s) | `web/src/components/map/deck/layers/national.ts:114-128,149-175,371,450-451,535,547,613,641` | nice-to-have | Split into `national/{timeline,trains,flows,cities}.ts`; keep the memos but name the invalidation key of each in one comment block. |
| S4 | `TrainScheduleModal.tsx` (700 lines) renders both the dialog and the minimised card and computes the national `trainVM` by unrolling the stops once (`:113-141`) and `alignedStops` by unrolling them again (`:170-202`) | `web/src/components/TrainScheduleModal.tsx` | nice-to-have | Compute the unrolled stops once; move the status machine (`currentStatus`, `:246-311`) to `lib/` and test it. |
| S5 | `Histograms.tsx` (912 lines, the largest file) accepts either `cur` or `rows` and derives rows inside | `web/src/components/Histograms.tsx:17-20,339-371` | nice-to-have | Take `rows: HistRow[]` only; `DeparturesTable` already has both derivations (§2.3). |
| S6 | `MapCanvas.tsx` no longer hosts a Canvas renderer: it mounts the deck chunk and owns the overlay canvas and the pointer target | `web/src/components/MapCanvas.tsx:34-38` | nice-to-have | Rename to `MapHost.tsx` (imports in `App.tsx`, 4 components, 3 tests); or leave and keep the header comment, which is accurate. |
| S7 | `atlas.rs` `main()` is one 1,958-line function with 19 `// ---- phase ----` comments | `pipeline/analyze/src/bin/atlas.rs:722-2679` | should-fix (maintainability) | One function per phase comment, state passed explicitly; prove with a byte-identical pack (`cmp` the `.br` files; the build is deterministic since O17/O18). Needs the OSM extract, so it is a pipeline task, not a web PR. |
| S8 | `audit.rs` (2,304 lines) is five 150–300-line `audit_national_*` functions plus `audit_pack` (480 lines) | `pipeline/analyze/src/bin/audit.rs:123,600,724,910,993,1252` | nice-to-have | Acceptable for an audit binary; the review-era duplication with `atlas.rs` is gone (262 identical lines, only `main` shared by name; `analyze/src/*.rs` holds the shared code with tests). |
| S9 | `router` crate: 17 modules behind `lib.rs` with a README mapping the seams (schedule, stations, baseline, graph) | `pipeline/router/src/lib.rs` | — | Good; matches the "router extensible + modular" rule. |

### 1.2 Dead code and unused exports

A scan of every `export` in `web/src` for references outside its file found 3 symbols used
nowhere (`stationName`, `prepOrigin`, type `PaletteRGBA`; removed in PR #89 with the
unreferenced `web/icon.webp`), 2 unused locals (`App.tsx` `calendarSpan`, `Footnote`'s ignored
props; PR #91), and ~90 symbols used only inside their own module that carry an unneeded
`export`, 36 of them also re-exported from `lib/index.ts` with no consumer. The re-exports are
API surface, not bugs; trimming them is a one-line-each change that `tsc` and `bun test` prove.
The list (`export-only`): `lib/index.ts` re-exports of `isWaterCross`, `rowTrainIdx`,
`STATION_R_MAX/MIN`, `ChordPlan`, `IsolatedCorridor`, `computeAllowedTrainCodes`,
`computeCityAllowedArrivalTimes`, `computeDestWindow`, `flowsOf`, `isolatedTrain`,
`NAT_{DIST,DUR,HOUR}_BINS`, `ViewState`, `FerryPiece`, `LabelOptions`, `LabelStyle`, `Measure`,
`PlacedLabel`, `PickKind`, `PickLine`, `PickOptions`, `PickView`, `SEG_TIE_PX`, `RunDays`,
`callArrMins`, `TooltipInput`; module-local exports in `camera.ts` (`fitGuangzhouInitialCalc`,
`reportViewChange`, `scheduleViewReport`), `flows.ts` (`chordLayers`, `corridorLayers`,
`highlightLayers`, `memoFlowPasses`, `memoInfraPasses`, `INFRA_WIDTH`, `PICK_WIDTH`),
`Histograms.tsx` (`Chart`, `PAD_L`, `PLOT_W`), `useUrlState.ts` (`initialDark`,
`initialDistUnit`, `initialInfra`, `parseInitialCamera`), `pick.ts` (`ORIGIN_RADIUS`,
`SEG_RADIUS`, `STATION_RADIUS`), `data.ts` (`OUT_MAP_URL`), `staleReload.ts` (`RELOAD_KEY`),
`storage.ts` (`SafeStorage`), `types.ts` (13 `Raw*` / `*Origin` types), and the deck layer
input/record types. Nice-to-have.

Unused state: `nationalIndexFailed` (destructured, never read, `App.tsx:92`) is a bug, not
dead code (top action 3).

### 1.3 Comments and naming

Accurate where it matters: every deck layer file states its Canvas counterpart and the C-rule
it implements (`flows.ts:1-12`, `stations.ts:1-10`, `trains.ts:1-13`, `DeckHost.ts:1-11`);
`mapModel.ts`/`timeline.ts` document the rules the tests pin. Stale comments found and fixed in
PR #90/#91: the migration doc's status header ("P1b.1 is the next task"), `Footnote.tsx`'s
dashed-leg note, `tools/perf/national.mjs`'s header. Still stale: `web/src/lib/national.ts:32`
says `buildNational` accepts out-tables shapes (true but no caller does since P2.2);
`types.ts:570-572` describes `NatLayer` as "what national mode draws" while the URL param only
toggles the flows (`useUrlState.ts:48-50` explains the real contract). Naming is consistent
(`nat*` for national-mode values, `*VM` view-models, `ensure*` lazy loaders) except
`MapCanvas` (S6) and `DepCtx`/`ModeView` living in `departures/types.ts` while `NatData` lives
in `natTrains.tsx:11-22`.

### 1.4 Leftover feature flags and trials

**`?natLayer=both|trains|none`.** Since PR #80 the national view opens with the flows alone and
the trains appear when the shared 24h bar is expanded; the URL param only sets the Flows toggle
(`useUrlState.ts:51-68` accepts the four legacy values, `App.tsx:45-48` reduces them to a
boolean, `writeNatLayerParam` writes `none`/`flows` only). The four-state `NatLayer`
(`types.ts:572`) survives as the *derived* mode passed to the renderer (`App.tsx:224`,
`context.ts:91`, `DeckHost.ts:155-157,179,204`). Options:
- *Keep* (zero work): a derived enum is a fair internal contract; keep `natDefaults.test.ts`
  pinning the back-compat. Rename the doc comment on `types.ts:570-572` to say "derived".
- *Simplify* (~40 lines, 6 files): replace `NatLayer` by `{flows: boolean; trains: boolean}` in
  `Props`/`DeckHost`, drop `both`/`trains` from the URL parser and the test's back-compat case.
  Behaviour change only for old links carrying `natLayer=both|trains` (they would open with the
  flows on and the bar collapsed, like any other link).

**"Zoom clarity".** *Resolved: dropped (owner decision) -- the button, state, `zoomWidthScale` / `ZOOM_WIDTH_KNEE`, the `damped` parameters and `zoomWidth.test.ts` are gone; widths are the pre-trial widths.* Historical description: a toolbar toggle (`Toolbar.tsx:226-234`), state in `App.tsx:51-52` and
`MapCanvas.tsx:251-255`, the maths in `palette.ts:108-127`, consumed by `flows.ts:296,348,516`
and `Legend.tsx:129`, tested by `zoomWidth.test.ts`. The switch is a `globalThis` flag because
the lazy chunk carries its own copy of `palette.ts` (the comment at `palette.ts:111-112` says
so). Options:
- *Keep*: remove the side channel by threading `P.current.zoomClarity` (already in
  `context.ts:78`) into `zoomWidthScale(r, damped)` from the three layer call sites and the
  Legend's `frameTail`; delete `setZoomWidthDamped` and the `MapCanvas` effect. ~25 lines, no
  visual change when the toggle is off (the default).
- *Drop*: delete the block, the two exports, the button, the state, the effect, the
  `ZOOM_WIDTH_KNEE` test. ~45 lines across 7 files; screenshots unchanged (default off).

Other switches are dev-only and documented: `?gputime=1` (`DeckHost.ts:127`), `?natSynth=N`
(`national.ts:114`), `?fps=1` (`lib/fpsMeter.ts`), the `window.__*` test handles
(`App.tsx:243-253`, `MapCanvas.tsx:87-91`, `DeckHost.ts:335,425,510`).

### 1.5 Duplicated logic

| What | Where | Recommendation |
|---|---|---|
| Four station-name formatters: `cardStName` (zh then en), `fmtShort` (en then zh), `fmtStName` (zh (en)), `nameOf` (en zh) | `MapCards.tsx:44`, `TrainScheduleModal.tsx:43,47,435` | One `stationName(zh, en, order)` in `lib/format.ts`; the three orders are a design choice to record, not a bug. |
| Duration text: `durText` ("1 h 5 min") vs `fmtTime` ("1:05") | `TrainScheduleModal.tsx:436-439`, `lib/format.ts:67` | Move `durText` to `lib/format.ts` as `fmtDurationWords`. |
| Train ring layers: origin `trainLayers` rings vs `nationalRings` build the same `ScatterplotLayer<Disc>` | `layers/trains.ts:148-157,233-244`, `layers/national.ts:321-365` | One `ringLayer(id, discs, trigger)` in `trains.ts` (§2.2). |
| Dot/tail/dwell layers: `trainLayers` vs `nationalLayers` are the same three layers over different buffers | `layers/trains.ts:183-245`, `layers/national.ts:263-316` | One `dotLayers(prefix, buffers, {pickable, isolated})` over a shared buffer type (§2.2). |
| `Histograms` derives rows from `cur` while `DeparturesTable` also derives per mode | `Histograms.tsx:339-371`, `DeparturesTable.tsx:419-458` | §2.3. |
| Name-match predicate for the origin stop repeated twice | `TrainScheduleModal.tsx:158-164,207-213` | One `matchesOrigin(s)` closure. |

### 1.6 Consistency of patterns

Consistent: imperative engine with `P`/`S` refs, per-frame pooled typed arrays
(`trains.ts:88-102`, `national.ts:194-217`), identity-keyed `WeakMap` caches, `requireX`
format guards that throw `FmtError`, `ensureX` lazy loaders with in-flight marks
(`useAtlasData.ts:109`), and `updateTriggers` carrying `dark` everywhere (§11.5 of the plan).
Inconsistent: the deck host reaches into deck's private surface in three places
(`deckPicker._resizeBuffer`, `layerManager.getLayers`, `_updateCanvasSize`;
`DeckHost.ts:80-121,322-332,493`), pinned by `tests/deckPickerContract.test.ts` and a
`console.warn` fallback; an upgrade past 9.4.0 is a deliberate PR (R1 in the plan). The `lib`
`require*` guards `console.error` before throwing, so the negative test prints a scary line
in every `bun test` run (`national.test.ts:88`); nice-to-have: let the caller log.

---

## 2. Component reuse: national mode vs origin view

Rule under test: national mode must reuse the origin view's components (one component tree
fed origin or national data). Inventory of every national-specific branch:

| # | Branch | Where | Verdict | Proposed shared API when "should-merge" |
|---|---|---|---|---|
| R1 | Header mode switch and national stat row | `AppHeader.tsx:56-74,87-101` | justified | One component, two stat sets; fine. |
| R2 | Toolbar hides the origin picker / direction / close-up, shows the Flows toggle | `Toolbar.tsx:77-106,179-187,207-217` | justified | Controls differ by mode; one component. |
| R3 | Expanded city panel vs collapsed city card: origin renders `DestinationPanel` (which minimises into `CityCard`); national renders `CityCard` directly with `sub="N departures · M arrivals"` and no Details button | `App.tsx:450-467`, `DestinationPanel.tsx:65-80`, `MapCards.tsx:48-118` | **should-merge** | `DestinationPanel` gets `rows?: [string, string][]` and `point: {idx, zh, en, trains}` (a `Pick` of `CityPointVM`); national passes `rows = [["Departures", dep], ["Arrivals", arr]]` and gets the same expand/minimise/focus-return behaviour (`:43-51`) for free. App then renders one `<DestinationPanel>`. |
| R4 | Departures section: `natTrainsMode` is a fifth `ModeView` alongside out/in modes; `NatTable` is a windowed table | `DeparturesTable.tsx:404-412`, `departures/natTrains.tsx`, `NatTable.tsx` | justified | Same `ModeView` contract, same `FilterToolbar`, same chrome; windowing is needed for 11k rows. Nice-to-have: give the four origin tables the same windowing (`natWindow`) so a 1,200-row 广州 table renders like the national one. |
| R5 | Histograms rendered twice: `<Histograms cur>` or `<Histograms rows>` | `DeparturesTable.tsx:419-458`, `Histograms.tsx:339-371` | **should-merge** | `Histograms` takes `rows: HistRow[]` and `where: string`; `DeparturesTable` derives rows for the origin (`deps`/`arrs`/calls, the code now at `Histograms.tsx:339-371`) and passes `national.histRows` otherwise. One JSX call, 30 fewer lines. |
| R6 | Legend scales: `national` prop switches steps/samples/caption | `Legend.tsx:46-48,89-95,351` | justified | One component; the data differs (trains/day vs departures+arrivals). |
| R7 | Timeline bar: `isNational` relabels Running/Trains, hides Arrived and Finish | `TimelineScrubber.tsx:90-92,184-188,393-410,563-572` | justified | One component driven by `AnimState.national`. |
| R8 | Timetable modal: `national` synthesises a `trainVM` from the stops, folds the clock, hides isolate/jump in inbound only | `TrainScheduleModal.tsx:30-35,113-141,238-243` | justified | One component. S4 asks for the stop unrolling to happen once. |
| R9 | (Removed by owner decision: `AnimAnnouncer` and its live region are deleted.) Screen-reader live region: national only; origin silent by decision (P2.4) | `AnimAnnouncer.tsx:5-6,34` | justified (decision) | Nice-to-have: announce the origin's departed/arrived too (§7.4). |
| R10 | Deck layers: `nationalLayers` / `nationalRings` vs `trainLayers` | `layers/national.ts:263-365`, `layers/trains.ts:183-245` | **should-merge** | `interface DotBuffers {count, pos: Float32Array, posStride, line: Uint8Array, fill?: Uint8Array, tailCount, tailSrc, tailTgt, tailCol, dwell: Disc[], rings: Disc[]}`; `dotLayers(prefix: "" \| "nat-", b: DotBuffers, o: {pickable: boolean; isolated: boolean}): Layer[]`. `TrainBuffers` and `NationalFrame` both satisfy it (the national frame's interleaved `buf` becomes `pos` with `posStride: 24`, `fill` undefined = white). Removes ~90 lines and keeps the two marks identical by construction (the plan's §2.2 intent). |
| R11 | Flows: national B / A+B reuse `buildPassData`, `passDataLayers`, `recountPassData`, `infraLayers`, `wholePath`, `rippleRing` | `layers/national.ts:456-487,491-507,642-651,679` | reused | Good: one geometry path for both modes. |
| R12 | Label candidates: national fabricates `CityPointVM`s with zeroed fields | `layers/national.ts:614-637`, `labelsOverlay.ts:38-44` | **should-merge** | Narrow `placeLabels`' input to `LabelPoint = Pick<CityPointVM, "idx" \| "zh" \| "en" \| "pt" \| "trains">` (`lib/labels.ts`); the national builder then passes `{idx, zh, en, pt, trains}` honestly. Type-only change. |
| R13 | Picking: `pickNational` (CPU scan + flow proxy) vs `pick` (GPU proxies + CPU stations/trains) | `interaction.ts:88-155,159-218` | justified | Candidate sources differ; `pickPriority` is shared. |
| R14 | `useCityPanel(national)` returns all classes available; `useAnimationClock(national)` collapses the bar on a mode change | `useSelection.ts:169-171`, `useAnimationClock.ts:33-42` | justified | Small flags in shared hooks; fine. |
| R15 | `MapCanvas` fits the country on entering national, folds the clock into one day | `MapCanvas.tsx:222-249` | justified | Mode entry behaviour; fine. |

Verdict: the rule holds. The national view renders through the same `App` tree, header,
toolbar, map host, legend, timeline bar, departures section, filter toolbar, histograms,
modal and cards; no component was forked. The three "should-merge" items (R3, R5, R10, plus
the type-only R12) are the remaining duplicates and each is a pure refactor with a test
already covering both sides (`mapCards.test.tsx`, `nationalLayers.test.ts`, `layers.test.ts`,
`headingCount.test.tsx`).

Other duplicated UI: the tooltip has one builder with per-kind branches (`lib/tooltip.ts`),
the cards share one frame (`MapCards.tsx`), the tables share `TrainCell`, `RunsCell`,
`HeadCount`, `StationLine`, `EmptyMessage`; nothing else is duplicated.

---

## 3. Merge readiness vs `main`

### 3.1 Divergence

- `git log origin/main ^origin/deckgl`: **empty**. `git merge-base origin/main origin/deckgl` =
  `cecf4d2` = `origin/main`'s head. `main` has not received a commit since `deckgl` branched
  (2026-10-24); the weekly sync PRs of the plan (R10) were never needed.
- `git log origin/deckgl ^origin/main`: 169 commits at `4c2dde4`, 177 after #88–#91 (68 merge
  commits; PRs #24–#91 merged with merge commits).
- `git merge origin/main` into a scratch branch is "Already up to date": a fast-forward with
  no conflicts. Nothing on `main` was lost or regressed by `deckgl` because nothing changed on
  `main`.

### 3.2 Config differences

| File | `main` | `deckgl` | Note |
|---|---|---|---|
| `web/vercel.json` | headers only | adds `ignoreCommand` (`:6`): `main` builds only if `web/` changed between `HEAD^` and `HEAD`; `deckgl` builds only on a `[deploy]` commit; other branches never build | Active config (the PR checks show "Canceled by Ignored Build Step"). See §3.3. |
| `vercel.json` (root) | mirror of the headers | unchanged, so it now lacks the `ignoreCommand` | Not the active file; sync it or delete it (nice-to-have). |
| `.github/workflows/ci.yml` | `web` (typecheck/build/test) + `pipeline` | adds `web-smoke` (headless SwiftShader boot of the deck chunk), `pack-audit` (`audit --pack-only` on the committed pack), `pack-diff` (PR comment with `secdiff --packs`); triggers on `main` and `deckgl` | CI gains three gates; nothing removed. |
| `web/package.json` | react, react-dom, typescript, esbuild | adds `@deck.gl/{core,layers,extensions,geo-layers}` 9.4.0 (exact), `pixelmatch`, `puppeteer-core`; scripts `shots`, `perf*`, `bench` | `geo-layers` is a dependency but no `TripsLayer` is used (D2 off): nice-to-have, drop it (bundle unaffected, it is not imported). |
| `pipeline/goldens.json` | 12306 pack goldens | 11k pack goldens; `goldens-12306fix.proposed.json` kept for the 12306 recipe (`docs/PIPELINE.md:214-218`) | fine |

### 3.3 The Vercel ignore rule and the merge (top action 1)

`web/vercel.json:6`: `case "$VERCEL_GIT_COMMIT_REF" in main) git diff --quiet HEAD^ HEAD -- . ;; …`.
Vercel skips the build when the command exits 0. On `main` after a **fast-forward** merge,
`HEAD` is `deckgl`'s head and `HEAD^` its first parent, i.e. the previous `deckgl` merge; the
diff covers the last PR only. If that PR is docs-only (the audit PR will be), `main` is not
redeployed and the live site keeps serving the Canvas build until the next web change.
Fix either: merge with `git merge --no-ff origin/deckgl` (then `HEAD^` is old `main` and the
diff is the whole branch), or change the rule to
`git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" "$VERCEL_GIT_COMMIT_SHA" -- .` (Vercel sets the
previous deployed SHA; falls back to a build when unset). The second is the durable fix and a
one-line, config-only PR.

### 3.4 What visibly changes on the live site when `deckgl` lands

**Data (the pack).** `main` ships the 12306 pack: 7,157 trains, 102 origins, 7,922 / 7,904
sections, 8,825 throats, 2,212 stations, 1,499 cities, no calendar; 7 files, 5.31 MB.
`deckgl` ships the train-export pack (owner-approved swap 2026-10-25): **11,248 trains**
(+57 %), 9,106 / 9,055 sections, 10,949 throats, 2,697 stations, 1,894 cities, schedule window
**23 Oct – 6 Nov 2026** (15 dates, per-train run days), plus the four national files; 11 files,
**7.94 MB**. Per file (brotli): shared 508 → 605 KB, out-map 528 → 549, in-map 534 → 568,
out-tables 1,641 → 1,919, in-tables 1,783 → 2,056, schedules 415 → 543, outline 33 (same);
new `national` 34 KB, `national-trains` 333 KB, `national-entries` 942 KB, `national-index`
524 KB (the last four load only on entering national mode; 1.83 MB). First paint fetches
1,068 → 1,215 KB of packs (+14 %) plus the 233 KB deck chunk. Route changes against the 12306
pack: §3.5. Visible fixes: the "filled-leg jumps" of PR #51/#55 (0 rows with a > 20 km jump,
was 37; 0 gaps > 6 km, was 149), city points from the pack (O10), run-day labels in every table.

**UI.** The map is a WebGL2 deck.gl renderer (no WebGL2 → notice, tables keep working; context
loss → "Map paused — tap to resume"); the origin view is pixel-matched to Canvas within the
G1 thresholds (plan §11, all 28 scenarios ≤ 0.61 %, labels softer on the overlay canvas, C21).
New: the header mode switch and **National Beta** (flows, growing city circles, every train on
one clock, filters by hour / distance / duration / class / train, a windowed table of all
trains); the train timetable modal redesigned ("Signal" design: progress bar, now-block,
"Play from origin", "Isolate on map"), minimisable to a map card; city details minimise to a
card; one reserved card column top-right; the Zoom-clarity toggle; the 24h bar shared by both
modes; mobile toolbar folded into "Filters" / "Map options" panels with 44 px targets.

**Bundle and first paint.** `index.html` 455 → 474 KB (gzip 134 → 140 KB, brotli 114 →
119 KB; the entry is inlined, no deck code in it, `bundle.mjs:94-101` asserts). New: the lazy
deck graph, 8 hashed files, 1.0 MB minified, **233 KB brotli** (budget 300 KB, enforced by the
build), fetched on first paint and then immutable-cached. Numbers for cold/warm load on
localhost and on a throttled 1.6 Mbps link are in §4.4.

### 3.5 Risky items: unreviewed route changes in the shipped pack

`staging/data-11k/reports/route-changes.md` (main checkout, read-only) lists the per-train
legs the 11k router moved and marks each "yes / likely / check". The pack is live on `deckgl`
and owner-approved as a whole, but these rows were flagged for a look and have had none:

| Legs | Change | Report's verdict | Why it matters on the map |
|---|---|---|---|
| 温州–缙云 (1 T train) | bridge-fix now prefers a 198.8 km alt via 金温货线 over 138.9 km | **"check, looks wrong"** | +60 km of flow drawn on a freight line |
| 丽水–温州 (7 trains), 温州–青田 (2) | moved onto 金温货线 (freight), +15.5 km / +0.5 km | "check" / "likely" | passenger flow on a freight alignment |
| 昆明–昆阳 C562/C556 (3 trains) | 67.3 km fast-C on 中老昆万线 entering 昆阳 from the east (was the 82 km alt-1 turn-back, the C562 jump) | "owner check" | the fix for a visible jump; alignment plausibility |
| 怀化–鹰潭 (1 K train) | fast-K via 怀衡线, +34.3 km | "check" | long detour on a single train |
| 济南西↔济南东 (6 G/D trains) | the two directions pick opposite corridors (石济客专 44.4 vs 京济联络 39.7 km); production was a bridged 29 km link | "check: the two directions disagree" | asymmetric flow between the two 济南 stations |
| 沧州–天津 (7 K trains) | posterior tie 0.50/0.50 now resolves to 南曹线, +12.5 km | "check: near-tie" | 7 trains' worth of width moved |
| 雁石南–龙岩 (1 D) | +2.0 km, "avoids a turn-back but is clearly longer" | "check" | minor |
| 杭州东–潮汕 (1) | an unrouted chord became a 1,058 km filled path | "check" | a long new line on the map |

Recommendation: an owner pass over these eight rows on the live `deckgl` build (zoom to each
pair) before or soon after the merge; any correction is a recipe/override change and a staged
rebuild, not a client change. The approved single-train spot-check protocol applies; no bulk
12306 queries.

---

## 4. Performance: why Canvas → deck.gl

### 4.1 Method (details and raw data: Appendix A, `docs/perf/2026-10-26-canvas-vs-deck/`)

Baseline: the Canvas renderer on `origin/main` @ `cecf4d2` (the live site: 12306 pack, 7,157
trains, 7,922 sections), built in a detached worktree with one local, uncommitted patch that adds
the two measurement hooks `deckgl` exposes (`window.__M`, `window.__draw`). Candidate: `deckgl`
@ `4c2dde4` (deck.gl 9.4.0, 11k pack, 11,248 trains, 9,106 sections). Both served by
`tools/serve.mjs` with the production headers. One harness (`tools/perf/compare.mjs`, PR #88)
drove both: per frame `__mapApi.setTime(t)` (a synchronous draw in both renderers), a second
pass per sweep forcing the raster (`readPixels` / `getImageData`), 300 frames per sweep, 3
repetitions in fresh browser contexts, DPR 1 and 2, CPU throttle 1× and 4× (CDP), 1280×800,
Chrome 155 headless on the real GPU (ANGLE Metal, M4 Max; SwiftShader refused). Reported:
median of the 3 reps with the min–max spread. Caveats: the two packs differ (+57 % trains, +15 %
sections), so this is "the deployed site vs the site after the merge", not renderer vs renderer
on identical data; the machine was shared (load average 3–4), which inflates rAF intervals but
not draw time (plan §11.2 G8), so **draw+raster p95 is the primary figure**.

### 4.2 Origin view: Canvas vs deck.gl

Digest (ms; full table with spreads in Appendix A):

| scenario | DPR | CPU | draw+raster p95 Canvas → deck | rAF p95 Canvas → deck | frames > 20 ms Canvas → deck | JS draw p50 Canvas → deck |
|---|---:|---:|---|---|---|---|
| opening view (广州), 24h sweep | 1 | 1× | **7.9 → 10.3** | 16.7 → 16.8 | 0 → 0 % | 1.7 → 1.1 |
| | 2 | 1× | 11.2 → 10.0 | 16.7 → 16.7 | 0 → 0 % | 1.7 → 1.1 |
| | 1 | 4× | 25.1 → **14.3** | **16.7** → 33.4 | 0 → 40 % | 3.6 → 3.9 |
| | 2 | 4× | 41.4 → **13.8** | **16.8** → 33.4 | 0 → 46 % | 3.6 → 3.7 |
| city ×10 zoom, 24h sweep | 1 | 1× | 7.3 → 7.8 | 16.7 → 16.7 | 0 → 0 % | 0.8 → 1.0 |
| | 2 | 1× | 9.7 → 9.6 | 16.7 → 16.8 | 0 → 0 % | 0.8 → 1.1 |
| | 1 | 4× | 23.4 → **11.5** | 33.4 → 33.4 | 27 → 38 % | 2.5 → 3.8 |
| | 2 | 4× | 37.1 → **13.5** | **50.0** → 33.4 | **73** → 43 % | 2.9 → 3.6 |
| 18:15 peak (1035→1155), opening view | 1 | 1× | 7.4 → 9.9 | 16.8 → 16.7 | 0 → 0 % | 1.4 → 0.9 |
| | 2 | 1× | 9.8 → 9.6 | 16.8 → 16.7 | 0 → 0 % | 1.3 → 0.8 |
| | 1 | 4× | 24.5 → **12.8** | 33.4 → 33.4 | 44 → 29 % | 4.5 → 3.0 |
| | 2 | 4× | 36.5 → **12.4** | **50.1** → 33.4 | **100** → 33 % | 4.9 → 2.9 |

Reading:

- **Unthrottled, both renderers hold 60 fps** at every zoom and DPR (rAF p95 16.7–16.8 ms,
  0 % dropped). Canvas's forced-raster frame is cheaper at DPR 1 on the opening view (7.9 vs
  10.3 ms) and about equal elsewhere; deck's JS per frame is lower (0.8–1.1 vs 0.8–1.7 ms).
- **Under a 4× CPU throttle the two diverge.** deck's draw+raster p95 stays at 11.5–14.3 ms in
  all six cells: its frame cost does not grow with DPR (×1.0 from DPR 1 to 2), zoom or the
  train count at the peak, because the per-frame CPU work is the attribute upload of the dots
  and the pass data, not the pixels. Canvas's frame cost scales with pixels (×1.6 from DPR 1 to
  2) and the stroked length (city ×10, 18:15): 23–41 ms p95. At DPR 2 Canvas misses every frame
  at the 18:15 peak (rAF p50 50 ms, 20 fps) and 73 % at the city zoom; deck's worst cell is
  rAF p95 33.4 ms with 29–46 % of frames at the 2-vsync mark, i.e. 40–45 fps.
- **One honest asymmetry:** on the *opening view* at 4×, Canvas still reports rAF p95 16.7 ms
  while its forced-raster frame is 25–41 ms. Chrome rasterises the accelerated 2D canvas off
  the main thread, so when the stroke work fits in the GPU process the rAF cadence survives; the
  cost shows up as soon as the view or the clock adds strokes (the other two scenarios). deck
  spends its ~4 ms of JS plus the WebGL submission and the two-canvas composite on the throttled
  main thread and lands at 2 vsyncs for roughly 40 % of frames in every 4× cell, including the
  cheap opening view. This is the one place Canvas measured better under load; a Chrome trace
  to apportion deck's remaining main-thread time (layer diffing in `setProps`, the overlay
  canvas redraw, `preserveDrawingBuffer`) is a follow-up, not a merge concern.

### 4.3 National mode (deck.gl only) against the plan's budget

Canvas never had a national mode, so these are absolute numbers against the budget of
`docs/history/DECKGL_MIGRATION.md` §4 (M1n: rAF p95 ≤ 16.7 ms and deck CPU ≤ 4 ms unthrottled; M2n at
4×: rAF p95 ≤ 33.4 ms on the median of 3 reps and draw+raster p95 ≤ 16.7 ms; M4n GPU ≤ 64 MB;
M5n national heap delta ≤ 30 MB). Full 11k pack: 3,601 dots and 9,049 lit sections at the 18:15
sweep.

| mode | view | DPR | CPU | rAF p95 | dropped | draw+raster p95 | deck cpuTimePerFrame | budget |
|---|---|---:|---:|---:|---:|---:|---:|---|
| A (trains) | opening | 1 | 1× | 16.8 | 0 % | 9.4 | 0.90 | pass |
| | national fit | 2 | 1× | 16.8 | 0 % | 12.6 | 0.89 | pass |
| | city ×10 | 2 | 1× | 16.8 | 0 % | 8.8 | 0.87 | pass |
| | opening | 2 | 4× | 16.8 | 0 % | 13.9 | 2.15 | pass |
| | national fit | 2 | 4× | 16.8 | 0 % | 15.4 (15.2–17.6) | 2.07 | pass (one rep at 17.6) |
| | city ×10 | 2 | 4× | 16.7 | 0 % | 11.6 | 1.97 | pass |
| A+B (trains + flows + growing circles) | opening | 1 | 1× | 16.8 | 0 % | 12.7 | 1.65 | pass |
| | national fit | 2 | 1× | 16.7 | 0 % | 11.1 | 1.46 | pass |
| | city ×10 | 2 | 1× | 16.8 | 0 % | 12.3 | 1.78 | pass |
| | opening | 2 | 4× | 16.8 | 0.7 % | **17.9** (15.6–18.2) | 4.41 | rAF pass; draw+raster 1.2 ms over |
| | national fit | 2 | 4× | 16.7 | 0 % | 16.6 (16.3–17.8) | 3.76 | pass at the line |
| | city ×10 | 2 | 4× | 33.3 (16.8–33.3) | 5.7 % | 16.6 (16.3–18.3) | 5.00 | rAF median at 2 vsyncs in 2 of 3 reps; draw+raster at the line |

Reading: trains alone (A) are cheaper than the origin view in every cell (0.8–2.2 ms of deck
CPU for 3,600 dots; the origin view spends 1.7–6 ms on ~15 layers) and hold 60 fps even at
4× / DPR 2 with 0 % dropped frames. A+B adds the 9,049-section flow pass with a recount every
whole minute and the growing circles: unthrottled it is 11–13 ms of draw+raster at 60 fps; at
4× it sits exactly at the 16.7 ms line (15.8–17.9 ms p95) and the city zoom drops ~6 % of
frames. That is the same picture the plan recorded for `natSynth=12000` in P2.2 (M2n
"0.7–1.9 ms over at national fit") now reached by the real 11k pack. Memory: deck `gpuMemory`
2.0 MB of buffers for A (5.2 / 14.9 MB total at DPR 1 / 2 as deck reports after a pick),
5.6–5.7 MB of buffers for A+B (8.9 / 18.6 MB), all far under M4n's 64 MB; JS heap 86 MB (A) and
96 MB (A+B) in the national page, and `buildNational` is 27.3 MB of heap for 11,248 trains
(`national.test.ts`, M5n ≤ 30 MB, measured in this audit's `bun test` run). M7n (time to the
first national frame) was not re-measured; the plan's P2.2 value is 197–214 ms.

### 4.4 Load, bundle and transfer

Static sizes first (what every visitor downloads before the map; brotli as served):

| | `main` (Canvas) | `deckgl` (deck.gl) | Δ |
|---|---:|---:|---:|
| `index.html` (entry inlined) | 455 KB raw, 114 KB br | 474 KB raw, 119 KB br | +5 KB br |
| renderer code fetched on first paint | 0 (in the entry) | lazy graph 8 files, 1,044 KB min, **233 KB br** (budget 300) | +233 KB |
| packs on first paint (shared + out-map + outline) | 1,068 KB | 1,215 KB | +147 KB (bigger pack) |
| **first paint total** | **1,182 KB** | **1,567 KB** | **+385 KB (+33 %)** |
| staged behind first paint (out-tables + schedules) | 2,056 KB | 2,462 KB | +406 KB |
| on first inbound flip (in-map + in-tables) | 2,317 KB | 2,624 KB | +307 KB |
| on entering national mode | – | 1,832 KB (4 files) | new |
| everything | 5.31 MB (7 files) | 7.94 MB (11 files) + 0.23 MB JS | +2.9 MB |

Measured loads (median of 3 cold starts in fresh contexts; "map ready" = `__mapApi` and `__M`
present and the `#loading` overlay gone; on deck that is after the lazy chunk mounted):

| network | CPU | build | cold FCP | cold map ready | first deck frame | KB before ready | warm map ready (304s) |
|---|---:|---|---:|---:|---:|---:|---:|
| localhost | 1× | Canvas | 320 | **1,149** | – | 3,503 | 97 |
| localhost | 1× | deck | 316 | **406** | 546 | 2,403 | 130 |
| localhost | 4× | Canvas | 496 | 2,270 | – | 3,503 | 363 |
| localhost | 4× | deck | 492 | 909 | 2,091 | 2,403 | 752 |
| 1.6 Mbps / 150 ms | 1× | Canvas | 1,304 | **9,939** | – | 1,495 | 264 |
| 1.6 Mbps / 150 ms | 1× | deck | 1,336 | **11,932** | 11,939 | 1,873 | 298 |
| 1.6 Mbps / 150 ms | 4× | Canvas | 1,456 | 10,213 | – | 1,495 | 476 |
| 1.6 Mbps / 150 ms | 4× | deck | 1,476 | 12,150 | 12,340 | 1,873 | 566 |

Reading: on a fast link deck shows the map 0.7 s earlier (406 vs 1,149 ms) because `main`'s
`#loading` overlay only clears once the staged tables have landed too (3.5 MB before ready vs
2.4 MB), and the deck chunk is cheap at localhost speed. On a 1.6 Mbps link the order flips:
deck's first map is **2.0 s later** (11.9 vs 9.9 s), which is the +378 KB it needs before the
map can draw (233 KB chunk + 147 KB bigger packs) at 200 KB/s. The CPU throttle barely moves
either (parsing is < 1 s of the 10–12 s). Warm reloads are 100–300 ms on both (`index.html`
revalidates, everything else is immutable-cached; the harness's `serve.mjs` answers 304 like
the host). FCP is identical (the header and toolbar paint before any pack). The practical
consequence for the merge: nothing on a desktop link, a two-second later first map on a slow
mobile link, and 2.6 MB more total transfer for a user who opens every view. Two cheap levers
if that matters: self-host the fonts (one fewer third-party round trip ahead of the packs) and
`<link rel="modulepreload">` for the deck chunk in `index.template.html` so it is requested in
parallel with the packs rather than after React mounts.

### 4.5 Where Canvas was better

- Forced-raster frame on the unthrottled opening view at DPR 1: 7.9 vs 10.3 ms p95.
- Steady 60 fps on the opening view under a 4× CPU throttle (deck: 40–45 fps there; both drop
  elsewhere, Canvas much further).
- Origin switch: the longest main-thread task after `__selectOrigin` is 55 ms on Canvas vs
  74 ms on deck at 1× (209 vs 285 ms at 4×); the 2-s long-task total 55–68 vs 146–160 ms. deck
  rebuilds the ordered flow pass data and uploads it, on a pack with 57 % more trains.
- JS heap after the sweeps: 71.5 MB vs 93.5 MB (+22 MB; the pack is 57 % larger and the deck
  chunk itself is ~5 MB of code heap, so per train the client is leaner, but the absolute number
  is higher).
- Bytes to first paint: +147 KB of packs (the bigger pack) and the 233 KB brotli deck chunk;
  `index.html` +19 KB. Section 4.4 has the resulting load times.
- Pixel-exact text: labels on the transparent overlay canvas are rasterised softer than on the
  opaque Canvas map (plan C21); invisible at 1×, measurable in the diffs.

### 4.6 Why the switch, with the numbers behind each reason

1. **Frame cost that does not scale with pixels or strokes.** Under load deck draws every
   origin-view scenario in 11.5–14.3 ms p95 at DPR 1 and 2; Canvas needs 23–41 ms and drops
   73–100 % of frames at DPR 2 on the busy scenarios. Phones are DPR 2–3 and 3–5× slower than
   this machine, so the 4× / DPR 2 cell is the realistic one; the owner's phone check (plan M3)
   passed on deck after the depth-buffer fix and never passed Canvas at the peak.
2. **National mode exists only on deck.** 11,248 trains on one clock (3,600 dots at the 18:15
   peak) over 9,000 lit sections draw in the same budget as the origin view (§4.3); the Canvas
   spike measured 16.6 ms of CPU per frame for the dots alone (plan §0) before any flows, i.e.
   it could not have held 60 fps even unthrottled.
3. **Picking.** Canvas hit-testing walked every visible polyline per pointer move; deck's
   hairline pick proxies answer one GPU query per hover for sections and chords and keep the
   exact Canvas tie rules in `lib/pick.ts` (plan D6/P1b.4); national picking is a 0.005 ms CPU
   scan over the frame's dots (plan P2.3).
4. **Memory is bounded and measured.** deck's GPU memory is 6.3 MB at DPR 1 and 16.0 MB at
   DPR 2 for the full origin stack (plan M4 limit 64 MB); the national timeline is 27 MB of heap
   for 11k trains against the spike's 48 MB for 7k (plan M5n); the CPU staging copies are pooled
   typed arrays, no per-frame allocation (Canvas allocated a gradient per train per frame,
   `review-fable` R15).
5. **Maintainability.** The rendering semantics moved into pure, tested `lib/` modules
   (`mapModel`, `labels`, `pick`, `camera`, `national*`: 4.9k lines, 266 tests) before any
   deck layer was written, and the deck layers are prop builders over typed arrays (2.9k lines,
   React-free, size-budgeted). Canvas was 3.1k lines of imperative drawing with no tests
   (plan §1, §9; `review-fable` §6 "Tests: none").
6. **Parity was proven, not assumed:** 28 screenshot scenarios at ≤ 0.61 % differing pixels
   under the G1 rule, 0 px on the static ones after P1b.5 (plan §11.1 M14), the camera maths
   exact to 7e-11 px (M8), context loss and device failure handled with notices (M12, P1c.3).

---

## 5. Unused files and stale docs

**Removed (PR #89, #91):** `web/icon.webp` (unreferenced), 3 dead exports, 1 unused local, 2
ignored props.

**Kept, with a verdict:**

| Path | Status | Verdict |
|---|---|---|
| `docs/history/DECKGL_MIGRATION.md` (1,576 lines) | the plan plus per-task as-built notes; status header was stale (fixed in #90) | **Keep** as the record. Nice-to-have later: move §4's as-built notes into a `docs/history/deckgl-as-built.md` and leave a 100-line plan. |
| `docs/THIN_CLIENT.md` | design doc, "nothing built", owner defers | **Keep**; still the record of the pack-format decision. Not acted on (owner instruction). |
| `docs/review-fable.md` | review of `main` @ `f199472` (Canvas era); top items done | **Archived** → `docs/history/review-fable-2026-10-24.md` with a status note (#90). |
| `docs/deckgl-spike/*.png` (4 side-by-sides) and `p1b1/`, `p1b2/`, `p1b3/`, `p1b5/` diff masks (46 PNGs, 6.9 MB) | G0 spike and G1 parity evidence; each directory referenced once from the migration doc | **Keep `p1b5/`** (the final G1 masks) and the 4 spike PNGs; `p1b1–p1b3` (3.5 MB) are interim masks superseded by `p1b5` and can be deleted once the doc's three references are reworded. Borderline; not removed. |
| `docs/history/PROJECT_NOTES.md`, `docs/research/*`, `docs/corridor-v3-report.md`, `docs/corridor-v3-summary.json`, `docs/MANUAL_OVERRIDES.md`, `docs/benchmarks/*` | handoff-era records, referenced from `PIPELINE.md` | Keep. (`docs/benchmarks/` was later removed.) |
| `optimization.md`, `optimization-progress.md` (repo root) | the pipeline work log, "update at the end of every session" | Keep; nice-to-have: move under `docs/` (the progress log's "How to resume" paths would need updating). |
| `docs/features.md` | roadmap; #8 and #1 statuses were stale (fixed in #90) | Keep. |
| `pipeline/goldens-12306fix.proposed.json` | goldens for the 12306 recipe, referenced by `PIPELINE.md:214-218` | Keep. |
| `scripts/build_station_en.py` | fetches the 12306 station dictionary to build `data/station_en.json`; referenced nowhere | Borderline: keep as the generator of a tracked data file, add a header line saying so. |
| `scripts/check_pack_roundtrip.mjs`, `scripts/strip_throats.mjs` | fmt-5→6 roundtrip checks, referenced from the progress log and `PIPELINE.md`; cannot run against today's pack (fmt 6 both sides) | Borderline: historical; move to `scripts/history/` or delete after the merge. |
| `scripts/o9_fix_paths.py`, `scripts/o9_osm_regions.py` | regenerate `data/pair_path_fixes.json` (`PIPELINE.md:219-222`) | Keep. |
| `web/tools/g1-checklist.mjs`, `g1-ctxloss.mjs`, `g1-devicefail.mjs` | G1 review drivers; still runnable against `dist` | Keep; candidates for CI (§6.3). |
| `web/tools/bench/*` | the thin-client pack benchmark (`bun run bench`), tied to the deferred THIN_CLIENT work | Keep with THIN_CLIENT. |
| `web/tools/national-*-sample.mjs`, `national-entries-fixture.ts` | regenerate the committed test samples | Keep. |
| `web/tests/fixtures/*` (3 files, 178 KB) | used by `fixture.ts`, `motionContract.test.ts` | Keep. |
| `@deck.gl/geo-layers` dependency | installed, never imported (`TripsLayer` not built, D2) | Nice-to-have: remove from `package.json` (no bundle effect). |

Outdated doc sections fixed in #90: README (quickstart could not show the map; section counts,
widths, file inventory, bundler, national mode), migration status header, `features.md` #1/#8,
`PIPELINE.md`'s `atlaspack` output list. Still outdated: `docs/PIPELINE.md:165-181` describes
the pack as "shared + per-direction map/tables" without the national and schedules files in
prose (the code block is fixed), and `PIPELINE.md:71-78` ("v2+ enhancements") predates the
renderer; both are history sections and say so.

---

## 6. Tests and CI

**What exists.** 266 tests in 34 files (`bun test`, 2.5 s), all on the committed pack or
committed samples: decode/format guards, snapshots of flows per step, animation and dwell
rules, mapModel passes/stations/chords, pick priority, camera maths, labels, ferry split, deck
layer props (`layers.test.ts`, `nationalLayers.test.ts`), national timelines against an
independent oracle (`national.test.ts`), national flows/entries/index/city growth/table,
toolbar panels, map cards, national train modal, Play-from-origin, stale reload, deck picker
contract. CI: typecheck, build (with the 300 KB chunk budget and the no-React/no-deck-in-entry
assertions), `bun test`, headless SwiftShader smoke (chunk loads, a frame renders, map not
flat), `audit --pack-only` against goldens, PR pack diff, `cargo fmt/clippy/test`.

**Coverage gaps for the new features.**

| Feature | Covered | Gap |
|---|---|---|
| National filters / index | `nationalIndex.test.ts`, `natTable.test.ts` (real-pack cases `skipIf(!have)`), `nationalFlows.test.ts` | the index-failure path (`nationalIndexFailed`) and `useNationalTable` wiring |
| City growth | `nationalCityGrowth.test.ts`, `nationalLayers.test.ts` | — |
| Timetable modal | `nationalTrain.test.tsx` (national branch) | the origin branch: anchor/time-shift (`alignedStops`), `currentStatus` states, minimise/close on bar collapse (`:79-85`), focus trap (`useDialog.ts` untested) |
| Map cards | `mapCards.test.tsx`, `tools/cards-layout.mjs` (local only) | layout tool not in CI; no 390×664 case |
| Play from origin | `playFromOrigin.test.tsx` | — |
| Unlit cities | `layers.test.ts:114` (drawn only once lit) | `interaction.ts:50` (not pickable while unlit) and `labelsOverlay.ts:41-42` (not labelled) untested |
| Origin reset (PR #82) | none | `App.tsx:178-182` effect: no test that a new origin clears the train/isolation/destination |
| Zoom clarity | `zoomWidth.test.ts` | — |
| Shared 24h bar / national reuse (PR #80) | `animation.test.ts` national clock | `useAnimationClock` collapse-on-mode-change, `TimelineScrubber` labels and keyboard shortcuts |

Modules with no test naming them: `Histograms.tsx` (912 lines), `App.tsx`, `TimelineScrubber.tsx`,
`useAtlasData.ts` (staged loading, failure flags), `DeparturesTable.tsx` (mode dispatch),
`Legend.tsx`, `useSelection.ts`, `FilterToolbar.tsx`, `AppHeader.tsx`, `labelsOverlay.ts`,
`CityPicker.tsx`, `DestinationPanel.tsx`, `ActiveFilterBar.tsx`, `AnimAnnouncer.tsx`,
`useDialog.ts`, `MapOverlays.tsx`. `DeckHost.ts` is covered only by the CI smoke and the local
G1 drivers (no test of `settled`, context-loss recreation or `devicePixels`).

**Flaky tests.** `bun test` has no known flake (no `skip`/`only`; the two `skipIf(!have)` cases
depend on the pack being present, which it is). The screenshot suite flaked twice in the
record: `labels-on@1x` 9 px once (plan `:724`) and `national-fit` once (owner report). Cause
consistent with both: `shots.mjs` waits for `__deckStats.settled` but never for
`document.fonts.ready` (Inter / Noto Sans SC from Google Fonts), so a shot taken before the web
font swaps differs in every label glyph; `national-fit` has no labels but its scenario clicks
"National view" and sleeps 800 ms (`shots.mjs:55`) instead of waiting for `settled`. Fix: await
`document.fonts.ready` after load and replace the fixed sleeps by the `settled` wait (or
self-host the fonts, which also removes a third-party request).

**What CI does not check.** Screenshots (local GPU only, by design); frame-time budgets
(§4 numbers are local; the perf drivers are not in CI); the size of the inlined entry
(474 KB; only the lazy chunk has a budget); `cards-layout.mjs`, `g1-*.mjs`; accessibility
(no axe / Lighthouse run); `cargo test --release`; the full `audit` (needs the OSM extract; the
`dropped_chains` / `flow_lost` goldens are not gated in CI, `ci.yml:48-49`); `tools/*.mjs`
are not type-checked. Recommendations: add `cards-layout.mjs` and `g1-devicefail.mjs` to
`web-smoke` (both are layout/DOM assertions that hold on SwiftShader), an entry-size budget
assertion in `bundle.mjs`, and an axe-core pass over the three surfaces in §7 as a bun test.

---

## 7. Accessibility and mobile

### 7.1 TrainScheduleModal

Good: `role="dialog" aria-modal aria-labelledby` (`:685-696`), focus moved in on open and
returned on close, Tab cycled inside (`hooks/useDialog.ts`), Esc closes (`:97-103`), labelled
minimise/close buttons, `role="progressbar"` with values (`:556`), 44 px action buttons
(`modal.css` `.sg-btn`; the `.sg-win` minimise/close buttons are 40 px).

| Finding | Where | Severity |
|---|---|---|
| Timetable rows are `<tr onClick>` with a `title`; no `tabIndex`, no key handler, no `role="button"`: keyboard and switch users cannot "jump the simulation to a stop" | `TrainScheduleModal.tsx:597-612` | should-fix: a button inside the station cell, or `tabIndex=0` + Enter/Space on the row |
| `<section aria-live="polite">` wraps the "now" block whose text changes every animation tick while playing (`liveTime` from `subscribeAnim`), so a screen reader is interrupted continuously | `:543` | should-fix: `aria-live` only while paused, or move the announcement to a throttled live region like `AnimAnnouncer` |
| The backdrop closes on click but is not keyboard-reachable (fine, Esc exists); `.tsm-dialog:focus { outline: none }` removes the focus ring from the dialog root only | `modal.css:92` | ok |
| The minimised card is a `role="dialog"` that is not modal and traps nothing | `MapCards.tsx:150` | should-fix: `role="group"` + `aria-label` (same for the city card, `:71`) |

### 7.2 Collapsed cards, toggles, other controls

- Cards: buttons ≥ 38 px wide, 44 px on coarse pointers (`cards.css:144-148`), visible focus
  rings (`:75-76`), 44 px on coarse pointers (`cards.css:150-152`); the clickable
  `.mc-main.mc-click` area has a keyboard equivalent (the Details button). `role="dialog"` as above.
- Toggles use `aria-pressed` (`Toolbar.tsx`, `AppHeader.tsx:60,68`); the mobile dropdowns use
  `aria-expanded`/`aria-controls` (`Toolbar.tsx:107-128`); the legend toggle `aria-expanded`;
  the national live region is `role="status" aria-live="polite" aria-atomic` (`AnimAnnouncer`).
- Timeline: the slider has an `aria-label`, play/pause has state labels; the five tick labels
  are `<span onClick>` with no keyboard path (`TimelineScrubber.tsx:528-572`; nice-to-have:
  buttons). Global shortcuts (Space / arrows / Home) skip form fields except the slider (good).
- Reduced motion: honoured for the panel scroll only (`App.tsx:314`); the 0.22 s origin-switch
  fade (`map.css:13,16`) and the tooltip/card transitions ignore `prefers-reduced-motion` (nice-to-have);
  the 24h animation is user-started and has a pause button, which is the WCAG requirement.
- The map canvas itself has no text alternative beyond the tables and the national live
  region; the origin view's animation is silent (R9). Nice-to-have.
- Colour: the night ramp was lifted for contrast (`palette.ts:20-21`); not re-audited here.

### 7.3 Mobile (390 px) and the owner's question

At ≤640 px the toolbar folds into two panels with 44 px targets, the legend collapses to one
button, the table gets a swipe hint and fade, the city panel joins the top-right card column
(`cards.css:134-148` overrides `responsive.css`'s bottom-sheet rule for `#destPanel`, since
`.map-cards #destPanel` is more specific). `tools/cards-layout.mjs` passes at 390×844 with two
cards, the filter bar and the expanded panel (checked on this build: no overlap with the
legend, scale bar or 24h button).

**Owner question: on phones the expanded city panel can cover the map's bottom controls;
should it be height-capped and scroll?** Yes. The column is `max-height: calc(100% - 20px)`
(`cards.css:144`) and `#destPanel` is already `overflow-y: auto` (`:140`), so the panel scrolls
only once the *column* is capped, and the cap today reaches the map's bottom edge. The bottom
controls occupy the last ~110 px (`responsive.css`: `#legendCol`/`#scalebar` at `bottom: 10px`,
`.tl-expand-wrap` at `bottom: 66px` with a 44 px button). On a 390×844 phone the map is 68 dvh ≈
574 px, so two cards + filter bar + an expanded panel (~450 px) already come within ~20 px of
the 24h button; on a 390×664 phone (map 451 px, `min-height: 400px`) they cover it.
Recommendation: `@media (max-width: 640px) { .map-cards { max-height: calc(100% - 10px - 120px); } }`
so the panel scrolls internally and the 24h button, legend toggle and scale bar stay clear, and
add `[390, 664]` to `cards-layout.mjs`. Visual change on phones only; a screenshot scenario at
390 px does not exist yet (the shots suite is 1280×800), so it needs a new baseline, not a diff.

---

## 8. Docs

Fixed in PR #90: README (quickstart server, counts, widths, inventory, bundler, national mode,
train export, tests/tools), migration status header, `features.md`, `PIPELINE.md` output list,
Fable review archived. Still to do for the merge (small, doc-only):

- `web/src/data.ts:60-65` `ABOUT` text (the footer): derive the window from `shared.calendar`
  (top action 4) and drop "listed as running on at least one date from 23 October to 6 November
  2026" from the literal.
- `docs/PIPELINE.md:171-181` prose on the pack ("shared + per-direction map/tables files") and
  the "Top-100 cut: #1 广州 1,201/day" numbers predate the 11k pack; mark the paragraph as the
  12306-era description or refresh the numbers from `atlas`'s summary.
- `docs/history/DECKGL_MIGRATION.md` §9 (maintainability table) is an estimate table; replace with the
  measured `wc -l` of the shipped layout (`lib/` 4.9k, `components/map/` 1.2k, `deck/` 2.9k,
  top-level components 4.7k, `departures/` 1.8k) or mark it "[estimate, 2026-10-24]".
- `pipeline/router/README.md` is current; `analyze` has no README (its `lib.rs` header is the
  module map); nice-to-have: a 20-line `pipeline/analyze/README.md` pointing at `lib.rs` and the
  bins.
- The live region text, the "National Beta" label and the Flows toggle tooltip are the only
  user-facing copy for national mode; there is no in-app explanation of what the circles and
  the growing flows mean beyond the legend captions. Nice-to-have: one sentence in the legend
  or the footer.

---

## 9. Repo hygiene

**Remote branches (39).** Every `feat/*`, `fix/*`, `ci/*`, `copy/*`, `data/*` branch is merged
into `deckgl` (`git branch -r --merged origin/deckgl`): 33 branches, deletable now
(`backup/feature2-and-inspector` is also merged). Not merged: `spike/deckgl` (`f04acf8`) and
`spike/national-anim` (`600b3de`), referenced from the migration doc as reference-only; tag them
(`git tag spike/deckgl-f04acf8 f04acf8`, same for the other) and delete the branches.
`exp/canonical-production-geometry` (`55b3f65`, 2026-10-24): not merged, no PR; owner
decision. `backup/handoff-local-main-3484031`: the handoff's unpushed `main`, preserved on
purpose (`optimization-progress.md`); keep until the owner says otherwise. The four audit
branches (`tools/perf-compare`, `chore/dead-code`, `docs/pre-main-refresh`,
`chore/unused-locals`) are merged and deletable; `audit/pre-main` after the report PR merges.
Recommendation: `gh pr list --state merged` is the record; delete the 37 merged branches in one
`git push origin --delete …`.

**Local worktrees in the main checkout** (`git worktree list`): 10 under `.claude/worktrees/`:
`agent-a02c5cf6…` (`feat/p1c2-delete-canvas`, merged), `agent-a0b5d956…`
(`feat/national-city-growth`, merged, locked), `agent-a53c113e…` (`feat/national-trains-pack`,
local-only branch at `539daf2`), `agent-ac31e363…`, `agent-adef11fa…`, `agent-af265a46…`
(detached), `agent-ad099b62…` (`fix/city-point-fallback`, merged), `agent-ad5da65a…`
(`feat/national-city-counts`, merged, locked), `agent-ae7f76dc…` (`data/swap-11k-national`,
remote deleted), `agent-a2f82fa3…` (this audit). Plus 4 scratch worktrees under
a temporary scratch directory (`benchwt`, `noease/base`, `p1c2fu/base`, `ripplewt`) and the
audit's own `main-wt`, `pr-wt`. Recommendation: for each, `git -C <path> status --short` to
confirm nothing uncommitted, then `git worktree remove <path>` (`--force` for the locked
ones) and `git worktree prune`; delete the local branches whose remotes are gone. Not done by
this audit (owner rule).

---

## 10. Upstream data issue: placeholder stop lists in the train export

**Confirmed, read-only** (`python3 -I` over
`data/raw/train-exports-2026-10-25/trains-all.json`,
untracked in git): 11,589 trains; **4,303 trains carry a stop list whose every entry is
`{"no": "", "name": "", "arrive": "", "depart": ""}`** (the right number of stops, no content),
all of them `source: discovered` / `phase2-discovery`: by class C 982, D 1,359, G 1,279, K 339,
S 166, T 31, Z 23, Y 20, numeric-only 104. 33 further trains have no stop list at all (the
README's 29 `stoplist_unavailable` + 4 that never ran in the window). The pipeline fills the
4,303 by `train_no` from `train-operating-days.json` (`pipeline/analyze/src/export.rs:78-103`,
`pipeline/router/src/export.rs:78-108`, `docs/PIPELINE.md:264-267`), so the shipped pack is
complete; the dependency on a second file is the cost.

Note the owner can send upstream:

> In `trains-all.json` (export of 2026-10-25, 11,589 trains), 4,303 trains — every train with
> `source` = `discovered` or `phase2-discovery` — have a `stops` array of the right length whose
> entries are all empty (`{"no":"","name":"","arrive":"","depart":""}`), while the same
> trains' czxx stop lists are present in `train-operating-days.json` keyed by `train_no`.
> Could the export carry the stop lists inline for those trains (as it does for the 7,253
> snapshot trains), or set `stoplist_unavailable: true` and omit the placeholder array when it
> cannot? A consumer that does not know about the supplement reads 4,303 trains with a known
> stop count and no stops. The 33 trains with no stop list are documented and fine.

---

## 11. What else is missing before merge

1. **Security headers (nice-to-have).** `web/vercel.json` sets caching and encoding headers
   only; no `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy` or
   `Permissions-Policy`. The page has no third-party scripts, no forms and no cookies; the
   entry is an inline `<script type="module">` and the CSS is inline, so a strict CSP needs
   hashes or `'unsafe-inline'`. Cheap wins: `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
   The only third-party requests are Google Fonts (`index.template.html:9-11`): self-hosting
   Inter and Noto Sans SC removes a cross-origin dependency, a privacy exposure, and the
   font-swap flake of §6.
2. **Error handling (should-fix, one item).** Covered well: no-WebGL2 notice, device-creation
   failure (`MapCanvas.tsx:114-126`), context loss with one re-creation (`DeckHost.ts:375-443`),
   stale-deploy reload for packs and the chunk (`staleReload.ts`), `FmtError` for every pack
   mismatch, national flows/trains failures surfaced as notices (`App.tsx:226-232`). Missing:
   the national **index** failure (top action 3); also `useAtlasData.ts:231,265,298` only
   `console.warn` on a network failure of the national files, which is fine for a lazy feature
   but means a user on a flaky connection sees "could not be loaded" with no retry (a retry is
   one click on the toggle, undocumented).
3. **Licence / attribution.** MIT (`LICENSE`), OSM ODbL attribution in the README and on the
   page footer (`Footnote.tsx`), 12306 named as the timetable source in the footer `about`
   text. deck.gl (MIT) and the fonts (OFL) need no attribution. Fine.
4. **Analytics, SEO, OG.** No analytics (nothing to disclose). OG/Twitter tags, description,
   `color-scheme`, favicon, 1200×630 OG image present (`index.template.html:12-30`); the OG
   image is 347 KB (fine). `lang="en"` on a bilingual page is acceptable.
5. **Data provenance in the pack.** `shared.build` records `pipeline_tree` and the SHA-256 of
   the OSM extract, leg paths, pair paths, overrides and schedule (`packstats`: present on
   `deckgl`, `schedule_sha256` new), and `shared.calendar` carries the window: good. The
   client still hard-codes the window and the source sentence (`data.ts:60-65`): top action 4.
   Nice-to-have: let `atlaspack` write `about` into `shared` so the sentence is a pack fact.
6. **Caching headers for the new assets.** All hashed files live under `/assets/` and get
   `immutable` (`vercel.json`); the national files and the deck chunks are hashed by
   `bundle.mjs`; `index.html` is `must-revalidate`. Correct. `favicon.svg` / `og-image.png` at
   the root have no explicit rule (defaults); fine.
7. **Determinism.** Pack builds are byte-reproducible (O17/O18; `shared.build.pipeline_tree`),
   the client pins counts in tests, screenshots reproduce to three decimals on one GPU. The
   only known non-determinism is the font-swap flake (§6).
8. **Dependency pinning.** `@deck.gl/*` exact `9.4.0`, `bun.lock` committed, CI
   `--frozen-lockfile`; `react`/`typescript`/`esbuild` are caret ranges (`typescript ^7.0.2`,
   `esbuild ^0.28.2`); a minor of esbuild can change the inlined bytes. Nice-to-have: pin
   `esbuild` exactly since the build asserts sizes.
9. **Node vs Bun.** `bun run build` runs `node bundle.mjs`; CI and Vercel therefore depend on
   the ambient Node (22 locally, Vercel's default). Nice-to-have: an `engines.node` field.

---

## 12. Cleanup PRs merged during the audit

| PR | Title | Scope | Verification |
|---|---|---|---|
| [#88](https://github.com/lsquaredleland/China-Rail-Flow-Map/pull/88) | tools(perf): renderer-agnostic compare harness; fix `national.mjs`; `serve.mjs` brotli + ETag | `web/tools/perf/compare.mjs` (new), `lib.mjs` (+`prepare`), `national.mjs` (presses the 24h button; the old `ready` wait could not be met since PR #80), `serve.mjs` (ETag/304, brotli for js/html/css/svg), `package.json` script | smoke OK, harness runs on both builds, CI green |
| [#89](https://github.com/lsquaredleland/China-Rail-Flow-Map/pull/89) | chore(web): remove dead exports and an unreferenced asset | `stationName`, `prepOrigin`, `PaletteRGBA`, `web/icon.webp` | typecheck, build, 266 tests unchanged, CI green |
| [#90](https://github.com/lsquaredleland/China-Rail-Flow-Map/pull/90) | docs: match README, migration status and roadmap to what ships; archive the Fable review | README, `DECKGL_MIGRATION.md` header, `features.md`, `PIPELINE.md`, `docs/history/review-fable-2026-10-24.md` | doc-only, CI green |
| [#91](https://github.com/lsquaredleland/China-Rail-Flow-Map/pull/91) | chore(web): drop an unused local and Footnote's ignored props | `App.tsx` `calendarSpan`, `Footnote.tsx` | typecheck, build, 266 tests, CI green |
| this PR | docs: pre-main audit report, perf raw data, `tools/perf/summarize.mjs` | `docs/AUDIT_PRE_MAIN.md`, `docs/perf/`, `web/tools/perf/summarize.mjs`, `compare.mjs` field rename | doc + tooling |

Not changed (recommendations only): everything under §1.4, §2 should-merge items, §3.3,
§3.5, §6, §7, §11 items 1–2 and 5.

---

## Appendix A. Benchmark methodology and raw data

Methodology, builds, machine and file layout: `docs/perf/2026-10-26-canvas-vs-deck/README.md`. The tables below are `node web/tools/perf/summarize.mjs docs/perf/2026-10-26-canvas-vs-deck`, verbatim (median of the repetitions, min–max in brackets). Sweep speeds: the opening-view and city-×10 sweeps step 3.6 min per frame (the historical `origin.mjs` sweep, 4.5× the 30 s/day playback speed, so the 5-minute flow-step rebuild fires in most frames); the 18:15 sweeps step 0.4 min (origin) and 0.2 min (national) per frame, i.e. at or below playback speed, and are the realistic cells.

### Frame times, origin view (median of reps; min–max in brackets; ms)

| scenario | renderer | reps | rAF p95 | rAF max | dropped % | JS draw p50 | JS draw p95 | draw+raster p50 | draw+raster p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| origin-initial · DPR 1 · 1× | canvas | 3 | 16.7 (16.7–16.8) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 1.7 (1.7–1.8) | 2.3 (2.3–2.4) | 7.0 (7.0–7.2) | 7.9 (7.8–8.0) |
| origin-initial · DPR 1 · 1× | deck | 3 | 16.8 (16.7–16.8) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 1.1 (1.1–1.2) | 1.5 (1.4–1.5) | 6.9 (6.8–7.4) | 10.3 (10.1–10.4) |
| origin-initial · DPR 1 · 4× | canvas | 3 | 16.7 (16.7–16.7) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 3.6 (3.3–3.6) | 4.8 (4.6–5.2) | 20.4 (20.1–20.8) | 25.1 (24.8–25.6) |
| origin-initial · DPR 1 · 4× | deck | 3 | 33.4 (33.4–33.4) | 33.4 (33.4–50.0) | 39.5 (37.5–43.1) | 3.9 (3.8–3.9) | 5.4 (5.3–5.8) | 10.1 (9.8–10.2) | 14.3 (14.1–14.5) |
| origin-initial · DPR 2 · 1× | canvas | 3 | 16.7 (16.7–16.8) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 1.7 (1.2–1.8) | 2.3 (2.0–2.4) | 9.5 (9.5–9.6) | 11.2 (11.1–11.5) |
| origin-initial · DPR 2 · 1× | deck | 3 | 16.7 (16.7–16.7) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 1.1 (1.1–1.1) | 1.4 (1.4–1.5) | 6.8 (6.3–6.9) | 10.0 (9.5–10.1) |
| origin-initial · DPR 2 · 4× | canvas | 3 | 16.8 (16.7–16.8) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 3.6 (3.5–3.7) | 4.7 (4.7–5.0) | 33.2 (32.4–33.7) | 41.4 (41.3–41.5) |
| origin-initial · DPR 2 · 4× | deck | 3 | 33.4 (33.4–33.4) | 50.0 (33.5–50.0) | 45.5 (45.2–46.2) | 3.7 (3.7–3.7) | 5.3 (5.3–5.3) | 9.8 (9.6–9.9) | 13.8 (13.7–13.8) |
| city-x10 · DPR 1 · 1× | canvas | 3 | 16.7 (16.7–16.8) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 0.8 (0.8–0.8) | 1.1 (1.0–1.1) | 6.5 (6.2–6.5) | 7.3 (7.0–7.3) |
| city-x10 · DPR 1 · 1× | deck | 3 | 16.7 (16.7–16.8) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 1.0 (1.0–1.1) | 1.4 (1.4–1.4) | 6.1 (5.6–6.2) | 7.8 (7.7–7.9) |
| city-x10 · DPR 1 · 4× | canvas | 3 | 33.4 (33.4–33.4) | 50.0 (50.0–50.1) | 27.1 (25.4–30.1) | 2.5 (2.5–2.8) | 3.9 (3.9–4.1) | 19.2 (19.2–20.1) | 23.4 (23.3–23.5) |
| city-x10 · DPR 1 · 4× | deck | 3 | 33.4 (33.4–33.4) | 33.5 (33.4–50.0) | 38.1 (37.8–39.8) | 3.8 (3.8–3.9) | 5.4 (5.3–5.5) | 8.8 (8.5–8.9) | 11.5 (11.5–11.8) |
| city-x10 · DPR 2 · 1× | canvas | 3 | 16.7 (16.7–16.8) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 0.8 (0.8–0.8) | 1.0 (1.0–1.0) | 8.7 (8.4–8.7) | 9.7 (9.5–9.7) |
| city-x10 · DPR 2 · 1× | deck | 3 | 16.8 (16.7–16.8) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 1.1 (1.0–1.1) | 1.4 (1.4–1.4) | 6.6 (6.3–6.7) | 9.6 (9.4–9.9) |
| city-x10 · DPR 2 · 4× | canvas | 3 | 50.0 (50.0–50.0) | 50.1 (50.1–66.6) | 72.9 (72.9–73.9) | 2.9 (2.7–2.9) | 4.1 (4.0–4.1) | 30.7 (30.2–31.0) | 37.1 (36.4–41.3) |
| city-x10 · DPR 2 · 4× | deck | 3 | 33.4 (33.4–33.4) | 33.5 (33.4–50.0) | 43.1 (42.1–44.1) | 3.6 (3.5–3.7) | 5.2 (5.1–5.3) | 9.2 (9.0–9.2) | 13.5 (13.4–13.7) |
| anim-peak · DPR 1 · 1× | canvas | 3 | 16.8 (16.7–16.8) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 1.4 (1.4–1.4) | 1.7 (1.6–1.7) | 6.9 (6.7–6.9) | 7.4 (7.1–7.4) |
| anim-peak · DPR 1 · 1× | deck | 3 | 16.7 (16.7–16.8) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 0.9 (0.9–0.9) | 1.4 (1.4–1.4) | 7.4 (6.5–7.4) | 9.9 (9.6–10.1) |
| anim-peak · DPR 1 · 4× | canvas | 3 | 33.4 (33.4–33.4) | 50.0 (33.5–50.0) | 43.8 (41.5–46.8) | 4.5 (4.5–4.8) | 5.7 (5.6–6.1) | 21.8 (21.5–21.8) | 24.5 (23.6–25.6) |
| anim-peak · DPR 1 · 4× | deck | 3 | 33.4 (33.4–33.4) | 33.4 (33.4–50.0) | 28.8 (26.4–29.8) | 3.0 (3.0–3.0) | 4.8 (4.8–5.1) | 8.5 (8.0–8.8) | 12.8 (12.5–13.1) |
| anim-peak · DPR 2 · 1× | canvas | 3 | 16.8 (16.7–16.8) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 1.3 (1.3–1.4) | 1.6 (1.5–1.6) | 9.3 (9.3–9.7) | 9.8 (9.7–10.4) |
| anim-peak · DPR 2 · 1× | deck | 3 | 16.7 (16.7–16.8) | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 0.8 (0.8–0.9) | 1.4 (1.3–1.4) | 6.6 (6.1–7.4) | 9.6 (9.6–10.1) |
| anim-peak · DPR 2 · 4× | canvas | 3 | 50.1 (50.0–50.1) | 66.7 (50.1–66.7) | 100.0 (98.7–100.0) | 4.9 (4.8–5.0) | 6.2 (6.1–6.4) | 34.0 (33.6–34.4) | 36.5 (36.1–37.8) |
| anim-peak · DPR 2 · 4× | deck | 3 | 33.4 (33.4–33.4) | 33.4 (33.4–33.5) | 32.8 (32.8–34.4) | 2.9 (2.9–2.9) | 4.7 (4.6–4.9) | 8.2 (7.8–8.5) | 12.4 (11.9–12.6) |

### Memory after the sweeps (median of reps)

| mode · renderer · DPR | reps | JS heap used, MB | DOM canvas backing stores, MB | deck gpuMemory pre-pick, MB | post-pick, MB | of which buffers, MB |
|---|---:|---:|---:|---:|---:|---:|
| origin · canvas · DPR 1 | 9 | 71.5 (71.5–71.6) | 2.5 (1 canvases) | n/a | n/a | n/a |
| origin · canvas · DPR 2 | 9 | 71.6 (71.5–71.7) | 10.0 (1 canvases) | n/a | n/a | n/a |
| origin · deck · DPR 1 | 9 | 93.5 (92.5–93.6) | 5.2 (2 canvases) | 6.3 | 6.3 | 3.1 |
| origin · deck · DPR 2 | 9 | 93.7 (93.4–93.8) | 20.6 (2 canvases) | 16.0 | 16.0 | 3.1 |
| both · deck · DPR 1 | 9 | 96.2 (96.0–96.7) | 5.2 (2 canvases) | 8.9 | 8.9 | 5.6 |
| both · deck · DPR 2 | 9 | 96.0 (95.5–96.7) | 20.6 (2 canvases) | 18.6 | 18.6 | 5.7 |
| trains · deck · DPR 1 | 9 | 86.1 (85.3–86.5) | 5.2 (2 canvases) | 5.2 | 5.2 | 2.0 |
| trains · deck · DPR 2 | 9 | 85.9 (85.3–86.4) | 20.6 (2 canvases) | 14.9 | 14.9 | 2.0 |

### Origin switch (广州→北京→上海→广州; long tasks in the 2 s after `__selectOrigin`; median over cities × reps; ms)

| scenario | renderer | switches | long-task total | longest task | longest rAF gap |
|---|---:|---:|---:|---:|---:|
| DPR 1 · 1× | canvas | 9 | 55 (0–83) | 55 (0–83) | 67 (50–83) |
| DPR 1 · 1× | deck | 9 | 146 (58–198) | 74 (58–95) | 83 (83–117) |
| DPR 1 · 4× | canvas | 9 | 588 (503–826) | 216 (181–290) | 367 (317–417) |
| DPR 1 · 4× | deck | 9 | 668 (601–1040) | 282 (217–387) | 383 (367–483) |
| DPR 2 · 1× | canvas | 9 | 68 (52–105) | 55 (52–72) | 67 (67–100) |
| DPR 2 · 1× | deck | 9 | 160 (63–210) | 73 (60–97) | 100 (67–133) |
| DPR 2 · 4× | canvas | 9 | 589 (496–689) | 209 (185–292) | 367 (350–417) |
| DPR 2 · 4× | deck | 9 | 684 (621–1057) | 285 (224–382) | 400 (367–483) |

### National mode (deck only; 18:15 sweep 1095→1155, 300 frames; median of reps; ms)

| scenario | reps | rAF p95 | dropped % | JS draw p95 | draw+raster p95 | deck cpuTimePerFrame | dots | sections | JS heap MB | gpuMemory post-pick MB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A+B · origin-initial · DPR 1 · 1× | 3 | 16.8 (16.7–16.8) | 0.0 (0.0–0.0) | 3.2 (3.0–3.3) | 12.7 (10.5–13.4) | 1.65 (1.60–1.71) | 3601 | 9049 | 96.1 | 5.6 |
| A+B · origin-initial · DPR 1 · 4× | 3 | 16.7 (16.7–33.3) | 0.3 (0.3–8.4) | 9.4 (9.2–11.5) | 16.8 (16.7–17.4) | 4.25 (4.18–4.49) | 3601 | 9049 | 95.5 | 5.6 |
| A+B · origin-initial · DPR 2 · 1× | 3 | 16.8 (16.7–16.8) | 0.0 (0.0–0.0) | 3.2 (3.1–3.2) | 12.3 (9.7–12.8) | 1.61 (1.54–1.67) | 3601 | 9049 | 95.9 | 5.6 |
| A+B · origin-initial · DPR 2 · 4× | 3 | 16.8 (16.7–33.3) | 0.7 (0.0–5.4) | 9.8 (9.4–10.5) | 17.9 (15.6–18.2) | 4.41 (4.30–5.43) | 3601 | 9049 | 95.4 | 5.6 |
| A+B · national-fit · DPR 1 · 1× | 3 | 16.8 (16.7–16.8) | 0.0 (0.0–0.0) | 2.9 (2.9–3.0) | 12.1 (10.7–13.1) | 1.39 (1.33–1.53) | 3601 | 9049 | 96.2 | 8.9 |
| A+B · national-fit · DPR 1 · 4× | 3 | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 8.8 (8.1–8.9) | 15.8 (15.3–16.2) | 3.49 (3.48–3.67) | 3601 | 9049 | 96.1 | 8.9 |
| A+B · national-fit · DPR 2 · 1× | 3 | 16.7 (16.7–16.8) | 0.0 (0.0–0.0) | 2.9 (2.9–3.1) | 11.1 (10.7–13.1) | 1.46 (1.42–1.54) | 3601 | 9049 | 96.0 | 18.6 |
| A+B · national-fit · DPR 2 · 4× | 3 | 16.7 (16.7–16.8) | 0.0 (0.0–0.3) | 8.6 (8.6–9.7) | 16.6 (16.3–17.8) | 3.76 (3.69–4.54) | 3601 | 9049 | 95.9 | 18.6 |
| A+B · city-x10 · DPR 1 · 1× | 3 | 16.8 (16.7–16.8) | 0.0 (0.0–0.0) | 3.1 (3.1–3.2) | 10.9 (10.4–11.6) | 1.77 (1.70–1.81) | 3601 | 9049 | 96.7 | 8.9 |
| A+B · city-x10 · DPR 1 · 4× | 3 | 16.8 (16.8–16.8) | 1.3 (1.0–1.3) | 10.0 (9.9–10.2) | 16.5 (16.5–16.7) | 4.89 (4.76–5.01) | 3601 | 9049 | 96.0 | 8.9 |
| A+B · city-x10 · DPR 2 · 1× | 3 | 16.8 (16.7–16.8) | 0.0 (0.0–0.0) | 3.2 (3.1–3.4) | 12.3 (11.6–13.6) | 1.78 (1.71–1.80) | 3601 | 9049 | 96.5 | 18.6 |
| A+B · city-x10 · DPR 2 · 4× | 3 | 33.3 (16.8–33.3) | 5.7 (1.3–10.7) | 10.9 (10.1–10.9) | 16.6 (16.3–18.3) | 5.00 (4.87–5.87) | 3601 | 9049 | 95.8 | 18.6 |
| A · origin-initial · DPR 1 · 1× | 3 | 16.8 (16.7–16.8) | 0.0 (0.0–0.0) | 2.4 (2.3–2.6) | 9.4 (9.2–9.4) | 0.90 (0.83–0.99) | 3601 | 0 | 86.0 | 2.0 |
| A · origin-initial · DPR 1 · 4× | 3 | 16.7 (16.7–16.8) | 0.0 (0.0–0.0) | 6.3 (6.1–7.4) | 12.8 (12.3–12.8) | 1.78 (1.67–1.83) | 3601 | 0 | 86.0 | 2.0 |
| A · origin-initial · DPR 2 · 1× | 3 | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 2.4 (2.2–2.6) | 11.8 (11.5–12.0) | 0.93 (0.90–0.98) | 3601 | 0 | 85.7 | 2.0 |
| A · origin-initial · DPR 2 · 4× | 3 | 16.8 (16.7–16.8) | 0.0 (0.0–0.0) | 6.8 (6.8–7.9) | 13.9 (13.9–16.7) | 2.15 (1.97–2.35) | 3601 | 0 | 85.6 | 2.0 |
| A · national-fit · DPR 1 · 1× | 3 | 16.7 (16.7–16.8) | 0.0 (0.0–0.0) | 2.4 (2.2–2.5) | 11.2 (10.9–11.9) | 0.83 (0.79–0.84) | 3601 | 0 | 86.2 | 5.2 |
| A · national-fit · DPR 1 · 4× | 3 | 16.7 (16.7–16.8) | 0.0 (0.0–0.0) | 5.9 (5.9–6.4) | 13.7 (13.2–14.7) | 1.47 (1.41–2.05) | 3601 | 0 | 85.9 | 5.2 |
| A · national-fit · DPR 2 · 1× | 3 | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 2.3 (2.2–2.4) | 12.6 (12.3–13.1) | 0.89 (0.89–0.91) | 3601 | 0 | 85.9 | 14.9 |
| A · national-fit · DPR 2 · 4× | 3 | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 6.7 (6.1–7.9) | 15.4 (15.2–17.6) | 2.07 (1.76–3.64) | 3601 | 0 | 85.8 | 14.9 |
| A · city-x10 · DPR 1 · 1× | 3 | 16.7 (16.7–16.8) | 0.0 (0.0–0.0) | 2.3 (2.2–2.3) | 7.4 (7.2–7.4) | 0.85 (0.83–0.92) | 3601 | 0 | 86.4 | 5.2 |
| A · city-x10 · DPR 1 · 4× | 3 | 16.8 (16.7–16.8) | 0.0 (0.0–0.0) | 6.1 (6.1–6.8) | 10.6 (10.1–11.2) | 1.76 (1.63–2.06) | 3601 | 0 | 86.3 | 5.2 |
| A · city-x10 · DPR 2 · 1× | 3 | 16.8 (16.8–16.8) | 0.0 (0.0–0.0) | 2.3 (2.2–2.3) | 8.8 (8.8–8.9) | 0.87 (0.81–0.88) | 3601 | 0 | 86.1 | 14.9 |
| A · city-x10 · DPR 2 · 4× | 3 | 16.7 (16.7–16.8) | 0.0 (0.0–0.0) | 6.6 (6.4–8.3) | 11.6 (11.2–14.1) | 1.97 (1.78–3.50) | 3601 | 0 | 86.2 | 14.9 |

### Load: first paint and map ready (median of reps; ms, KB transferred as the Resource Timing API reports it)

| scenario | build | reps | cold FCP | cold map ready | cold first deck frame | KB before ready | KB total | warm map ready |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| localhost · DPR 1 · 1× | canvas | 3 | 320 (312–792) | 1149 (1060–1334) | – | 3503 | 3503 | 97 (88–98) |
| localhost · DPR 1 · 1× | deck | 3 | 316 (308–1884) | 406 (404–4345) | 546 (546–4355) | 2403 | 4278 | 130 (128–140) |
| localhost · DPR 1 · 4× | canvas | 3 | 496 (480–500) | 2270 (2003–2285) | – | 3503 | 3503 | 363 (350–366) |
| localhost · DPR 1 · 4× | deck | 3 | 492 (476–500) | 909 (851–921) | 2091 (1955–2186) | 2403 | 4278 | 752 (458–921) |
| localhost · DPR 2 · 1× | canvas | 3 | 332 (320–340) | 891 (880–893) | – | 3503 | 3503 | 100 (97–102) |
| localhost · DPR 2 · 1× | deck | 3 | 308 (308–312) | 398 (388–405) | 526 (490–554) | 1873 | 4278 | 131 (119–146) |
| localhost · DPR 2 · 4× | canvas | 3 | 484 (484–496) | 2284 (2279–2313) | – | 3503 | 3503 | 362 (359–402) |
| localhost · DPR 2 · 4× | deck | 3 | 492 (464–540) | 899 (848–975) | 2085 (2041–2205) | 2403 | 4278 | 656 (609–745) |
| slow4g · DPR 1 · 1× | canvas | 3 | 1304 (1280–1984) | 9939 (9913–10593) | – | 1495 | 1496 | 264 (262–269) |
| slow4g · DPR 1 · 1× | deck | 3 | 1336 (1328–1664) | 11932 (11880–12252) | 11939 (11939–12318) | 1873 | 1874 | 298 (296–298) |
| slow4g · DPR 1 · 4× | canvas | 3 | 1456 (1456–1460) | 10213 (10191–10218) | – | 1495 | 1496 | 476 (475–482) |
| slow4g · DPR 1 · 4× | deck | 3 | 1476 (1476–1476) | 12150 (12150–12154) | 12340 (12338–12346) | 1873 | 1874 | 566 (560–668) |

### Runs

| file | label | mode | renderer | reps | frames | duration s | load avg at end | started |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| canvas-frames.json | canvas | origin | ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version) | 3 | 300 | 669 | 3.17 / 3.72 / 4.05 | 2026-10-26T08:27:56.987Z |
| canvas-load-localhost.json | canvas | origin |  | 3 | 300 | 66 | 4.73 / 3.9 / 3.73 | 2026-10-26T09:05:54.390Z |
| canvas-load-slow4g.json | canvas | origin |  | 3 | 300 | 92 | 3.63 / 3.89 / 3.76 | 2026-10-26T09:08:26.775Z |
| deck-frames.json | deck | origin | ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version) | 3 | 300 | 672 | 3.59 / 3.18 / 3.46 | 2026-10-26T08:39:06.280Z |
| deck-load-localhost.json | deck | origin |  | 3 | 300 | 85 | 3.65 / 3.85 / 3.73 | 2026-10-26T09:07:01.390Z |
| deck-load-slow4g.json | deck | origin |  | 3 | 300 | 104 | 2.44 / 3.35 / 3.56 | 2026-10-26T09:09:58.673Z |
| deck-national-both.json | deck | both | ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version) | 3 | 300 | 478 | 4.8 / 3.79 / 3.68 | 2026-10-26T08:57:56.481Z |
| deck-national-trains.json | deck | trains | ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version) | 3 | 300 | 458 | 4.52 / 3.89 / 3.71 | 2026-10-26T08:50:18.211Z |

Machine: Apple M4 Max (14 cores, 36 GB), Darwin 25.6.0; Chrome/155.0.8059.85; node v22.23.0.

