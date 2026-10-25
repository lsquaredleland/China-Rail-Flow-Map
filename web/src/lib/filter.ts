/* Derived origin view-models for the class / hour / distance / duration
   filters. */
import type {
  ArrVM,
  DayTimelineVM,
  DepVM,
  DistBinFilter,
  DurBinFilter,
  FlowVM,
  OriginFilterCriteria,
  OriginVM,
} from "../types";
import { classIndex } from "./origin";

/** Return a derived OriginVM filtered to the selected train classes,
    departure/arrival hour, journey distance bin, or journey duration bin.
    Preserves `o` reference identity so MapCanvas redraws in place without
    resetting camera zoom/pan. */
export function filterOrigin(
  cur: OriginVM,
  criteria: OriginFilterCriteria,
): OriginVM {
  const {
    classes = [],
    hour = null,
    hours = null,
    distBin = null,
    distBins = null,
    durBin = null,
    durBins = null,
    trainCodes = null,
    unit = "km",
  } = criteria;

  const activeHours: number[] =
    hours && hours.length > 0
      ? hours
      : hour !== null && hour !== undefined
        ? [hour]
        : [];
  const activeDistBins: DistBinFilter[] =
    distBins && distBins.length > 0
      ? distBins
      : distBin
        ? [distBin]
        : [];
  const activeDurBins: DurBinFilter[] =
    durBins && durBins.length > 0
      ? durBins
      : durBin
        ? [durBin]
        : [];
  const activeTrainCodes: string[] =
    trainCodes && trainCodes.length > 0 ? trainCodes : [];

  const hasClassFilter = classes.length > 0;
  const hasHourFilter = activeHours.length > 0;
  const hasDistFilter = activeDistBins.length > 0;
  const hasDurFilter = activeDurBins.length > 0;
  const hasTrainFilter = activeTrainCodes.length > 0;

  const hasAnyFilter =
    hasClassFilter ||
    hasHourFilter ||
    hasDistFilter ||
    hasDurFilter ||
    hasTrainFilter;
  if (!hasAnyFilter) return cur;

  const clsIndices = Array.from(new Set(classes.map(classIndex)));
  const hasClass = (cls: string) =>
    !hasClassFilter ||
    classes.includes(cls) ||
    (classes.includes("plain") && classIndex(cls) === 7);

  const trainCodeSet = hasTrainFilter ? new Set(activeTrainCodes) : null;
  const hourSet = hasHourFilter ? new Set(activeHours) : null;

  const matchesDep = (d: DepVM) => {
    if (trainCodeSet && !trainCodeSet.has(d.code)) return false;
    if (!hasClass(d.cls)) return false;
    if (hourSet) {
      const h = parseInt(d.dep.slice(0, 2), 10);
      if (!hourSet.has(h)) return false;
    }
    if (hasDistFilter) {
      const v = unit === "km" ? d.distKm : d.distKm * 0.621371;
      const matched = activeDistBins.some((bin) => {
        const b = Math.min(
          bin.nb - 1,
          Math.max(0, Math.floor(v / bin.size)),
        );
        return b === bin.bin;
      });
      if (!matched) return false;
    }
    if (hasDurFilter) {
      const matched = activeDurBins.some((bin) => {
        const b = Math.min(
          bin.nb - 1,
          Math.max(0, Math.floor(d.dur / bin.size)),
        );
        return b === bin.bin;
      });
      if (!matched) return false;
    }
    return true;
  };

  const matchesArr = (a: ArrVM) => {
    if (trainCodeSet && !trainCodeSet.has(a.code)) return false;
    if (!hasClass(a.cls)) return false;
    if (hourSet) {
      const h = parseInt(a.arr.slice(0, 2), 10);
      if (!hourSet.has(h)) return false;
    }
    if (hasDistFilter) {
      const v = unit === "km" ? a.distKm : a.distKm * 0.621371;
      const matched = activeDistBins.some((bin) => {
        const b = Math.min(
          bin.nb - 1,
          Math.max(0, Math.floor(v / bin.size)),
        );
        return b === bin.bin;
      });
      if (!matched) return false;
    }
    if (hasDurFilter) {
      const matched = activeDurBins.some((bin) => {
        const b = Math.min(
          bin.nb - 1,
          Math.max(0, Math.floor(a.dur / bin.size)),
        );
        return b === bin.bin;
      });
      if (!matched) return false;
    }
    return true;
  };

  const deps = cur.deps.filter(matchesDep);
  const arrs = cur.arrs.filter(matchesArr);

  let flows: FlowVM[];
  if (
    cur.deps.length > 0 &&
    (hasHourFilter || hasDistFilter || hasDurFilter || hasTrainFilter)
  ) {
    const secMap = new Map<number, { n: number; byClass: number[] }>();
    for (const d of deps) {
      const ci = classIndex(d.cls);
      for (const s of new Set(d.secs)) {
        let entry = secMap.get(s);
        if (!entry) {
          entry = { n: 0, byClass: new Array(8).fill(0) };
          secMap.set(s, entry);
        }
        entry.n++;
        if (ci >= 0 && ci < 8) entry.byClass[ci]++;
      }
    }
    flows = Array.from(secMap.entries()).map(([s, { n, byClass }]) => ({
      s,
      n,
      byClass,
    }));
    flows.sort((a, b) => b.n - a.n);
  } else {
    flows = cur.flows
      .map((f) => {
        let n = 0;
        for (const ci of clsIndices) n += f.byClass[ci] || 0;
        return { s: f.s, n, byClass: f.byClass };
      })
      .filter((f) => f.n > 0)
      .sort((a, b) => b.n - a.n);
  }

  let inFlows: FlowVM[];
  if (
    cur.arrs.length > 0 &&
    (hasHourFilter || hasDistFilter || hasDurFilter || hasTrainFilter)
  ) {
    const secMap = new Map<number, { n: number; byClass: number[] }>();
    for (const a of arrs) {
      const ci = classIndex(a.cls);
      for (const s of new Set(a.secs)) {
        let entry = secMap.get(s);
        if (!entry) {
          entry = { n: 0, byClass: new Array(8).fill(0) };
          secMap.set(s, entry);
        }
        entry.n++;
        if (ci >= 0 && ci < 8) entry.byClass[ci]++;
      }
    }
    inFlows = Array.from(secMap.entries()).map(([s, { n, byClass }]) => ({
      s,
      n,
      byClass,
    }));
    inFlows.sort((a, b) => b.n - a.n);
  } else {
    inFlows = cur.inFlows
      .map((f) => {
        let n = 0;
        for (const ci of clsIndices) n += f.byClass[ci] || 0;
        return { s: f.s, n, byClass: f.byClass };
      })
      .filter((f) => f.n > 0)
      .sort((a, b) => b.n - a.n);
  }

  let dests = cur.dests;
  if (cur.deps.length > 0) {
    dests = [];
    for (const d of cur.dests) {
      const calls = d.calls.filter((c) => c.dep && matchesDep(c.dep));
      if (!calls.length) continue;
      let fast = 0;
      let terminating = 0;
      const times: number[] = [];
      for (const c of calls) {
        if (["G", "D", "C", "S"].includes(c.dep.cls)) fast++;
        if (c.term) terminating++;
        if (c.dur > 0 && c.dur < 6000) times.push(c.dur);
      }
      times.sort((a, b) => a - b);
      dests.push({
        ...d,
        trains: calls.length,
        fast,
        endpoint: terminating,
        terminating,
        fastest: times.length ? times[0] : d.fastest,
        median: times.length ? times[Math.floor(times.length / 2)] : d.median,
        arrTimes: calls
          .map((c) => (c.arrMins !== undefined ? c.arrMins : -1))
          .filter((t) => t >= 0)
          .sort((a, b) => a - b),
        calls,
      });
    }
    dests.sort((a, b) => b.trains - a.trains);
  }

  let srcs = cur.srcs;
  if (cur.arrs.length > 0) {
    srcs = [];
    for (const s of cur.srcs) {
      const inCalls = s.inCalls.filter((c) => c.arr && matchesArr(c.arr));
      if (!inCalls.length) continue;
      let fast = 0;
      let originating = 0;
      const times: number[] = [];
      for (const c of inCalls) {
        if (["G", "D", "C", "S"].includes(c.arr.cls)) fast++;
        if (c.started) originating++;
        if (c.dur > 0 && c.dur < 6000) times.push(c.dur);
      }
      times.sort((a, b) => a - b);
      srcs.push({
        ...s,
        trains: inCalls.length,
        fast,
        endpoint: originating,
        originating,
        fastest: times.length ? times[0] : s.fastest,
        median: times.length ? times[Math.floor(times.length / 2)] : s.median,
        inCalls,
      });
    }
    srcs.sort((a, b) => b.trains - a.trains);
  }

  const res: OriginVM = {
    o: cur.o,
    en: cur.en,
    flows,
    dests,
    chords: cur.chords,
    deps,
    maxFlow: flows.length ? flows[0].n : 0,
    inFlows,
    srcs,
    arrs,
    maxInFlow: inFlows.length ? inFlows[0].n : 0,
  };

  // The animation of a filtered view runs only the matching trains: built on
  // first use from the full origin's timeline, without re-deriving geometry.
  let timelineCache: DayTimelineVM | undefined;
  Object.defineProperty(res, "timeline", {
    get() {
      if (!timelineCache && deps.length > 0) {
        timelineCache = cur.timeline?.subset(new Set(deps.map((d) => d.code)));
      }
      return timelineCache;
    },
    configurable: true,
    enumerable: true,
  });

  return res;
}

export function filterOriginByClasses(
  cur: OriginVM,
  selectedClasses: string[],
): OriginVM {
  return filterOrigin(cur, { classes: selectedClasses });
}
