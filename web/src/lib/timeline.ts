/* Train positions along their paths and the 24h day timeline that
   drives the map animation. */
import type {
  ActiveTrainVM,
  AtlasVM,
  ChordSpan,
  DayTimelineVM,
  DecodedSet,
  OriginVM,
  PrepTrain,
  PrepTrainStop,
  ThroatSpan,
} from "../types";
import { fmtClock } from "./format";
import { haversineKm } from "./geo";

interface SecGeometryCache {
  secLengths: Float64Array;
  secCumLens: Float64Array[];
}

const secGeometryCache = new WeakMap<DecodedSet, SecGeometryCache>();

function getSecGeometry(secSet: DecodedSet): SecGeometryCache {
  const cached = secGeometryCache.get(secSet);
  if (cached) return cached;
  const numSections = secSet.len.length;
  const secLengths = new Float64Array(numSections);
  const secCumLens: Float64Array[] = new Array(numSections);
  for (let s = 0; s < numSections; s++) {
    const off = secSet.off[s];
    const cnt = secSet.len[s];
    if (cnt <= 1) {
      secLengths[s] = 0;
      secCumLens[s] = new Float64Array(cnt);
      continue;
    }
    const cum = new Float64Array(cnt);
    let sum = 0;
    for (let k = 0; k < cnt - 1; k++) {
      const p0x = secSet.pts[off + k * 2];
      const p0y = secSet.pts[off + k * 2 + 1];
      const p1x = secSet.pts[off + (k + 1) * 2];
      const p1y = secSet.pts[off + (k + 1) * 2 + 1];
      sum += haversineKm([p0x, p0y], [p1x, p1y]);
      cum[k + 1] = sum;
    }
    secLengths[s] = sum;
    secCumLens[s] = cum;
  }
  const result: SecGeometryCache = { secLengths, secCumLens };
  secGeometryCache.set(secSet, result);
  return result;
}

/** Realistic train velocity ramp profile between stops:
 *  Accelerates smoothly from station stop (sin^2 ramp), cruises at top leg speed,
 *  and decelerates smoothly into the next station platform. */
export function trainEase(tau: number, durMins: number): number {
  if (tau <= 0) return 0;
  if (tau >= 1) return 1;
  const accelMins = Math.min(3, durMins * 0.25);
  const a = Math.max(0.01, Math.min(0.35, accelMins / durMins));
  const denom = 1 - a;
  if (tau <= a) {
    return (0.5 * tau - (a / (2 * Math.PI)) * Math.sin((Math.PI * tau) / a)) / denom;
  }
  if (tau >= 1 - a) {
    const tPrime = 1 - tau;
    const rem = (0.5 * tPrime - (a / (2 * Math.PI)) * Math.sin((Math.PI * tPrime) / a)) / denom;
    return 1 - rem;
  }
  return (0.5 * a + (tau - a)) / denom;
}

/** Normalized instantaneous speed fraction in [0, 1] (0 at station halt, 1 at full cruise). */
export function trainSpeedFrac(tau: number, durMins: number): number {
  if (tau <= 0 || tau >= 1) return 0;
  const accelMins = Math.min(3, durMins * 0.25);
  const a = Math.max(0.01, Math.min(0.35, accelMins / durMins));
  if (tau <= a) {
    return Math.sin((Math.PI * tau) / (2 * a)) ** 2;
  }
  if (tau >= 1 - a) {
    return Math.sin((Math.PI * (1 - tau)) / (2 * a)) ** 2;
  }
  return 1.0;
}

// Scratch result of trainState (single-threaded; avoids per-call allocation).
const trainScratch = {
  dist: 0,
  speedFrac: 1,
  dwell: 0 as 0 | 1 | 2 | 3, // 0 moving, 1 origin, 2 intermediate stop, 3 final
  stop: null as PrepTrainStop | null,
};

