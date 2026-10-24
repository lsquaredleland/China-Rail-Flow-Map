# China Rail 24h Flow Animation — Routing & Animation Optimization Plan (`optimization.md`)

## 0. Context & Repository Layout
- **Active Repository:** `/Users/leland/Downloads/china-rail-animation`
- **Branch:** `explore/24h-train-flow-animation`
- **Handoff Repository (Keep Clean):** `/Users/leland/Downloads/china-rail-handoff-v3`
- **Preview Server:** `http://localhost:8090/` serving `/Users/leland/Downloads/china-rail-animation/web/dist`
- **Build & Typecheck Commands:**
  ```bash
  npm --prefix /Users/leland/Downloads/china-rail-animation/web run typecheck
  npm --prefix /Users/leland/Downloads/china-rail-animation/web run build
  ```

---

## 1. Executive Summary of Goals
1. **Disable Animation for Inbound Mode (`direction === "in"`):**
   - Only Outbound (`direction === "out"`) supports the 24-hour single-day cohort animation.
   - When switching to Inbound (`"in"`), automatically pause/disable animation, collapse the timeline bar, and hide the `[ ● 24h Flow Animation · Expand ▴ ]` button.
   - Skip building `inTimeline` in `lib.ts` to save memory and CPU.
2. **Upgrade Route Chaining Algorithm in `web/src/lib.ts` (Bidirectional + Interior Throat-Splice Chainer):**
   - Replace the one-sided greedy walk from `cur.o.pt` (which causes >35 km false teleports on 4,599 / 16.1% of connected trains, such as `K678` jumping 1,176 km and `D1804` jumping 245 km) with the **Bidirectional + Interior Throat-Splice Chainer**.
   - Reduces false jumps from 4,599 down to 104 (**99.64% clean across all 28,507 connected trains**).
   - Preserve raw `dep.rawSecs` so static city-pair `call.secCnt` slicing in `getDestSectionCounts` is never corrupted by global section reordering.
3. **Fix Per-Frame Allocation & Sorting Bottleneck in `drawStations` (`web/src/components/MapCanvas.tsx`):**
   - Hoist `const allowedCodes = getAllowedTrainCodes()` outside `drawDot(c)` so it runs **once per frame** instead of 350 times per frame.
   - Cache `getCityAllowedArrivalTimes(c, allowedCodes)` per `(cur, panelDest, isolatedTrainCode, direction)` instead of rebuilding and `.sort()`ing arrays 350 times per frame at 60 FPS.
4. **Synchronize `getActiveDestSectionCounts` with Stop-Aware Leg Kinematics (`web/src/components/MapCanvas.tsx`):**
   - Currently, `getActiveDestSectionCounts(tMins)` uses naive linear whole-journey interpolation (`depMins + (distBefore / totalDist) * dur`), ignoring intermediate station dwells and leg speed variations.
   - Update it to use `timeline.getPrepTrain(dep.code)` and the exact stop-aware `tEnter` calculation used by `secFlowSteps` in `lib.ts` (lines 1268–1290), so progressive corridor lines in City-Pair Filter Mode stay locked to the dwelling/accelerating train dots.
5. **Eliminate Redundant `getActiveTrains` Call in `getAnimState` (`web/src/components/MapCanvas.tsx`):**
   - In `getAnimState()` (lines 1948–1972), when `allowedCodes` is active, compute `depCount` and `arrCount` directly by looking up `tl.getPrepTrain(code)` (`pt.depMins <= t` and `pt.arrMins <= t`) in $O(K)$ instead of calling `tl.getActiveTrains(t)` a second time per frame.
6. **Fix `TrainScheduleModal.tsx` Inbound / Pass-Through Anchor Logic:**
   - In `web/src/components/TrainScheduleModal.tsx` (line 155), replace `(trainVM as any).depMins === undefined` (which is always `false` because `ArrVM` also defines `depMins`) with `"fcIdx" in trainVM` so `ArrVM` vs `DepVM` is properly distinguished.

