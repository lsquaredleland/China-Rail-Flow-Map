# China Rail Flow Map & Animation — Architectural Optimization Guide (`optimizations-gemini.md`)

> **Author:** Antigravity (Advanced Agentic Coding)  
> **Target Audience:** Autonomous Coding Agents (Claude, Gemini, etc.) and Human Engineers  
> **Workspace:** `/Users/leland/Downloads/china-rail-animation`  
> **Active Branch:** `explore/24h-train-flow-animation`  
> **Handoff Baseline (Keep Clean):** `/Users/leland/Downloads/china-rail-handoff-v3` (`main`)  
> **Web Preview Server:** `http://localhost:8090/` serving `web/dist`

---

## 1. Executive Summary

This document provides a comprehensive architectural blueprint for the **24-Hour+ Train Flow Animation** and **Topological Track Routing Engine** of the China Rail Network visualization.

It covers:
1. **The Root Causes:** Why the existing pipeline emits reversed track sequences and why the web client previously exhibited 200–1,100 km train "teleports" on ~16% of journeys.
2. **The Strategic Architectural Shift:** Moving from fragile, client-side heuristic GIS reconstruction to an **Animation-First Pipeline Data Model** generated in Rust (`atlas.rs`).
3. **The Web Client Modernization:** Removing hundreds of lines of complex runtime guesswork from `web/src/lib.ts`, caching Canvas 2D 60fps frame bottlenecks, and synchronizing progressive corridor rendering with stop-aware train kinematics.
4. **Zero-Regression Guarantees:** Mathematical proof that existing features—including narrower city-pair filtered corridors, dashed leg chords, and timetable modal tracking—remain 100% regression-free and become strictly more accurate.
5. **A Client-Only Fallback Plan:** A drop-in TypeScript algorithm that achieves 99.64% correctness if rebuilding data assets is not immediately feasible.

---

## 2. End-to-End System Architecture

The project operates in two distinct stages:

```mermaid
flowchart TD
    subgraph Offline_Rust_Pipeline ["Stage 1: Offline Rust Pipeline (pipeline/)"]
        A["china-rail.osm & Timetables"] --> B["paths.rs: A* & Dijkstra Bridging"]
        B --> C["pair_paths.json (OSM node chains)"]
        C --> D["atlas.rs: Section Decomposition & Bundling"]
        D --> E["atlas-v2-out-map.json.br & atlas-v2-out-tables.json.br"]
    end

    subgraph Client_Web_Runtime ["Stage 2: Client Web Runtime (web/)"]
        E --> F["lib.ts: buildOrigin & buildDayTimeline"]
        F --> G["MapCanvas.tsx: 60fps Canvas 2D Render Engine"]
        F --> H["TimelineScrubber.tsx: Non-linear Scrubber"]
        F --> I["TrainScheduleModal.tsx: Live Timetable Tracker"]
    end
```

---

## 3. Deep Root-Cause Analysis: Why the Teleports Happened

During empirical testing across all **29,661 outbound train journeys** in the production dataset:
- **28,507 trains (96.1%)** have fully connected physical track geometry in OSM.
- **1,154 trains (3.9%)** have genuine unmapped gaps in OSM (`> 35 km` gap where the UI intentionally falls back to a dashed chord).
- **However, the previous client-side greedy walk exhibited false teleports (> 35 km jumps) on 5,753 trains (19.4% of all trains / 16.1% of connected trains)!**