function trainState(pt: PrepTrain, t: number) {
  const r = trainScratch;
  r.stop = null;
  r.dwell = 0;
  r.speedFrac = 1;
  if (t < pt.depMins) {
    r.dist = 0;
    r.dwell = 1;
    r.speedFrac = 0;
    return;
  }
  if (t >= pt.arrMins) {
    r.dist = pt.totalDist;
    r.dwell = 3;
    r.speedFrac = 0;
    return;
  }
  const stops = pt.stops;
  let legStartDist = 0;
  let legStartTime = pt.depMins;
  let legEndDist = pt.totalDist;
  let legEndTime = pt.arrMins;
  if (stops) {
    for (let si = 0; si < stops.length; si++) {
      const st = stops[si];
      if (st.depMins !== null && st.depMins > st.arrMins && t >= st.arrMins && t <= st.depMins) {
        r.dist = st.dist;
        r.dwell = 2;
        r.stop = st;
        r.speedFrac = 0;
        return;
      }
    }
    for (let si = 0; si < stops.length; si++) {
      const st = stops[si];
      if (t < st.arrMins) {
        legEndDist = st.dist;
        legEndTime = st.arrMins;
        break;
      }
      legStartDist = st.dist;
      legStartTime = st.depMins !== null ? st.depMins : st.arrMins;
    }
  }
  const legDur = Math.max(1, legEndTime - legStartTime);
  const tau = Math.max(0, Math.min(1, (t - legStartTime) / legDur));
  r.speedFrac = trainSpeedFrac(tau, legDur);
  r.dist = legStartDist + trainEase(tau, legDur) * (legEndDist - legStartDist);
}

/** Distance along the train's route at simulation minute `t`: the single
    position model behind the dots, the flow lighting and the corridor. */
export function trainDistAt(pt: PrepTrain, t: number): number {
  trainState(pt, t);
  return trainScratch.dist;
}

/** Inverse of trainDistAt: the first minute the train has reached `dist`,
    found by bisecting the easing curve within the leg that contains it. */
function timeAtDist(pt: PrepTrain, dist: number): number {
  let legStartDist = 0;
  let legStartTime = pt.depMins;
  let legEndDist = pt.totalDist;
  let legEndTime = pt.arrMins;
  const stops = pt.stops;
  if (stops) {
    for (let si = 0; si < stops.length; si++) {
      const st = stops[si];
      if (dist <= st.dist) {
        legEndDist = st.dist;
        legEndTime = st.arrMins;
        break;
      }
      legStartDist = st.dist;
      legStartTime = st.depMins !== null ? st.depMins : st.arrMins;
    }
  }
  const span = legEndDist - legStartDist;
  if (span <= 0) return legEndTime;
  const frac = Math.max(0, Math.min(1, (dist - legStartDist) / span));
  const legDur = Math.max(1, legEndTime - legStartTime);
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 14; it++) {
    const mid = (lo + hi) / 2;
    if (trainEase(mid, legDur) < frac) lo = mid;
    else hi = mid;
  }
  return legStartTime + hi * legDur;
}

/** The throat span containing route distance `d` (spans are sorted and disjoint). */
function throatAt(spans: ThroatSpan[], d: number): ThroatSpan | undefined {
  let lo = 0;
  let hi = spans.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].d0 <= d) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const c = best >= 0 ? spans[best] : undefined;
  return c && d <= c.d1 && c.d1 > c.d0 ? c : undefined;
}

interface TrainEntries {
  secs: number[];
  times: number[];
}