---

## 2. Detailed Implementation Specifications

### Task A: Disable Animation on Inbound Mode (`web/src/App.tsx`, `web/src/components/MapCanvas.tsx`, `web/src/lib.ts`)

1. **`web/src/App.tsx`:**
   - When `direction` changes to `"in"` (in the `useEffect` or direction toggle handler), ensure:
     ```ts
     if (direction === "in") {
       setIsTimelineCollapsed(true);
       mapRef.current?.setPlaying?.(false);
       mapRef.current?.setAnimEnabled?.(false);
     }
     ```
   - Around line 1126, gate the collapsed expand button on `direction === "out"`:
     ```tsx
     {direction === "out" && isTimelineCollapsed && (
       ...
     )}
     ```
   - Around line 1179, gate `<TimelineScrubber>` on `direction === "out"`:
     ```tsx
     {direction === "out" && showTimeline && !isTimelineCollapsed && (
       <TimelineScrubber ... />
     )}
     ```

2. **`web/src/components/TrainScheduleModal.tsx`:**
   - Only show the "Isolate on Map" / live simulation jump controls when `direction !== "in"`.

---

### Task B: Bidirectional + Interior Throat-Splice Route Chainer (`web/src/lib.ts`)

#### Root Cause Recap
- `atlas.rs` canonicalizes leg keys `(a, b)` into `(min(a, b), max(a, b))`, emitting ~50% of legs in reverse section order (`b -> a`).
- `atlas.rs` also trims edges within 1.3 km of station throats (`near_station`), creating 1.5–2.5 km gaps at stations.
- Starting a one-sided greedy walk at `cur.o.pt` (city centroid, e.g. Guangzhou South) on a train that boards at a secondary station (e.g. Guangzhou Station on `K678`) starts at section #47 in the middle of the metro area, walks backward to #0, jumps to #49..#166 (Xuzhou), and strands #48 until the end of the array (causing a 1,176 km teleport at 99% progress).
- Similarly, at station throats (e.g. Chengdu East on `D1804`), a 1.5 km throat section is bypassed in favor of a 1.4 km outgoing section, stranding the throat section until the end of the journey (causing a 245 km backward teleport).

