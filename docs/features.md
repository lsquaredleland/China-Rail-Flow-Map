# Proposed Features Roadmap

This document tracks potential features to explore for the **China Rail Flow Map**, organized by whether they can be built directly on top of the existing v2 frontend bundles (`web/src/types.ts`) or involve extending the Rust data pipeline (`pipeline/`).

---

## Status (2026-10-27)

✅ done · ◐ partial · ❌ not started

| # | Feature | Scope | Status | Notes |
|---|---|---|---|---|
| 1a | Single-train route inspector | Frontend-only | ✅ | click a train (table row or map dot): its whole run isolated on the map, timetable with calling stations, "Play from origin", map card; hovering a section shows its trains/day |
| 1b | Section → trains filter ("which trains cross this bridge?") | Frontend-only | ❌ | click a section to filter the table to the trains on it |
| 2 | Map-Coupled Histograms & Multi-Filter Flow Rendering | Frontend-only | ✅ | |
| 3a | Travel-time shading of destinations | Frontend-only | ✅ | destination dots coloured by fastest time (under 4 h / 4–12 h / over 12 h), with the legend's time bar |
| 3b | Corridor shading, speed & circuity modes, isochrone rings | Frontend-only | ❌ | |
| 4 | Intra-City Station Terminal Filter | Frontend-only | ◐ | per-station departure counts show above the table; no station filter yet |
| 5 | Two-City Comparison / "Sphere of Influence" View | Frontend-only | ❌ | |
| 6 | 1-Transfer Connection Finder (`Origin → Hub → Destination`) | Frontend-only | ❌ | |
| 7 | Interactive Marey Stringline Diagram (Time × Distance Graph) | Pipeline + Frontend | ❌ | |
| 8 | National All-Trains Backbone Map ("No Origin Selected" Overview) | Pipeline + Frontend | ✅ | national mode (`docs/history/DECKGL_MIGRATION.md`, Phases 2–3) |

---

## 1. Frontend-Only Features (Data Already Loaded in Browser)

### 1. Corridor & Single-Train Route Inspector
- **Status:** The single-train half is built (1a): clicking a train in the table or on the map isolates its whole run, opens its timetable with "Play from origin", and a minimised map card keeps the state; hovering any section shows its trains per day. The section-click → table filter (1b) is not built.
- **Data Available:** Every departure (`DepVM.secs`) and arrival (`ArrVM.secs`) already carries the exact array of track section indices it traverses, and the map already hit-tests individual track sections (`{ kind: "seg", s, n }` in `Hit`).
- **Description:**
  - **Hover/click a train in `DeparturesTable`** to trace that single train's exact path on the map, highlighting all its calling cities and showing its commercial speed (`km / duration`).
  - **Click any track section on the map** to filter the timetable to only the trains running over that specific piece of track (answering *"Which trains cross this bridge or mountain pass?"*).

### 2. Map-Coupled Histograms & Multi-Filter Flow Rendering ✅ *(Completed)*
- **Status:** **Completed**
- **Data Available:** Clicking a bar in `Histograms` (hour of day, distance bin, or duration bin) currently filters only `DeparturesTable`, while `App.tsx` only recomputes map flows for train-class filters (`selectedClasses`). Because `DepVM.secs` and `ArrVM.secs` hold per-train section lists, `App.tsx` can recompute section flows (`FlowVM[]`) and destination/source aggregates (`DestVM[]` / `SrcVM[]`) across any combination of active histogram filters.
- **Description:**
  - Lift histogram filter state (`selectedHour`, `selectedDistBin`, `selectedDurBin`) so that selecting any combination of hour, distance bracket, duration bracket, and train class dynamically updates **both** the map's proportional flow bands and the `Histograms` cross-filtered overlays.
  - Optional time-of-day scrubber / multi-bar selection for watching overnight `Z`/`T`/`K` sleeper corridors vs. morning HSR waves.
- **UX / Design Notes:**
  - **Mobile UX consideration:** On mobile viewports, the histograms sit below the map above the departures table, so scrolling back and forth between the histogram bars and the map canvas can feel clunky. When implementing, consider a compact floating filter pill/summary bar on the map (or sticky mini-controls) so mobile users can see and clear active histogram filters without losing sight of the map.