export function buildDayTimeline(
  cur: OriginVM,
  atlas: AtlasVM,
): DayTimelineVM {
  const secSet = atlas.sec;
  const stepMins = 5;

  const rawTrains = cur.deps || [];

  if (!secSet || !secSet.len) {
    const empty: DayTimelineVM = {
      stepMins,
      numSteps: 12,
      totalMins: 60,
      totalDays: 1,
      secFlowSteps: new Map(),
      maxFlowSteps: new Uint16Array(12),
      getActiveTrains: () => [],
      getPrepTrain: () => undefined,
      totalTrains: 0,
      getDepartedCount: () => 0,
      getArrivedCount: () => 0,
      subset: () => empty,
    };
    return empty;
  }

  const { secLengths, secCumLens } = getSecGeometry(secSet);
  // Station throats (O1): path entries >= nSecAll, geometry only
  const nSecAll = secSet.len.length;
  const thrSet = atlas.thr;
  const thrGeo = getSecGeometry(thrSet);

  // Every origin flow section gets a step array, even if no dot enters it.
  const flowSecs = (cur.flows || []).map((f) => f.s);

  const prepTrains: PrepTrain[] = [];
  // Per train: each distinct section it covers and the minute its dot first
  // enters it (the flow lighting). Kept so a filtered subset re-tallies
  // flows without re-deriving any geometry.
  const trainEntries: TrainEntries[] = [];

  for (let ti = 0; ti < rawTrains.length; ti++) {
    const train = rawTrains[ti];
    const routeSecs = train.secs || [];

    const secRevs = train.secRevs;
    const nSecs = routeSecs.length;
    // Distance space runs over the whole path (flow sections and throats),
    // so the dot moves through stations; chord legs and stops index it.
    const path = train.path || [];
    const nPath = path.length;
    const endPt = (i: number, atEnd: boolean): [number, number] => {
      const v = path[i];
      const id = v < 0 ? ~v : v;
      const set = id < nSecAll ? secSet : thrSet;
      const g = id < nSecAll ? id : id - nSecAll;
      const k = atEnd !== v < 0 ? set.len[g] - 1 : 0;
      return [set.pts[set.off[g] + k * 2], set.pts[set.off[g] + k * 2 + 1]];
    };

    // Legs without track geometry get a virtual length in distance space: at
    // the widest join inside the leg's [s0, s1] window (one per join), as long
    // as the crow-flies gap there. The dot crosses it on a straight line.
    const virt = new Float64Array(nPath + 1);
    const virtStop = new Int32Array(nPath + 1).fill(-1); // stop the gap departs from
    for (const leg of train.chordLegs || []) {
      let bestJ = -1;
      let bestGap = 0;
      for (let j = Math.max(1, leg[1]); j <= Math.min(nPath - 1, leg[2]); j++) {
        const gap = haversineKm(endPt(j - 1, true), endPt(j, false));
        if (gap > bestGap) {
          bestGap = gap;
          bestJ = j;
        }
      }
      if (bestJ > 0) {
        virt[bestJ] = bestGap;
        virtStop[bestJ] = leg[0];
      }
    }

    let totalDist = 0;
    const pathStarts = new Float64Array(nPath); // where each path entry's own track starts
    const secStarts = new Float64Array(nSecs); // the same, for the flow sections only
    const chordSpans: ChordSpan[] = [];
    const throatSpans: ThroatSpan[] = [];
    let fi = 0;
    for (let i = 0; i < nPath; i++) {
      if (virt[i] > 0) {
        const p0 = endPt(i - 1, true);
        const p1 = endPt(i, false);
        chordSpans.push({
          d0: totalDist,
          d1: totalDist + virt[i],
          lon0: p0[0],
          lat0: p0[1],
          lon1: p1[0],
          lat1: p1[1],
        });
        totalDist += virt[i];
      }
      pathStarts[i] = totalDist;
      const v = path[i];
      const id = v < 0 ? ~v : v;
      if (id < nSecAll) {
        secStarts[fi++] = totalDist;
        totalDist += secLengths[id] || 0;
      } else {
        const len = thrGeo.secLengths[id - nSecAll] || 0;
        throatSpans.push({ d0: totalDist, d1: totalDist + len, thr: id - nSecAll, rev: v < 0 });
        totalDist += len;
      }
    }

    const dur = train.dur > 0 ? train.dur : 1;
    const depMins =
      typeof train.depMins === "number" && train.depMins >= 0
        ? train.depMins
        : 0;
    const arrMins = depMins + dur;

    const fromStation = train.fsZh || "";
    const fromStationEn = train.fsEn || "";
    const toStation = train.tsZh || "";
    const toStationEn = train.tsEn || "";
    const depTime = train.dep || "";
    const arrTime = train.arr || "";

    // Dwell stops at station level: every stop after boarding, at its exact
    // path position (dep_stop_pos), with the schedule's times. The terminus
    // is the final stop, at the path end.
    const stops: PrepTrainStop[] = [];
    const sched = atlas.schedules ? atlas.schedules[train.t] : undefined;
    const nStops = train.stopPos.length;
    if (sched && nStops > 0 && nStops === train.stops && sched.length > nStops) {
      const b = sched.length - 1 - nStops;
      const rb = sched[b];
      // schedule minutes run from the train's first day; shift them into the
      // boarding day's frame that depMins uses
      const depB = rb[3] * 1440 + rb[2] + (rb[1] >= 0 && rb[2] < rb[1] ? 1440 : 0);
      const rel = (day: number, m: number) => day * 1440 + m - depB + depMins;
      const stTable = atlas.data.station_table;
      let prevDist = 0;
      for (let i = 0; i < nStops; i++) {
        const j = b + 1 + i;
        const r = sched[j];
        const st = stTable[r[0]];
        const isTerm = i === nStops - 1;
        const k = train.stopPos[i];
        // A stop that departs across a chord gap at its own join sits on the
        // near side of it.
        const dist = isTerm
          ? totalDist
          : Math.max(
              prevDist,
              k >= nPath ? totalDist : virt[k] > 0 && virtStop[k] === j ? pathStarts[k] - virt[k] : pathStarts[k],
            );
        prevDist = dist;
        stops.push({
          cityZh: st ? st.zh : "",
          cityEn: st ? st.en : "",
          arrMins: rel(r[3], r[1]),
          depMins: isTerm || r[2] < 0 ? null : rel(r[3] + (r[2] < r[1] ? 1 : 0), r[2]),
          dist,
          isTerm,
        });
      }
    }

    prepTrains.push({
      code: train.code,
      cls: train.cls,
      fromStation,
      fromStationEn,
      toStation,
      toStationEn,
      depTime,
      arrTime,
      depMins,
      arrMins,
      dur,
      totalDist,
      secs: routeSecs,
      secStarts,
      secRevs,
      stops: stops.length > 0 ? stops : undefined,
      chordSpans: chordSpans.length > 0 ? chordSpans : undefined,
      throatSpans: throatSpans.length > 0 ? throatSpans : undefined,
    });

    // Each section counts once per train, from the minute the dot first
    // enters it.
    const seenSecs = new Set<number>();
    const ptLast = prepTrains[prepTrains.length - 1];
    const entrySecs: number[] = [];
    const entryTimes: number[] = [];
    for (let i = 0; i < routeSecs.length; i++) {
      const s_i = routeSecs[i];
      if (seenSecs.has(s_i)) continue;
      seenSecs.add(s_i);
      entrySecs.push(s_i);
      entryTimes.push(timeAtDist(ptLast, secStarts[i]));
    }
    trainEntries.push({ secs: entrySecs, times: entryTimes });
  }

  return assembleTimeline(prepTrains, trainEntries, flowSecs);

  /** The timeline of `trains`: bar length, cumulative flow per section and
      step, and the per-frame queries. Cheap enough to rerun per filter.
      `spanMins` fixes the bar length (a filtered subset keeps the full
      origin's, so the scrubber stays put); otherwise it is the trains' own. */
  function assembleTimeline(
    trains: PrepTrain[],
    entries: TrainEntries[],
    initSecs: number[],
    spanMins?: number,
  ): DayTimelineVM {
    // Track max arrival time across all services (ending time of the bar varies depending on the last train)
    let maxArrMins = 0;
    for (let ti = 0; ti < trains.length; ti++) {
      if (trains[ti].arrMins > maxArrMins) maxArrMins = trains[ti].arrMins;
    }
    const totalMins = spanMins ?? Math.max(60, Math.ceil(maxArrMins / 5) * 5);
    const totalDays = Math.max(1, Math.ceil(totalMins / 1440));
    const numSteps = Math.ceil(totalMins / stepMins);
    const secFlowSteps = new Map<number, Uint16Array>();
    const maxFlowSteps = new Uint16Array(numSteps);
    for (const s of initSecs) {
      if (!secFlowSteps.has(s)) secFlowSteps.set(s, new Uint16Array(numSteps));
    }

    // Count each entry at its start step, then accumulate per section. Clamp
    // startStep to [0, numSteps - 1] so that late-departing trains that
    // traverse sections into the following day contribute their full flow
    // count by the last step.
    for (let ti = 0; ti < entries.length; ti++) {
      const { secs, times } = entries[ti];
      for (let k = 0; k < secs.length; k++) {
        let stepArr = secFlowSteps.get(secs[k]);
        if (!stepArr) {
          stepArr = new Uint16Array(numSteps);
          secFlowSteps.set(secs[k], stepArr);
        }
        stepArr[Math.min(numSteps - 1, Math.max(0, Math.ceil(times[k] / stepMins)))]++;
      }
    }
    for (const arr of secFlowSteps.values()) {
      for (let step = 1; step < numSteps; step++) arr[step] += arr[step - 1];
    }

    // Max flow across all sections at each 5-min step
    for (let step = 0; step < numSteps; step++) {
      let m = 0;
      for (const arr of secFlowSteps.values()) {
        if (arr[step] > m) m = arr[step];
      }
      maxFlowSteps[step] = m;
    }

    function getActiveTrains(tMins: number): ActiveTrainVM[] {
      const active: ActiveTrainVM[] = [];
      for (let i = 0; i < trains.length; i++) {
        const pt = trains[i];
        // 10 min pre-departure boarding dwell at origin
        const boardStart = Math.max(0, pt.depMins - 10);
        // 8 min disembarkation dwell at final terminus
        const termEnd = pt.arrMins + 8;
        if (
          tMins < boardStart ||
          tMins > termEnd ||
          pt.totalDist <= 0 ||
          pt.secs.length === 0
        ) {
          continue;
        }

        trainState(pt, tMins);
        const targetDist = trainScratch.dist;
        const speedFrac = trainScratch.speedFrac;
        const dw = trainScratch.dwell;
        const isDwelling = dw !== 0;
        let dwellStation: string | undefined;
        let dwellStationEn: string | undefined;
        let dwellStatus: "origin" | "stop" | "dest" | undefined;
        let dwellDetail: string | undefined;
        if (dw === 1) {
          dwellStation = pt.fromStation;
          dwellStationEn = pt.fromStationEn;
          dwellStatus = "origin";
          dwellDetail = `Departs ${pt.depTime}`;
        } else if (dw === 3) {
          dwellStation = pt.toStation;
          dwellStationEn = pt.toStationEn;
          dwellStatus = "dest";
          dwellDetail = "Final Destination";
        } else if (dw === 2 && trainScratch.stop) {
          const st = trainScratch.stop;
          dwellStation = st.cityZh;
          dwellStationEn = st.cityEn;
          dwellStatus = "stop";
          dwellDetail = `${fmtClock(st.arrMins)} - ${fmtClock(st.depMins!)}`;
        }

        if (pt.chordSpans) {
          let span: ChordSpan | undefined;
          for (const c of pt.chordSpans) {
            if (targetDist >= c.d0 && targetDist <= c.d1 && c.d1 > c.d0) {
              span = c;
              break;
            }
          }
          if (span) {
            const a = (targetDist - span.d0) / (span.d1 - span.d0);
            active.push({
              lon: span.lon0 + a * (span.lon1 - span.lon0),
              lat: span.lat0 + a * (span.lat1 - span.lat0),
              heading: Math.atan2(span.lat1 - span.lat0, span.lon1 - span.lon0),
              cls: pt.cls,
              code: pt.code,
              fromStation: pt.fromStation,
              fromStationEn: pt.fromStationEn,
              toStation: pt.toStation,
              toStationEn: pt.toStationEn,
              depTime: pt.depTime,
              arrTime: pt.arrTime,
              durMins: pt.dur,
              progressPct: Math.round((Math.max(0, Math.min(pt.totalDist, targetDist)) / Math.max(1, pt.totalDist)) * 100),
              isDwelling,
              dwellStation,
              dwellStationEn,
              dwellStatus,
              dwellDetail,
              speedFrac,
              curDist: targetDist,
              onChord: true,
            });
            continue;
          }
        }

        // The station throat the dot is on (O1), else the section in the route
        const th = pt.throatSpans ? throatAt(pt.throatSpans, targetDist) : undefined;
        let gSet = secSet;
        let gCum = secCumLens;
        let s: number;
        let distInSec: number;
        let isSecRev: boolean;
        let sLen: number;
        if (th) {
          gSet = thrSet;
          gCum = thrGeo.secCumLens;
          s = th.thr;
          distInSec = targetDist - th.d0;
          isSecRev = th.rev;
          sLen = thrGeo.secLengths[s] || 0;
        } else {
          let secIdx = 0;
          while (
            secIdx < pt.secs.length - 1 &&
            pt.secStarts[secIdx + 1] <= targetDist
          ) {
            secIdx++;
          }
          s = pt.secs[secIdx];
          distInSec = targetDist - pt.secStarts[secIdx];
          isSecRev = pt.secRevs[secIdx] === 1;
          sLen = secLengths[s] || 0;
        }
        // If traversed in reverse, effective distance along vertices starts from the end
        const distInSecEffective = isSecRev
          ? Math.max(0, Math.min(sLen, sLen - distInSec))
          : distInSec;

        // Find which segment within section s
        const off = gSet.off[s];
        const cnt = gSet.len[s];
        if (cnt <= 1) {
          if (cnt === 1) {
            active.push({
              lon: gSet.pts[off],
              lat: gSet.pts[off + 1],
              heading: 0,
              cls: pt.cls,
              code: pt.code,
              fromStation: pt.fromStation,
              fromStationEn: pt.fromStationEn,
              toStation: pt.toStation,
              toStationEn: pt.toStationEn,
              depTime: pt.depTime,
              arrTime: pt.arrTime,
              durMins: pt.dur,
              progressPct: Math.round((Math.max(0, Math.min(pt.totalDist, targetDist)) / Math.max(1, pt.totalDist)) * 100),
              isDwelling,
              dwellStation,
              dwellStationEn,
              dwellStatus,
              dwellDetail,
              speedFrac,
              curDist: targetDist,
            });
          }
          continue;
        }

        const cum = gCum[s];
        let k = 0;
        while (k < cnt - 2 && cum[k + 1] < distInSecEffective) {
          k++;
        }
        const segLen = cum[k + 1] - cum[k];
        const segAlpha =
          segLen > 0
            ? Math.max(0, Math.min(1, (distInSecEffective - cum[k]) / segLen))
            : 0;
        const lon0 = gSet.pts[off + k * 2];
        const lat0 = gSet.pts[off + k * 2 + 1];
        const lon1 = gSet.pts[off + (k + 1) * 2];
        const lat1 = gSet.pts[off + (k + 1) * 2 + 1];
        const lon = lon0 + segAlpha * (lon1 - lon0);
        const lat = lat0 + segAlpha * (lat1 - lat0);

        // Traversal heading: if reversed, movement vector is (lon0 - lon1, lat0 - lat1)
        const dLon = isSecRev ? lon0 - lon1 : lon1 - lon0;
        const dLat = isSecRev ? lat0 - lat1 : lat1 - lat0;
        const heading = Math.atan2(dLat, dLon);

        active.push({
          lon,
          lat,
          heading,
          cls: pt.cls,
          code: pt.code,
          fromStation: pt.fromStation,
          fromStationEn: pt.fromStationEn,
          toStation: pt.toStation,
          toStationEn: pt.toStationEn,
          depTime: pt.depTime,
          arrTime: pt.arrTime,
          durMins: pt.dur,
          progressPct: Math.round((Math.max(0, Math.min(pt.totalDist, targetDist)) / Math.max(1, pt.totalDist)) * 100),
          isDwelling,
          dwellStation,
          dwellStationEn,
          dwellStatus,
          dwellDetail,
          speedFrac,
          curDist: targetDist,
        });
      }
      return active;
    }

    function getDepartedCount(tMins: number): number {
      let count = 0;
      for (let i = 0; i < trains.length; i++) {
        if (trains[i].depMins <= tMins) {
          count++;
        }
      }
      return count;
    }

    function getArrivedCount(tMins: number): number {
      let count = 0;
      for (let i = 0; i < trains.length; i++) {
        if (trains[i].arrMins <= tMins) {
          count++;
        }
      }
      return count;
    }

    const prepMap = new Map<string, PrepTrain>();
    for (let i = 0; i < trains.length; i++) {
      prepMap.set(trains[i].code, trains[i]);
    }

    return {
      stepMins,
      numSteps,
      totalMins,
      totalDays,
      secFlowSteps,
      maxFlowSteps,
      getActiveTrains,
      getPrepTrain: (code: string) => prepMap.get(code),
      totalTrains: trains.length,
      getDepartedCount,
      getArrivedCount,
      subset: (codes: Set<string>) => {
        const subTrains: PrepTrain[] = [];
        const subEntries: TrainEntries[] = [];
        for (let i = 0; i < trains.length; i++) {
          if (!codes.has(trains[i].code)) continue;
          subTrains.push(trains[i]);
          subEntries.push(entries[i]);
        }
        return assembleTimeline(subTrains, subEntries, [], totalMins);
      },
    };
  }
}