#### Exact Replacement Algorithm for `buildDayTimeline` (`web/src/lib.ts` lines 1071–1169)
```ts
    if (rawSecs.length > 0 && isOut) {
      interface ChainItem {
        s: number;
        rev: number;
        pInLon: number;
        pInLat: number;
        pOutLon: number;
        pOutLat: number;
      }
      const remaining = rawSecs.slice();
      const homeLon = cur.o.pt[0];
      const homeLat = cur.o.pt[1];

      // 1. Seed with the section endpoint closest to homePt
      let bestStart = 0;
      let bestStartD2 = 1e18;
      let bestStartRev = 0;
      for (let i = 0; i < remaining.length; i++) {
        const s = remaining[i];
        const off = secSet.off[s];
        const cnt = secSet.len[s];
        if (cnt <= 0) continue;
        const p0Lon = secSet.pts[off];
        const p0Lat = secSet.pts[off + 1];
        const p1Lon = secSet.pts[off + (cnt - 1) * 2];
        const p1Lat = secSet.pts[off + (cnt - 1) * 2 + 1];
        const d0 = (p0Lon - homeLon) ** 2 + (p0Lat - homeLat) ** 2;
        const d1 = (p1Lon - homeLon) ** 2 + (p1Lat - homeLat) ** 2;
        if (d0 < bestStartD2) {
          bestStartD2 = d0;
          bestStart = i;
          bestStartRev = 0;
        }
        if (d1 < bestStartD2) {
          bestStartD2 = d1;
          bestStart = i;
          bestStartRev = 1;
        }
      }

      const s0 = remaining.splice(bestStart, 1)[0];
      const off0 = secSet.off[s0];
      const cnt0 = secSet.len[s0];
      const s0p0Lon = cnt0 > 0 ? secSet.pts[off0] : homeLon;
      const s0p0Lat = cnt0 > 0 ? secSet.pts[off0 + 1] : homeLat;
      const s0p1Lon = cnt0 > 0 ? secSet.pts[off0 + (cnt0 - 1) * 2] : homeLon;
      const s0p1Lat = cnt0 > 0 ? secSet.pts[off0 + (cnt0 - 1) * 2 + 1] : homeLat;

      const chain: ChainItem[] = [
        {
          s: s0,
          rev: bestStartRev,
          pInLon: bestStartRev === 0 ? s0p0Lon : s0p1Lon,
          pInLat: bestStartRev === 0 ? s0p0Lat : s0p1Lat,
          pOutLon: bestStartRev === 0 ? s0p1Lon : s0p0Lon,
          pOutLat: bestStartRev === 0 ? s0p1Lat : s0p0Lat,
        },
      ];

      // 2. Grow chain bidirectionally (attach to head or tail) + splice bypassed throat sections
      while (remaining.length > 0) {
        const headInLon = chain[0].pInLon;
        const headInLat = chain[0].pInLat;
        const tailOutLon = chain[chain.length - 1].pOutLon;
        const tailOutLat = chain[chain.length - 1].pOutLat;

        let bestI = 0;
        let bestD2 = 1e18;
        let bestEnd: "tail" | "head" = "tail";
        let bestRev = 0;

        for (let i = 0; i < remaining.length; i++) {
          const s = remaining[i];
          const off = secSet.off[s];
          const cnt = secSet.len[s];
          if (cnt <= 0) continue;
          const p0Lon = secSet.pts[off];
          const p0Lat = secSet.pts[off + 1];
          const p1Lon = secSet.pts[off + (cnt - 1) * 2];
          const p1Lat = secSet.pts[off + (cnt - 1) * 2 + 1];

          // Candidate attach to tailOut (pIn = p0 -> rev=0, pIn = p1 -> rev=1)
          const dt0 = (p0Lon - tailOutLon) ** 2 + (p0Lat - tailOutLat) ** 2;
          const dt1 = (p1Lon - tailOutLon) ** 2 + (p1Lat - tailOutLat) ** 2;
          if (dt0 < bestD2) {
            bestD2 = dt0;
            bestI = i;
            bestEnd = "tail";
            bestRev = 0;
          }
          if (dt1 < bestD2) {
            bestD2 = dt1;
            bestI = i;
            bestEnd = "tail";
            bestRev = 1;
          }

          // Candidate attach to headIn (pOut = p1 -> rev=0, pOut = p0 -> rev=1)
          const dh0 = (p1Lon - headInLon) ** 2 + (p1Lat - headInLat) ** 2;
          const dh1 = (p0Lon - headInLon) ** 2 + (p0Lat - headInLat) ** 2;
          if (dh0 < bestD2) {
            bestD2 = dh0;
            bestI = i;
            bestEnd = "head";
            bestRev = 0;
          }
          if (dh1 < bestD2) {
            bestD2 = dh1;
            bestI = i;
            bestEnd = "head";
            bestRev = 1;
          }
        }

        const sChosen = remaining.splice(bestI, 1)[0];
        const off = secSet.off[sChosen];
        const cnt = secSet.len[sChosen];
        const p0Lon = cnt > 0 ? secSet.pts[off] : tailOutLon;
        const p0Lat = cnt > 0 ? secSet.pts[off + 1] : tailOutLat;
        const p1Lon = cnt > 0 ? secSet.pts[off + (cnt - 1) * 2] : tailOutLon;
        const p1Lat = cnt > 0 ? secSet.pts[off + (cnt - 1) * 2 + 1] : tailOutLat;

        // If nearest distance to head/tail is > ~20km (0.20 deg), check if this section
        // was a short station-throat section bypassed at an interior joint of `chain`.
        if (bestD2 > 0.20 * 0.20 && chain.length > 1) {
          let bestK = -1;
          let minIntD2 = bestD2;
          let intRev = 0;
          for (let k = 0; k < chain.length - 1; k++) {
            const prevOutLon = chain[k].pOutLon;
            const prevOutLat = chain[k].pOutLat;
            const d0 = (p0Lon - prevOutLon) ** 2 + (p0Lat - prevOutLat) ** 2;
            const d1 = (p1Lon - prevOutLon) ** 2 + (p1Lat - prevOutLat) ** 2;
            if (d0 < minIntD2) {
              minIntD2 = d0;
              bestK = k;
              intRev = 0;
            }
            if (d1 < minIntD2) {
              minIntD2 = d1;
              bestK = k;
              intRev = 1;
            }
          }
          if (bestK >= 0 && minIntD2 < 0.08 * 0.08) {
            chain.splice(bestK + 1, 0, {
              s: sChosen,
              rev: intRev,
              pInLon: intRev === 0 ? p0Lon : p1Lon,
              pInLat: intRev === 0 ? p0Lat : p1Lat,
              pOutLon: intRev === 0 ? p1Lon : p0Lon,
              pOutLat: intRev === 0 ? p1Lat : p0Lat,
            });
            continue;
          }
        }

        const item: ChainItem = {
          s: sChosen,
          rev: bestRev,
          pInLon: bestRev === 0 ? p0Lon : p1Lon,
          pInLat: bestRev === 0 ? p0Lat : p1Lat,
          pOutLon: bestRev === 0 ? p1Lon : p0Lon,
          pOutLat: bestRev === 0 ? p1Lat : p0Lat,
        };
        if (bestEnd === "tail") {
          chain.push(item);
        } else {
          chain.unshift(item);
        }
      }

      // 3. Ensure global orientation is Origin (homePt) -> Terminus (tcPt)
      const tcIdx = (train as DepVM).tcIdx;
      const tcCity = tcIdx !== undefined ? atlas.data.city_table[tcIdx] : undefined;
      const termLon = tcCity ? tcCity.pt[0] : chain[chain.length - 1].pOutLon;
      const termLat = tcCity ? tcCity.pt[1] : chain[chain.length - 1].pOutLat;

      const fwdScore =
        (chain[0].pInLon - homeLon) ** 2 +
        (chain[0].pInLat - homeLat) ** 2 +
        (chain[chain.length - 1].pOutLon - termLon) ** 2 +
        (chain[chain.length - 1].pOutLat - termLat) ** 2;
      const revScore =
        (chain[chain.length - 1].pOutLon - homeLon) ** 2 +
        (chain[chain.length - 1].pOutLat - homeLat) ** 2 +
        (chain[0].pInLon - termLon) ** 2 +
        (chain[0].pInLat - termLat) ** 2;

      if (revScore < fwdScore) {
        chain.reverse();
        for (let i = 0; i < chain.length; i++) {
          chain[i].rev = 1 - chain[i].rev;
        }
      }

      routeSecs = new Array(chain.length);
      for (let i = 0; i < chain.length; i++) {
        routeSecs[i] = chain[i].s;
        secRevsArr.push(chain[i].rev);
      }
    }
```

