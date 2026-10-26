/* The timetable modal's pure logic: a train's stops unrolled onto one
   monotonic clock (midnight rollovers), and where the train is on its run. */
import type { ScheduleStop } from "../types";
import { stationName } from "./format";

export interface UnrolledStop extends ScheduleStop {
  unrolledArr: number;
  unrolledDep: number;
}

/** The stops with arr / dep minutes counted from the first stop's day (-1 when
    absent), plus the day and last clock minute reached after the final stop. */
export function unrollStops(stops: readonly ScheduleStop[]): { stops: UnrolledStop[]; day: number; prev: number } {
  if (stops.length === 0) return { stops: [], day: 0, prev: 0 };
  let day = 0;
  let prev = stops[0].depMins >= 0 ? stops[0].depMins : stops[0].arrMins;
  const out = stops.map((s) => {
    let unrolledArr = -1;
    let unrolledDep = -1;
    if (s.arrMins >= 0) {
      if (s.arrMins < prev) day++;
      unrolledArr = day * 1440 + s.arrMins;
      prev = s.arrMins;
    }
    if (s.depMins >= 0) {
      if (s.depMins < prev) day++;
      unrolledDep = day * 1440 + s.depMins;
      prev = s.depMins;
    }
    return { ...s, unrolledArr, unrolledDep };
  });
  return { stops: out, day, prev };
}

/** A stop with its times on the simulation clock. */
export interface AlignedStop extends ScheduleStop {
  simArrMins: number;
  simDepMins: number;
}

export type TripStatus =
  | { state: "pre"; text: string }
  | { state: "post"; text: string }
  | { state: "stopped"; text: string; stopIdx: number }
  | {
      state: "transit";
      text: string;
      fromIdx: number;
      toIdx: number;
      eta: number;
      finalEta: number;
      finalEtaStr: string;
    };

/** Where the train is at `liveTime`: before departure, at a station, between
    two stops, or arrived. Null for no stops, or a time that fits none of them. */
export function tripStatus(stops: readonly AlignedStop[] | null, liveTime: number): TripStatus | null {
  if (!stops || stops.length === 0) return null;
  const first = stops[0];
  const last = stops[stops.length - 1];
  const name = (s: AlignedStop) => stationName(s.stZh, s.stEn, "zh-paren");

  if (liveTime < first.simDepMins) {
    const wait = Math.max(0, Math.round(first.simDepMins - liveTime));
    return {
      state: "pre",
      text: `Departs ${name(first)} in ${wait > 60 ? `${Math.floor(wait / 60)}h ${wait % 60}m` : `${wait}m`} (at ${first.dep})`,
    };
  }
  if (liveTime >= last.simArrMins) {
    return { state: "post", text: `Completed journey to ${name(last)} at ${last.arr}` };
  }

  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (s.simArrMins >= 0 && s.simDepMins >= 0 && liveTime >= s.simArrMins && liveTime <= s.simDepMins) {
      const rem = Math.max(0, Math.round(s.simDepMins - liveTime));
      return { state: "stopped", text: `Stopped at ${name(s)} · Departs in ${rem}m (${s.dep})`, stopIdx: i };
    }
  }

  for (let i = 0; i < stops.length - 1; i++) {
    const curr = stops[i];
    const next = stops[i + 1];
    if (liveTime >= curr.simDepMins && liveTime < next.simArrMins) {
      const eta = Math.max(0, Math.round(next.simArrMins - liveTime));
      const finalEta = Math.max(0, Math.round(last.simArrMins - liveTime));
      const finalH = Math.floor(finalEta / 60);
      const finalM = finalEta % 60;
      const finalEtaStr = finalH > 0 ? (finalM > 0 ? `${finalH}h ${finalM}m` : `${finalH}h`) : `${finalM}m`;
      return {
        state: "transit",
        text: `En route: ${name(curr)} ➔ ${name(next)} · ETA in ${finalEtaStr} (${last.arr})`,
        fromIdx: i,
        toIdx: i + 1,
        eta,
        finalEta,
        finalEtaStr,
      };
    }
  }
  return null;
}
