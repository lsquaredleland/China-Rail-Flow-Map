// mapModel (stations section): selection cache, visible-train rule and
// per-station state, on the real fixture origins.
import { describe, expect, test } from "bun:test";
import { getSelCache, isTrainShown, stationStates } from "../src/lib";
import type { SelCache, SelInput, StationInput } from "../src/lib";
import type { CityPointVM, DestVM } from "../src/types";
import { origin } from "./fixture";

function setup(o: string, d: string | null) {
  const cur = origin(o);
  const dest = d ? (cur.dests.find((x) => x.zh === d) as DestVM) : null;
  if (d) expect(dest).toBeTruthy();
  const sel: SelInput = { cur, panelDest: dest, isolatedTrainCode: null, direction: "out" };
  const memo = { selCache: null as SelCache | null };
  const input = (animTime: number, over: Partial<StationInput> = {}): StationInput => ({
    points: cur.dests,
    panelDest: dest,
    hoverIdx: -1,
    dark: false,
    animEnabled: true,
    animTime,
    totalMins: cur.timeline?.totalMins,
    sk: 0.3,
    ...over,
  });
  return { cur, dest, sel, memo, input };
}

describe("mapModel stations: (h) destination window", () => {
  for (const [o, d] of [["广州", "长沙"], ["上海", "杭州"], ["郑州", "西安"]] as [string, string][]) {
    test(`${o} -> ${d}: no ripple after the last arrival at the destination, no train shown after it`, () => {
      const { cur, sel, memo, input } = setup(o, d);
      const cache = getSelCache(sel, memo);
      expect(cache?.win?.size).toBeGreaterThan(0);
      const win = cache!.win!;
      const maxArr = Math.max(...[...win.values()].map((w) => w.arrMins));
      // Cache is reused while the selection is unchanged.
      expect(getSelCache(sel, memo)).toBe(cache);

      // Every per-city arrival time lies on a visible train's leg.
      for (const times of cache!.cityTimes.values())
        for (const t of times) expect(t).toBeLessThanOrEqual(maxArr);

      let rippled = 0;
      for (let t = 0; t <= cur.timeline!.totalMins; t += 5) {
        const states = stationStates(input(t), cache);
        for (const s of states)
          if (s.ripple) {
            rippled++;
            expect(t).toBeLessThanOrEqual(maxArr + 20);
            expect(s.ripple.frac).toBeGreaterThanOrEqual(0);
            expect(s.ripple.frac).toBeLessThanOrEqual(1);
          }
      }
      expect(rippled).toBeGreaterThan(0);
      for (const s of stationStates(input(maxArr + 21), cache)) expect(s.ripple).toBeUndefined();

      for (const [code, w] of win) {
        expect(isTrainShown(sel, memo, w.arrMins - 1, code)).toBe(true);
        expect(isTrainShown(sel, memo, w.arrMins + 1, code)).toBe(false);
      }
      expect(isTrainShown(sel, memo, 100, "NOPE0")).toBe(false);
    });
  }

  test("no destination: every train is shown at any time", () => {
    const { sel, memo } = setup("上海", null);
    const cache = getSelCache(sel, memo);
    expect(cache?.allowedCodes).toBeNull();
    expect(isTrainShown(sel, memo, 5000, "G1")).toBe(true);
  });

  test("the cache is rebuilt when the selection changes", () => {
    const a = setup("上海", "杭州");
    const first = getSelCache(a.sel, a.memo);
    const second = getSelCache({ ...a.sel, panelDest: null }, a.memo);
    expect(second).not.toBe(first);
    expect(second?.allowedCodes).toBeNull();
  });
});

describe("mapModel stations: (i) dimming", () => {
  for (const dark of [false, true]) {
    test(`${dark ? "dark" : "light"}: non-selected cities dim to ${dark ? 0.16 : 0.18}`, () => {
      const { dest, sel, memo, input } = setup("上海", "杭州");
      const hover = (input(0).points.find((c: CityPointVM) => c.idx !== dest!.idx) as CityPointVM).idx;
      const states = stationStates(input(0, { dark, hoverIdx: hover }), getSelCache(sel, memo));
      expect(states.length).toBe(input(0).points.length);
      for (const s of states) {
        const full = s.idx === dest!.idx || s.idx === hover;
        expect(s.alpha).toBe(full ? 1 : dark ? 0.16 : 0.18);
      }
    });
  }

  test("no destination: all cities at full alpha", () => {
    const { sel, memo, input } = setup("上海", null);
    for (const s of stationStates(input(0), getSelCache(sel, memo))) expect(s.alpha).toBe(1);
  });

  test("a destination outside the points is appended at full alpha", () => {
    const { dest, sel, memo, input } = setup("上海", "杭州");
    const pts = input(0).points.filter((c) => c.idx !== dest!.idx);
    const states = stationStates(input(0, { points: pts }), getSelCache(sel, memo));
    expect(states.length).toBe(pts.length + 1);
    expect(states[states.length - 1].idx).toBe(dest!.idx);
    expect(states[states.length - 1].alpha).toBe(1);
  });
});