#### Preserving `rawSecs` for Static City-Pair `call.secCnt` Slicing
- In `DepVM` (`web/src/types.ts`), add `rawSecs?: number[];`.
- Before overwriting `train.secs = routeSecs;` in `buildDayTimeline` (`web/src/lib.ts` line 1185), save:
  ```ts
  if (!(train as DepVM).rawSecs) {
    (train as DepVM).rawSecs = rawSecs;
  }
  ```
- In `getDestSectionCounts()` (`web/src/components/MapCanvas.tsx` line 593), use `const secs = c.dep.rawSecs || c.dep.secs;` when slicing `0 .. Math.min(secs.length, c.secCnt)`. This guarantees that `c.secCnt` (which was computed by `atlas.rs` as an index into `rawSecs`) always slices the exact prefix of sections up to destination city `dest`!

---

### Task C: Fix Per-Frame Allocations in `drawStations` (`web/src/components/MapCanvas.tsx`)

1. In `MapCanvas.tsx`, add a cache on `S.current`:
   ```ts
   cityArrTimesCache: null as {
     cur: OriginVM | null;
     dest: CityPointVM | null;
     iso: string | null;
     dir: Direction;
     allowedCodes: Set<string> | null;
     map: Map<number, number[]>;
   } | null,
   ```
