/* Per-station breakdowns for the departures section's headings. Each
   function tallies exactly the rows the heading's own number counts, one
   station per row, so the station counts always sum to that number:
   - departures from a city: a train counts at its boarding station there;
   - arrivals into a city: at its arrival station there;
   - trains calling at a destination: at the station of that city where the
     train stops (the one stop whose arrival time matches the call);
   - trains arriving from a source city: at the station it boarded at. */
import type { ArrVM, CallVM, DepVM, InCallVM, SchedulesData } from "./types";

export interface StationCount {
  zh: string;
  en: string;
  n: number;
}

/** Count by station (keyed by the Chinese name), most trains first, then by name. */
export function tallyStations(
  rows: Iterable<{ zh: string; en: string }>,
): StationCount[] {
  const m = new Map<string, StationCount>();
  for (const r of rows) {
    const e = m.get(r.zh);
    if (e) e.n++;
    else m.set(r.zh, { zh: r.zh, en: r.en, n: 1 });
  }
  return [...m.values()].sort((a, b) =>
    b.n !== a.n ? b.n - a.n : a.zh < b.zh ? -1 : a.zh > b.zh ? 1 : 0,
  );
}

/** Keep rows whose train class is selected (no selection keeps all). Only the
    train-type filter narrows the station counts; search and histogram
    selections do not. */
const byClass = <T>(rows: T[], classes: string[], cls: (r: T) => string) =>
  classes.length ? rows.filter((r) => classes.includes(cls(r))) : rows;

export const depStations = (deps: DepVM[], classes: string[] = []) =>
  tallyStations(
    byClass(deps, classes, (d) => d.cls).map((d) => ({ zh: d.fsZh, en: d.fsEn })),
  );

export const arrStations = (arrs: ArrVM[], classes: string[] = []) =>
  tallyStations(
    byClass(arrs, classes, (a) => a.cls).map((a) => ({ zh: a.tsZh, en: a.tsEn })),
  );

export const inCallStations = (calls: InCallVM[], classes: string[] = []) =>
  tallyStations(
    byClass(calls, classes, (c) => c.arr.cls).map((c) => ({ zh: c.bsZh, en: c.bsEn })),
  );

/** The station a call stops at in the destination city. The pack keeps no
    station on a call row, so it is read from the train's schedule: the stops
    after boarding are the last `stopPos.length` entries, and the call is the
    one whose arrival minute matches. Null when the call cannot be placed
    (or the schedules have not loaded). */
export function callStation(
  c: CallVM,
  stationTable: { zh: string; en: string }[],
  schedules: SchedulesData["schedules"] | undefined,
): { zh: string; en: string } | null {
  const sched = schedules?.[c.dep.t];
  const n = c.dep.stopPos.length;
  if (!sched || c.arrMins === undefined || c.arrMins < 0) return null;
  const b = sched.length - 1 - n;
  const want = c.arrMins % 1440;
  for (let i = 0; i < n && b >= 0; i++) {
    const r = sched[b + 1 + i];
    if (r[1] === want) return stationTable[r[0]] || null;
  }
  return null;
}

/** Trains calling at a destination, by the station they stop at. Null until
    the schedules have loaded. A call that cannot be placed counts as
    其他 / other, keeping the sum. */
export function callStations(
  calls: CallVM[],
  stationTable: { zh: string; en: string }[],
  schedules: SchedulesData["schedules"] | undefined,
  classes: string[] = [],
): StationCount[] | null {
  if (!schedules) return null;
  const OTHER = { zh: "其他", en: "other" };
  return tallyStations(
    byClass(calls, classes, (c) => c.dep.cls).map(
      (c) => callStation(c, stationTable, schedules) || OTHER,
    ),
  );
}
