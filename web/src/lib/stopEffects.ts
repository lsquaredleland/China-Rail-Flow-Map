/* Which trains are drawn, and where they get a stop effect (arrival ripple,
   city-circle growth), for an outbound selection. One rule: a train only
   exists on the map between its boarding and the selected destination, and
   every stop effect comes from that same train at a stop on that leg.
   Pure data in, pure data out; the canvas layers only draw the result. */
import type { CallVM } from "../types";

/** Per train code: when it reaches the selected destination and how many
    route sections that is from the origin. */
export type DestWindow = Map<string, { arrMins: number; secCnt: number }>;

/** Total minutes from the boarding midnight to the call's arrival. */
function callArrMins(call: CallVM): number {
  if (call.arrMins !== undefined) return call.arrMins;
  return (
    call.dayOff * 1440 +
    parseInt(call.arr.slice(0, 2), 10) * 60 +
    parseInt(call.arr.slice(3, 5), 10)
  );
}

/** The visible trains for a selected destination: every train calling there,
    keyed by code. */
export function destWindow(destCalls: CallVM[]): DestWindow {
  const win: DestWindow = new Map();
  for (const c of destCalls) {
    if (!c.dep || !c.dep.code) continue;
    win.set(c.dep.code, { arrMins: callArrMins(c), secCnt: c.secCnt });
  }
  return win;
}

/** Is the train drawn at minute `t`? Beyond the destination it is not: the
    selection ends the journey there (`win` null = no destination chosen). */
export function trainShownAt(
  code: string,
  t: number,
  allowed: Set<string> | null,
  win: DestWindow | null,
): boolean {
  if (allowed && !allowed.has(code)) return false;
  const w = win?.get(code);
  return !w || t <= w.arrMins;
}

/** Sorted arrival minutes of the visible trains at one city, counting only
    stops on the origin-to-destination leg (a stop beyond the destination,
    or of a train that is not visible, never produces an effect). */
export function stopArrivalTimes(
  cityCalls: CallVM[],
  allowed: Set<string>,
  win: DestWindow | null,
): number[] {
  const times: number[] = [];
  for (const call of cityCalls) {
    const code = call.dep?.code;
    if (!code || !allowed.has(code)) continue;
    const w = win?.get(code);
    if (w && call.secCnt > w.secCnt) continue;
    const m = callArrMins(call);
    if (typeof m === "number" && !isNaN(m) && m >= 0) times.push(m);
  }
  times.sort((a, b) => a - b);
  return times;
}
