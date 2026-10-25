// Stop effects with a destination selected: every ripple / circle-growth
// time comes from a visible train at a stop on its origin-to-destination
// leg, never from stops beyond the destination.
import { describe, expect, test } from "bun:test";
import { destWindow, stopArrivalTimes, trainShownAt } from "../src/lib";
import type { CallVM, DestVM } from "../src/types";
import { origin } from "./fixture";

const call = (code: string, arrMins: number, secCnt: number): CallVM =>
  ({ dep: { code }, arr: "00:00", dayOff: 0, arrMins, secCnt }) as unknown as CallVM;

describe("stopEffects (synthetic)", () => {
  // G1: stops A(sec 3) B(sec 6) C(sec 9). Destination B.
  const destCalls = [call("G1", 100, 6)];
  const win = destWindow(destCalls);
  const allowed = new Set(["G1"]);

  test("stops after the destination give no effect", () => {
    expect(stopArrivalTimes([call("G1", 60, 3)], allowed, win)).toEqual([60]);
    expect(stopArrivalTimes(destCalls, allowed, win)).toEqual([100]);
    expect(stopArrivalTimes([call("G1", 140, 9)], allowed, win)).toEqual([]);
  });

  test("trains outside the visible set give no effect", () => {
    expect(stopArrivalTimes([call("D9", 60, 3)], allowed, win)).toEqual([]);
  });

  test("no destination: every stop of an allowed train counts, sorted", () => {
    const t = stopArrivalTimes([call("G1", 140, 9), call("G1", 60, 3)], allowed, null);
    expect(t).toEqual([60, 140]);
  });

  test("a train is drawn only until it reaches the destination", () => {
    expect(trainShownAt("G1", 99, allowed, win)).toBe(true);
    expect(trainShownAt("G1", 101, allowed, win)).toBe(false);
    expect(trainShownAt("D9", 50, allowed, win)).toBe(false);
    expect(trainShownAt("G1", 5000, null, null)).toBe(true);
  });
});

describe("stopEffects (real origins)", () => {
  const PAIRS: [string, string][] = [
    ["上海", "杭州"],
    ["广州", "长沙"],
    ["郑州", "西安"],
    ["北京", "上海"],
  ];
  for (const [o, d] of PAIRS) {
    test(`${o} -> ${d}: effects are on the leg of the visible trains`, () => {
      const cur = origin(o);
      const dest = cur.dests.find((x) => x.zh === d) as DestVM;
      expect(dest).toBeTruthy();
      const win = destWindow(dest.calls);
      const allowed = new Set(win.keys());
      expect(allowed.size).toBeGreaterThan(0);
      let beyond = 0;
      for (const city of cur.dests as DestVM[]) {
        const times = stopArrivalTimes(city.calls, allowed, win);
        const onLeg = city.calls.filter((c) => {
          const w = win.get(c.dep.code);
          return w && c.secCnt <= w.secCnt;
        });
        expect(times.length).toBe(onLeg.length);
        beyond += city.calls.filter((c) => {
          const w = win.get(c.dep.code);
          return w && c.secCnt > w.secCnt;
        }).length;
      }
      // The data does contain stops beyond the destination; they are dropped.
      expect(beyond).toBeGreaterThan(0);
    });
  }
});
