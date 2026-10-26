/* National mode's trains table: one row per `train_table` entry, read off the
   schedules (first and last stop, times, rail km) and picked by the same
   per-train selection that drives the map (`natSelect`). Lookups, sums and
   sorting only; the pack decided every fact. */
import type { DistUnit, NationalIndexPack, RawStation, RawTrain, SchedulesData } from "../types";
import { fmtClock } from "./format";
import { NAT_DIST_SIZE } from "./nationalIndex";
import { runRank } from "./runDays";

export interface NatRow {
  t: number; // train_table index
  code: string;
  cls: string;
  from: string; // first stop: Chinese name
  fromEn: string;
  to: string; // last stop
  toEn: string;
  dep: number; // minutes from midnight of the first day; -1 without a schedule
  arr: number; // minutes from the departure day's midnight (can pass 1440)
  dur: number; // arr - dep; -1 without a schedule
  km: number; // rail km: the legs of the schedule added up; -1 without a schedule
  runs: number; // run-days category rank (Daily first)
  hay: string; // lowercase search haystack: code and end stations
}

export type NatSortKey = "code" | "dep" | "arr" | "dur" | "km" | "runs";

export function buildNatRows(
  trainTable: readonly RawTrain[],
  stationTable: readonly RawStation[],
  sched: SchedulesData,
  calendar?: readonly string[],
): NatRow[] {
  const name = (idx: number): [string, string] => {
    if (idx < stationTable.length) return [stationTable[idx].zh, stationTable[idx].en];
    const z = sched.extra_stations[idx - stationTable.length] || "";
    return [z, z];
  };
  return trainTable.map((tr, t) => {
    const s = sched.schedules[t];
    const runs = runRank(tr, calendar);
    if (!s || s.length === 0) {
      return { t, code: tr.code, cls: tr.class, from: "", fromEn: "", to: "", toEn: "", dep: -1, arr: -1, dur: -1, km: -1, runs, hay: tr.code.toLowerCase() };
    }
    const first = s[0];
    const last = s[s.length - 1];
    const [from, fromEn] = name(first[0]);
    const [to, toEn] = name(last[0]);
    const dep = first[2];
    const arr = last[1] >= 0 ? last[1] + last[3] * 1440 : -1;
    let km = 0;
    for (const stop of s) km += stop[4] || 0;
    return {
      t,
      code: tr.code,
      cls: tr.class,
      from,
      fromEn,
      to,
      toEn,
      dep,
      arr,
      dur: dep >= 0 && arr >= 0 ? arr - dep : -1,
      km: Math.round(km * 10) / 10,
      runs,
      hay: (tr.code + " " + from + " " + fromEn + " " + to + " " + toEn).toLowerCase(),
    };
  });
}

/** A row as the origin histograms take it ({time, distKm, dur, cls}). */
export interface HistRow {
  time: string;
  distKm: number;
  dur: number;
  cls: string;
}

/** The national trains as histogram rows. Hour and duration come from the
    schedules (they agree with the index's bins); the distance is the centre of
    the index's distance bin of the unit, so a bar always counts the trains the
    map and table select when it is clicked. Empty until the index has loaded. */
export function natHistRows(rows: readonly NatRow[], ix: NationalIndexPack | null, unit: DistUnit): HistRow[] {
  if (!ix) return [];
  const bins = unit === "mi" ? ix.dist_mi : ix.dist_km;
  const size = NAT_DIST_SIZE[unit];
  const toKm = unit === "mi" ? 1 / 0.621371 : 1;
  const out: HistRow[] = [];
  for (const r of rows) {
    if (r.dep < 0) continue;
    out.push({ time: fmtClock(r.dep % 1440), distKm: (bins[r.t] + 0.5) * size * toKm, dur: r.dur, cls: r.cls });
  }
  return out;
}

/** The rows `sel` (natSelect's 0/1 flags per train_table row; null = all) keeps. */
export function selectNatRows(rows: readonly NatRow[], sel: Uint8Array | null): NatRow[] {
  return sel ? rows.filter((r) => sel[r.t] === 1) : rows.slice();
}

/** Sorts `list` in place: missing values (-1) last, ties by departure then code. */
export function sortNatRows(list: NatRow[], key: NatSortKey, dir: 1 | -1): NatRow[] {
  return list.sort((a, b) => {
    if (key === "code") {
      return a.code < b.code ? -dir : a.code > b.code ? dir : 0;
    }
    const va = a[key];
    const vb = b[key];
    if (va < 0 && vb >= 0) return 1;
    if (vb < 0 && va >= 0) return -1;
    if (va !== vb) return (va < vb ? -1 : 1) * dir;
    if (a.dep !== b.dep) return a.dep < b.dep ? -1 : 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
}