2. Create a helper `getCachedCitySubsets()` that returns `{ allowedCodes, cityArrTimesMap }`, recomputing only when `cur`, `panelDest`, `isolatedTrainCode`, or `direction` changes.
3. In `drawStations`, call `getCachedCitySubsets()` **once** before the loop over `pts`, and inside `drawDot(c)`, look up `cityArrTimesMap.get(c.idx)` in $O(1)$ with zero allocations and zero per-frame sorting.

---

### Task D: Stop-Aware `getActiveDestSectionCounts` (`web/src/components/MapCanvas.tsx`)

In `getActiveDestSectionCounts(tMins: number)` (`web/src/components/MapCanvas.tsx` lines 624–655):
- Obtain `const timeline = cur.timeline;`.
- For each call `c` in `d.calls`:
  - Determine the set of sections on `c.dep` that precede destination `d` using `const rawSecs = c.dep.rawSecs || c.dep.secs; const lim = Math.min(rawSecs.length, c.secCnt);` (or if `d` is the train's terminus `c.term`, all sections of `c.dep`).
  - Look up `const pt = timeline?.getPrepTrain(c.dep.code);`.
  - For each section `s` in the train's `pt.secs` that belongs to the prefix up to `d`:
    - Compute `tEnter` using `pt.stops` (exact same stop-aware leg interpolation as `lib.ts` lines 1268–1290) or compare `distBefore = pt.secStarts[k]` directly against the train's current travelled distance `curDist` at `tMins`!
    - Wait: comparing `pt.secStarts[k] <= trainCurDistAt(pt, tMins)` is **even simpler, faster, and 100% locked to the train dot's exact position** (including `trainEase` acceleration and station dwelling)!
    - Specifically:
      - If `tMins < pt.depMins`, `trainDist = -1` (not departed).
      - If `tMins >= pt.arrMins`, `trainDist = pt.totalDist`.
      - Otherwise, compute `trainDist` for `pt` at `tMins` (using the exact stop-dwell + `trainEase` logic from `getActiveTrains`), and every section `k` with `pt.secStarts[k] <= trainDist` is active (`counts.set(s, (counts.get(s) || 0) + 1)`)!
    - This guarantees that in City-Pair Filter Mode, a section illuminates at the **exact millisecond** the train dot enters it, and pauses when the train dot dwells at a station!

---

### Task E: Optimize `getAnimState` Filtered Counts & Fix `TrainScheduleModal.tsx`

1. **`getAnimState()` (`web/src/components/MapCanvas.tsx` lines 1948–1972):**
   - Instead of calling `tl.getActiveTrains(t)` when `allowedCodes` is non-null, iterate over `allowedCodes`:
     ```ts
     let depCount = 0;
     let arrCount = 0;
     for (const code of allowedCodes) {
       const pt = tl.getPrepTrain(code);
       if (!pt) continue;
       if (t >= pt.depMins) depCount++;
       if (t >= pt.arrMins) arrCount++;
     }
     ```
   - This is $O(K)$ in the number of filtered trains with zero trigonometry or object allocations.

2. **`TrainScheduleModal.tsx` (line 155):**
   - Change:
     ```ts
     const isArrVM = "fcIdx" in trainVM;
     ```
   - Also hide the "Isolate" / live animation controls when `direction === "in"`.
