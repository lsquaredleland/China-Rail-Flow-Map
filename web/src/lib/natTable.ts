/* National mode's trains table: one row per `train_table` entry, read off the
   schedules (first and last stop, times, rail km) and picked by the same
   per-train selection that drives the map (`natSelect`). Lookups and sorting
   only; the pack decided every fact. */
import type { RawStation, RawTrain, SchedulesData } from "../types";
import { runCount } from "./runDays";

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
  km: number; // rail km at the last stop; -1 without a schedule
  days: number; // run days in the calendar window (0 without run-day data)
}

export type NatSortKey = "code" | "dep" | "arr" | "dur" | "km" | "days";

export function buildNatRows(
  trainTable: readonly RawTrain[],
  stationTable: readonly RawStation[],
  sched: SchedulesData,
): NatRow[] {
  const name = (idx: number): [string, string] => {
    if (idx < stationTable.length) return [stationTable[idx].zh, stationTable[idx].en];
    const z = sched.extra_stations[idx - stationTable.length] || "";
    return [z, z];
  };
  return trainTable.map((tr, t) => {
    const s = sched.schedules[t];
    if (!s || s.length === 0) {
      return { t, code: tr.code, cls: tr.class, from: "", fromEn: "", to: "", toEn: "", dep: -1, arr: -1, dur: -1, km: -1, days: runCount(tr.days) };
    }
    const first = s[0];
    const last = s[s.length - 1];
    const [from, fromEn] = name(first[0]);
    const [to, toEn] = name(last[0]);
    const dep = first[2];
    const arr = last[1] >= 0 ? last[1] + last[3] * 1440 : -1;
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
      km: typeof last[4] === "number" ? last[4] : -1,
      days: runCount(tr.days),
    };
  });
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