### 3. Isochrone / Travel-Time & Speed Shading Mode
- **Status:** Partly built (3a): destination dots are coloured by fastest travel time in three bands (under 4 h, 4–12 h, over 12 h; `TIME_BANDS` in `web/src/lib/palette.ts`) with a matching time bar in the legend. Corridor colouring, the speed and circuity modes and isochrone rings (3b) are not built.
- **Data Available:** Every destination/source city (`CityPointVM`) carries `fastest` (minutes), `median` (minutes), `crow` (straight-line km), and `rail` (routed track km).
- **Description:**
  - A map color mode toggle that colors destination dots and corridors by **fastest travel time** (`<1h`, `1–2h`, `2–4h`, `4–8h`, `8h+` isochrone rings), **average commercial speed** (`rail / fastest`), or **track circuity** (`rail / crow`, highlighting where terrain forces detours vs. straight HSR viaducts).

### 4. Intra-City Station Terminal Filter (e.g., Beijing South vs. West vs. Chaoyang)
- **Status:** Partly built. The departures table shows how many trains leave from each of the city's stations; filtering the map and table by station is not built.
- **Data Available:** `DepVM` (`fsZh`/`fsEn`) and `ArrVM` (`tsZh`/`tsEn`) preserve the exact boarding/alighting station within the selected city.
- **Description:**
  - A station chip bar when a multi-station hub is selected (such as Shanghai, Beijing, Guangzhou, Wuhan, or Chengdu), letting users isolate the directional flow footprint of each individual railway terminal on the map.

### 5. Two-City Comparison / "Sphere of Influence" View
- **Status:** Proposed
- **Data Available:** All 102 origins are loaded into memory in Phase 1 (`OutMapData`).
- **Description:**
  - A "Compare with…" picker that overlays two origins in contrasting colors (e.g., Chengdu vs. Chongqing, or Beijing vs. Shanghai) to visualize overlapping corridors and compare which third cities are faster or more frequently served from City A vs. City B.

### 6. 1-Transfer Connection Finder (`Origin → Hub → Destination`)
- **Status:** Proposed
- **Data Available:** Once tables load, all 102 cities' departure/arrival tables and intermediate calls (`CallVM`) are in memory, allowing outbound calls from City A to be joined with inbound calls to City B.
- **Description:**
  - When clicking an unreached city (or a city with few direct trains), calculate and display the best 1-transfer itineraries across the 102 origin hubs, including same-station vs. cross-city station transfers (`tsZh === bsZh`) and layover times.

---

## 2. Pipeline + Frontend Features (Extending `pipeline/` & `data/raw/`)

### 7. Interactive Marey Stringline Diagram (Time × Distance Train Graph)
- **Status:** Proposed
- **Data Available:** Full stop sequences in `data/raw/stops.jsonl` + `data/raw/stops_cs.jsonl` and routed leg distances in `pipeline/analyze`.
- **Description:**
  - When a user selects a city pair (e.g., Beijing ⇄ Shanghai), render an interactive **Marey diagram** (time on X-axis, station distance on Y-axis) showing all trains on that corridor and visualizing where high-speed `G` trains overtake stopping trains at intermediate stations.

### 8. National All-Trains Backbone Map ("No Origin Selected" Overview)
- **Status:** **Completed** as national mode ("National Beta" in the header): the pipeline emits `atlas-v2-national` (per-section totals, every train once), `-national-trains` (whole runs), `-national-entries` (section entry minutes) and `-national-index` (per-train filter facts); the client draws the flows, the growing city circles and every train on one 24h clock, with the origin view's components (`docs/history/DECKGL_MIGRATION.md`, Phases 2–3).
- **Data Available:** Shared `train_table` and `sections` in `SharedData` (`pipeline/analyze/src/bin/atlaspack.rs`).
- **Description:**
  - Deduplicate every train across all 102 origins or emit a pre-aggregated national section flow array from `atlaspack` so users can view the **entire national rail volume** at once before clicking into a specific origin city.
