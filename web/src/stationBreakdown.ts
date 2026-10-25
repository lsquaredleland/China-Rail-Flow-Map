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

export const depStations = (deps: DepVM[]) =>
  tallyStations(deps.map((d) => ({ zh: d.fsZh, en: d.fsEn })));

export const arrStations = (arrs: ArrVM[]) =>
  tallyStations(arrs.map((a) => ({ zh: a.tsZh, en: a.tsEn })));

export const inCallStations = (calls: InCallVM[]) =>
  tallyStations(calls.map((c) => ({ zh: c.bsZh, en: c.bsEn })));

/** The station a call stops at in the destination city. The pack keeps no
    station on a call row, so it is read from the train's schedule: the stops
    after boarding are the last `stopPos.length` entries, and the call is the
    one whose arrival minute matches. Null until the schedules have loaded.
    A call that cannot be placed counts as 其他 / other, keeping the sum. */
export function callStations(
  calls: CallVM[],
  stationTable: { zh: string; en: string }[],
  schedules: SchedulesData["schedules"] | undefined,
): StationCount[] | null {
  if (!schedules) return null;
  const OTHER = { zh: "其他", en: "other" };
  return tallyStations(
    calls.map((c) => {
      const sched = schedules[c.dep.t];
      const n = c.dep.stopPos.length;
      if (!sched || c.arrMins === undefined || c.arrMins < 0) return OTHER;
      const b = sched.length - 1 - n;
      const want = c.arrMins % 1440;
      for (let i = 0; i < n && b >= 0; i++) {
        const r = sched[b + 1 + i];
        if (r[1] === want) return stationTable[r[0]] || OTHER;
      }
      return OTHER;
    }),
  );
}
