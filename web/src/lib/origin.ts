/* The per-origin view-model: buildOrigin turns the decoded atlas into
   the dests / srcs / flows / train rows the UI reads. */
import type {
  ArrVM,
  DayTimelineVM,
  DecodedAtlas,
  DepVM,
  DestVM,
  OriginVM,
  SrcVM,
} from "../types";
import { decodeFlat, decodeSecs, flatBB } from "./decode";
import { enName, fmtClock } from "./format";
import { haversineKm } from "./geo";
import { buildDayTimeline } from "./timeline";

/* ---------- per-origin view-model ---------- */

export const FLOW_CLASSES = [
  "G",
  "D",
  "C",
  "S",
  "Z",
  "T",
  "K",
  "plain",
] as const;

export function classIndex(cls: string): number {
  switch (cls) {
    case "G":
      return 0;
    case "D":
      return 1;
    case "C":
      return 2;
    case "S":
      return 3;
    case "Z":
      return 4;
    case "T":
      return 5;
    case "K":
      return 6;
    default:
      return 7;
  }
}

export function buildOrigin(atlas: DecodedAtlas, idx: number): OriginVM {
  const { data } = atlas;
  const o = data.origins[idx];
  const flows = o.flows.map((f) => ({
    s: f[0],
    n: f[1],
    byClass: [
      f[2] || 0,
      f[3] || 0,
      f[4] || 0,
      f[5] || 0,
      f[6] || 0,
      f[7] || 0,
      f[8] || 0,
      f[9] || 0,
    ],
  }));
  // Widest first, narrower on top: strokes are opaque, so where a
  // narrower section shares ground with a wider one it reads as a
  // clean step down in width, never a ghost stripe inside the band,
  // and junction overlaps cannot double-darken.
  flows.sort((a, b) => b.n - a.n);
  // Departures are built first: each destination's `calls` list joins
  // back into this array by index, so a calling train carries its code,
  // boarding station/time and final terminus with it.
  // v2 deps rows are positional:
  // [train, from-station, dep minutes, to-station, to-city, arr minutes,
  //  duration, stops, km].
  const deps: DepVM[] = (o.deps || []).map((d, di) => {
    const t = data.train_table[d[0]];
    const fs = data.station_table[d[1]];
    const ts = data.station_table[d[3]];
    const tc = data.city_table[d[4]];
    const dp = (o.dep_secs && o.dep_secs[di]) || [];
    const ds = decodeSecs(dp, data.sections.length);
    const rec: DepVM = {
      t: d[0],
      code: t.code,
      cls: t.class,
      dep: fmtClock(d[2]),
      arr: fmtClock(d[5]),
      depMins: d[2],
      arrMins: d[5],
      dur: d[6],
      stops: d[7],
      tcIdx: d[4],
      fsZh: fs.zh,
      fsEn: fs.en,
      tsZh: ts.zh,
      tsEn: ts.en,
      tcZh: tc.zh,
      tcEn: enName(tc.en),
      km: d[8],
      distKm: d[8] > 0 ? d[8] : haversineKm(o.pt, tc.pt),
      hay: "",
      secs: ds.secs,
      secRevs: ds.revs,
      path: dp,
      chordLegs: (o.dep_chord_legs && o.dep_chord_legs[di]) || [],
      stopPos: (o.dep_stop_pos && o.dep_stop_pos[di]) || [],
    };
    rec.hay = (
      rec.code +
      " " +
      rec.cls +
      " " +
      rec.fsZh +
      " " +
      rec.fsEn +
      " " +
      rec.tsZh +
      " " +
      rec.tsEn +
      " " +
      rec.tcZh +
      " " +
      tc.en +
      " " +
      rec.tcEn
    ).toLowerCase();
    return rec;
  });
  const dests: DestVM[] = o.dests.map((d, di) => {
    const c = data.city_table[d[0]];
    return {
      idx: d[0],
      zh: c.zh,
      en: enName(c.en),
      pt: c.pt,
      trains: d[1],
      fast: d[2],
      endpoint: d[3],
      terminating: d[3],
      fastest: d[4],
      median: d[5],
      crow: d[6],
      rail: d[7],
      nn: 0,
      arrTimes: ((o.calls || [])[di] || [])
        .map((call) => (call[1] >= 0 ? call[3] * 1440 + call[1] : -1))
        .filter((t) => t >= 0)
        .sort((a, b) => a - b),
      calls: ((o.calls || [])[di] || []).map((call) => {
        const rawDep = (o.deps || [])[call[0]];
        const depMins = rawDep ? rawDep[2] : -1;
        const dur =
          depMins >= 0 && call[1] >= 0 ? call[3] * 1440 + call[1] - depMins : -1;
        return {
          dep: deps[call[0]],
          arr: fmtClock(call[1]),
          depAt: call[4] === 1 ? "—" : fmtClock(call[2]),
          dur: dur > 0 ? dur : -1,
          dayOff: call[3],
          term: call[4] === 1,
          secCnt:
            call[5] !== undefined
              ? call[5]
              : deps[call[0]]
                ? deps[call[0]].secs.length
                : 0,
          arrMins: call[1] >= 0 ? call[3] * 1440 + call[1] : -1,
        };
      }),
    };
  });
  dests.sort((a, b) => b.trains - a.trains);
  // Nearest-neighbour distance for every destination: the label pass
  // places the most squeezed termini first (Hong Kong's dot sits ~5 px
  // from Shenzhen's at national scale), before their neighbours' labels
  // take the only free spots around them.
  for (let di = 0; di < dests.length; di++) {
    let best2 = Infinity;
    for (let dj = 0; dj < dests.length; dj++) {
      if (dj === di) continue;
      const ddx = dests[di].pt[0] - dests[dj].pt[0];
      const ddy = dests[di].pt[1] - dests[dj].pt[1];
      const dd2 = ddx * ddx + ddy * ddy;
      if (dd2 < best2) best2 = dd2;
    }
    dests[di].nn = Math.sqrt(best2);
  }
  const chords = o.chords.map((ch) => {
    const f = decodeFlat(ch.g);
    return { a: ch.a, b: ch.b, n: ch.n, flat: f, count: f.length / 2, bb: flatBB(f) };
  });
  chords.sort((a, b) => a.n - b.n);

  /* ---------- inbound mirror ---------- */
  // The inbound fields are absent until the inbound files have loaded;
  // every inbound list then builds as empty and the header/table counts
  // stay at zero behind the map's loading affordance.
  const inFlows = (o.in_flows || []).map((f) => ({
    s: f[0],
    n: f[1],
    byClass: [
      f[2] || 0,
      f[3] || 0,
      f[4] || 0,
      f[5] || 0,
      f[6] || 0,
      f[7] || 0,
      f[8] || 0,
      f[9] || 0,
    ],
  }));
  inFlows.sort((a, b) => b.n - a.n);
  // Arrivals are built before the sources: each source's `in_calls`
  // list joins back into this array by index, exactly as outbound
  // calls join into deps.
  // v2 arrs rows are positional:
  // [train, origin-station, origin-city, dep minutes, arrival-station,
  //  arr minutes, duration, stops, km].
  const arrs: ArrVM[] = (o.arrs || []).map((a, ai) => {
    const t = data.train_table[a[0]];
    const fs = data.station_table[a[1]];
    const ts = data.station_table[a[4]];
    const fc = data.city_table[a[2]];
    const ap = (o.arr_secs && o.arr_secs[ai]) || [];
    const as = decodeSecs(ap, data.in_sections.length);
    const rec: ArrVM = {
      t: a[0],
      code: t.code,
      cls: t.class,
      dep: fmtClock(a[3]),
      arr: fmtClock(a[5]),
      depMins: a[3],
      arrMins: a[5],
      dur: a[6],
      stops: a[7],
      dayOff: a[6] >= 0 ? Math.floor((a[3] + a[6]) / 1440) : 0,
      fcIdx: a[2],
      fcZh: fc.zh,
      fcEn: enName(fc.en),
      fsZh: fs.zh,
      fsEn: fs.en,
      tsZh: ts.zh,
      tsEn: ts.en,
      km: a[8],
      distKm: a[8] > 0 ? a[8] : haversineKm(fc.pt, o.pt),
      hay: "",
      secs: as.secs,
      secRevs: as.revs,
      path: ap,
      chordLegs: (o.arr_chord_legs && o.arr_chord_legs[ai]) || [],
    };
    rec.hay = (
      rec.code +
      " " +
      rec.cls +
      " " +
      rec.fsZh +
      " " +
      rec.fsEn +
      " " +
      rec.tsZh +
      " " +
      rec.tsEn +
      " " +
      rec.fcZh +
      " " +
      fc.en +
      " " +
      rec.fcEn
    ).toLowerCase();
    return rec;
  });
  const srcs: SrcVM[] = (o.srcs || []).map((s, si) => {
    const c = data.city_table[s[0]];
    return {
      idx: s[0],
      zh: c.zh,
      en: enName(c.en),
      pt: c.pt,
      trains: s[1],
      fast: s[2],
      endpoint: s[3],
      originating: s[3],
      fastest: s[4],
      median: s[5],
      crow: s[6],
      rail: s[7],
      nn: 0,
      arrTimes: ((o.in_calls || [])[si] || [])
        .map((call) => call[1])
        .filter((t) => t >= 0)
        .sort((a, b) => a - b),
      inCalls: ((o.in_calls || [])[si] || []).map((call) => {
        const bs = data.station_table[call[5]];
        const dur =
          call[1] >= 0 && call[2] >= 0
            ? call[3] * 1440 + call[2] - call[1]
            : -1;
        return {
          arr: arrs[call[0]],
          board: fmtClock(call[1]),
          arrTime: fmtClock(call[2]),
          dur: dur > 0 ? dur : -1,
          dayOff: call[3],
          started: call[4] === 1,
          bsZh: bs ? bs.zh : "—",
          bsEn: bs ? bs.en : "",
          secCnt:
            call[6] !== undefined
              ? call[6]
              : arrs[call[0]]
                ? arrs[call[0]].secs.length
                : 0,
          boardMins: call[1],
          arrMins: call[2] >= 0 ? call[3] * 1440 + call[2] : -1,
        };
      }),
    };
  });
  srcs.sort((a, b) => b.trains - a.trains);
  for (let si = 0; si < srcs.length; si++) {
    let best2 = Infinity;
    for (let sj = 0; sj < srcs.length; sj++) {
      if (sj === si) continue;
      const ddx = srcs[si].pt[0] - srcs[sj].pt[0];
      const ddy = srcs[si].pt[1] - srcs[sj].pt[1];
      const dd2 = ddx * ddx + ddy * ddy;
      if (dd2 < best2) best2 = dd2;
    }
    srcs[si].nn = Math.sqrt(best2);
  }
  const res: OriginVM = {
    o,
    en: enName(o.en),
    flows,
    dests,
    chords,
    deps,
    maxFlow: flows.length ? flows[0].n : 0,
    inFlows,
    srcs,
    arrs,
    maxInFlow: inFlows.length ? inFlows[0].n : 0,
  };

  let timelineCache: DayTimelineVM | undefined;

  Object.defineProperty(res, "timeline", {
    get() {
      if (!timelineCache && deps.length > 0) {
        timelineCache = buildDayTimeline(res, atlas);
      }
      return timelineCache;
    },
    set(v) {
      timelineCache = v;
    },
    configurable: true,
    enumerable: true,
  });

  return res;
}

export const prepOrigin = buildOrigin;