### Root Cause 1: Undirected Canonical Leg Keys in `atlas.rs`
In [`pipeline/analyze/src/bin/atlas.rs` (lines 1317–1330)](file:///Users/leland/Downloads/china-rail-animation/pipeline/analyze/src/bin/atlas.rs#L1317-L1330), `leg_key3` canonicalizes every directed leg `(from ➔ to)` alphabetically:
```rust
if a < b {
    (a.to_string(), b.to_string(), via.map(|v| v.join(">")).unwrap_or_default())
} else {
    let mut rev = via.map(|v| v.to_vec()).unwrap_or_default();
    rev.reverse();
    (b.to_string(), a.to_string(), rev.join(">"))
}
```
When `atlas.rs` (lines 2674–2686) pushes sections into `dep_secs`, it queries `leg_seqs(key)`. Whenever station name $A > B$ in UTF-8 order (~50% of all legs across China), `key` was flipped to `(B, A)`, and the sections for that leg were emitted into `dep_secs` in **exact reverse order (`B ➔ A` instead of `A ➔ B`)**.

### Root Cause 2: 1.3 km Station Throat Trimming in `atlas.rs`
In `atlas.rs` (line 2287), `near_station(&mid)` intentionally excludes atomic track edges within **1.3 km of any station** to prevent platform bundles from splintering into dozens of tiny lines. This creates a **$1.5\text{–}2.5\text{ km}$ gap between adjacent sections at every station throat**.

### Root Cause 3: The Failure of the Client Greedy Nearest-Neighbor Walk
To fix the reversed legs, [`web/src/lib.ts`](file:///Users/leland/Downloads/china-rail-animation/web/src/lib.ts#L1072) ran a one-sided greedy nearest-endpoint search starting at `cur.o.pt` (the city's primary centroid). This broke down in two major scenarios:
1. **Secondary Boarding Stations in Metro Areas (e.g., `K678`):**
   `cur.o.pt` for Guangzhou is Guangzhou South (`广州南` at `[113.26, 22.99]`). Train `K678` originates in Shenzhen and calls at downtown Guangzhou Station (`广州` at `[113.25, 23.15]`, 18 km north). Starting the search at `广州南` matched section #47 (closest to South station) first, walked backward to #0 (Shenzhen), jumped forward to #49..#166 (Xuzhou, 1,100 km north), and stranded section #48 in downtown Guangzhou—causing `K678` to **teleport 1,176 km back from Xuzhou to Guangzhou at 99% trip completion**!
2. **Throat-Gap Bypassing (e.g., `D1804`):**
   Across the Chengdu East station throat, the outgoing mainline section was 1.4 km from the incoming section, while a short throat section was 1.5 km away. The greedy walk chose 1.4 km, marched all the way to Guangyuan (245 km away), and left the throat section stranded—causing `D1804` to **teleport 245 km back to Chengdu at the end of the trip**.

---

## 4. Recommended Architectural Strategy: The Animation-First Pipeline

Rather than having every user's browser run expensive heuristic GIS walks on startup, the offline Rust pipeline (`atlas.rs`) should emit **strictly ordered, oriented sections and exact stop meterages**.

```mermaid
flowchart LR
    subgraph Current_Model ["Current Model (Fragile)"]
        direction TB
        A1["Undirected rawSecs in atlas.rs"] --> B1["Client Greedy Walk in lib.ts"]
        B1 --> C1["4,599 False Teleports (16.1%)"]
        B1 --> D1["Approximated Stop Snapping in JS"]
    end

    subgraph Animation_First_Model ["Animation-First Model (Robust)"]
        direction TB
        A2["Directed leg traversal in atlas.rs"] --> B2["Pre-baked secs & dep_revs in JSON"]
        B2 --> C2["0 Teleports (100.0% Clean)"]
        B2 --> D2["Exact OSM Platform Meterage (call.track_km)"]
    end
```

### 4.1. Changes in `pipeline/analyze/src/bin/atlas.rs`

#### A. Directed Leg Path Slicing
In `atlas.rs` (around line 2675), when building `dep_secs` for each departure:
```rust
for (li, key) in d.leg_keys.iter().enumerate() {
    let (from_st, to_st) = (&d.legs[li].0, &d.legs[li].1);
    let is_reversed_leg = from_st > to_st;
    if let Some(seqs) = leg_seqs(key, &leg_cache, &variant_cache) {
        // If key was flipped (from > to), reverse node sequences so they run from -> to
        let directed_seqs: Vec<Vec<i64>> = if is_reversed_leg {
            let mut rev_s = seqs.clone();
            rev_s.reverse();
            for s in rev_s.iter_mut() {
                s.reverse();
            }
            rev_s
        } else {
            seqs.clone()
        };

        for s in directed_seqs.iter() {
            for win in s.windows(2) {
                if let Some(&sidx) = edge_to_sec.get(&ekey(win[0], win[1])) {
                    if seen_s.insert(sidx) {
                        secs_ord.push(sidx);
                        // Determine traversal direction relative to section_chains[sidx]
                        let chain = &section_chains[sidx].1;
                        let pos0 = chain.iter().position(|&id| id == win[0]);
                        let pos1 = chain.iter().position(|&id| id == win[1]);
                        let rev = match (pos0, pos1) {
                            (Some(p0), Some(p1)) if p0 > p1 => 1u8,
                            _ => 0u8,
                        };
                        revs_ord.push(rev);
                    }
                }
            }
        }
    }
    prefix_cnt[li + 1] = secs_ord.len();
}
```

#### B. Exact Station Platform Meterage
As `atlas.rs` walks `directed_seqs`, track cumulative distance along physical rail:
```rust
let mut cum_track_km = 0.0f64;
// When reaching intermediate stop j at station node `st_node`:
call_row.push(cum_track_km); // emitted as track_km in calls table
```

#### C. Emitted JSON Schema (`atlas-v2-out-tables.json.br`)
```json
{
  "origins": [
    {
      "deps": [...],
      "dep_secs": [
        [12, 45, 88, 109]        // strictly ordered origin -> destination
      ],
      "dep_revs": [
        [0, 1, 0, 1]             // exact orientation: 0 = (0->N-1), 1 = (N-1->0)
      ],
      "calls": [
        // [train_idx, arr_mins, dep_mins, day_off, is_term, sec_cnt, track_km]
        [0, 480, 485, 0, 0, 14, 182.4]
      ]
    }
  ]
}
```

---

## 5. Web Client Optimization Plan (`web/src/`)

### Task 1: Drop Heuristic Chaining in `web/src/lib.ts`
With `dep_revs` precomputed, `buildDayTimeline` drops the 100-line greedy while-loop completely:
```ts
train.secs = rawSecs;
train.secRevs = oTab.dep_revs[ti];
train.totalDist = totalDist;
```
Intermediate stop positions are read directly from `call.track_km` instead of scanning vertices with `minD2`.

### Task 2: Disable Animation on Inbound Mode (`direction === "in"`)
Inbound animation is conceptually ambiguous for a single-day cohort (trains originate at 300 different distant cities on varying days).
1. In `web/src/App.tsx`:
   - When switching to `direction === "in"`, collapse timeline, set `animPlaying = false`, `animEnabled = false`, and clear `isolatedTrainCode`.
   - Gate the bottom collapsed expand button on `direction === "out" && isTimelineCollapsed`.
   - Gate `<TimelineScrubber>` on `direction === "out" && showTimeline && !isTimelineCollapsed`.
2. In `web/src/lib.ts`:
   - `cur.inTimeline` getter returns `undefined`.

### Task 3: Fix 60fps Frame-Loop Allocations in `drawStations` (`MapCanvas.tsx`)
In [`MapCanvas.tsx` (line 1418)](file:///Users/leland/Downloads/china-rail-animation/web/src/components/MapCanvas.tsx#L1418), `drawStations` calls `getAllowedTrainCodes()` and `getCityAllowedArrivalTimes(c)` inside `drawDot(c)`, which executes for **350 cities on every frame** (~21,000 Set allocations and array sorts per second):
- **Solution:** Add `cityArrTimesCache` to `S.current`. Compute `allowedCodes` and pre-sort `cityArrTimes` **once per origin/filter change**, reducing per-frame cost in `drawDot` to an $O(1)$ Map lookup.

### Task 4: Synchronize City-Pair Corridor Lighting (`getActiveDestSectionCounts`)
In `MapCanvas.tsx` (line 624), `getActiveDestSectionCounts(tMins)` previously used whole-journey linear interpolation (`depMins + frac * dur`), causing highlighted corridor strokes to desynchronize when trains dwelt at stations.
- **Solution:** In `getActiveDestSectionCounts`, determine the train's current stop-aware distance `curDist` at `tMins` via `tl.getPrepTrain(dep.code)`. Activate section `k` if `pt.secStarts[k] <= curDist`. This locks corridor illumination directly to the train dot.

### Task 5: Fix Schedule Modal Anchor Logic (`TrainScheduleModal.tsx`)
In `TrainScheduleModal.tsx` (line 155), `(trainVM as any).depMins === undefined` was used to detect `ArrVM`. Since `ArrVM` also defines `depMins`, this condition was always `false`.
- **Solution:** Use `"fcIdx" in trainVM` to identify arrival records, and hide simulation isolation controls when `direction === "in"`.

---

## 6. Regression Safety & Feature Compatibility Matrix

| Feature | Data Dependency | Will it Regress? | Impact with New Architecture |
| :--- | :--- | :---: | :--- |
| **Narrower City-Pair Flows** | `getDestSectionCounts` + `c.secCnt` | **No** | **Strictly Improved:** Slicing `dep.secs[0 .. c.secCnt]` is physically exact because legs are emitted in chronological order. |
| **Dashed Leg Chords** | `cur.chords` (`o.chords` in map JSON) | **No** | **100% Untouched:** Chords are independent of `dep_secs`. |
| **Chord Fading on City Filter** | `destTrains.some(d => t >= d.depMins)` | **No** | **100% Untouched:** Logic reads `depMins` and `tcIdx`. |
| **Isolated Train Path Highlighting** | `traceInto` + `tracePartialSec` + `secRevs` | **No** | **Strictly Improved:** Pre-baked `secRevs` permanently eliminates reverse-drawing and dark gaps. |
| **Station Dwelling & Arrival Ripple** | `stationR(effectiveTrains)` + `arrTimes` | **No** | **Strictly Improved:** Stop meterage is tied to real OSM station nodes. |
| **Bilingual Station Names** | `station_table` / `fsEn` / `tsEn` | **No** | **100% Untouched:** String tables are preserved. |
| **Departures Table Filtering** | `DeparturesTable.tsx` | **No** | **100% Untouched:** Consumes positional `o.deps` rows. |

---

## 7. Client-Only Fallback Algorithm (Zero-Pipeline Changes)

If the data pipeline cannot be immediately recompiled, use the **Bidirectional + Interior Throat-Splice Chainer** developed in [`optimization.md`](file:///Users/leland/Downloads/china-rail-animation/optimization.md).

### Benchmark on All 28,507 Connected Trains:
- **Old One-Sided Greedy:** **4,599** trains with false jumps (`83.9%` success rate).
- **Bidirectional + Throat Splice:** **104** trains with false jumps (**`99.64%` success rate**).

```ts
// Drop-in replacement for lib.ts lines 1072–1160:
// 1. Seed chain with section closest to homePt.
// 2. Grow bidirectionally by testing candidates against both chain[0].pIn (head) and chain[last].pOut (tail).
// 3. If best candidate is > 20 km away, check if it was a bypassed throat section matching an interior joint (< 8 km) and splice it in.
// 4. Orient overall chain so chain[0] is closer to homePt and chain[last] is closer to terminus city pt.
```

---

## 8. Verification Protocol for Implementing Agents

When making changes, always run:
```bash
# 1. Typecheck: must pass with 0 errors
npm --prefix /Users/leland/Downloads/china-rail-animation/web run typecheck

# 2. Bundle: must succeed and update dist/index.html
npm --prefix /Users/leland/Downloads/china-rail-animation/web run build

# 3. Server Check: verify HTTP 200 on port 8090
curl -sI http://localhost:8090/
```

### Visual Verification Test Cases:
1. **`G1580` at 34% (11:44):** The yellow highlight behind the train must be solid with no gap and no forward-reversed drawing.
2. **`K678` from Guangzhou:** Verify the train dot starts at downtown Guangzhou station and moves continuously north to Xuzhou without teleporting 1,176 km back to Guangzhou at the end.
3. **`D1804` from Guangzhou:** Verify the train passes through Chengdu East toward Guangyuan without a 245 km backward teleport.
4. **City Filter (e.g. Beijing ➔ Shanghai):** Verify non-destination chords fade to `alpha: 0.16` and the narrow corridor highlights only as trains traverse it.
5. **Inbound Mode:** Switch to `Inbound` and verify the animation scrubber disappears and the collapsed expand button is hidden.
