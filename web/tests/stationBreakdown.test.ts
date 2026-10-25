// Station breakdown headings: counts per station sum to the heading's number.
import { describe, expect, test } from "bun:test";
import { filterOrigin } from "../src/lib";
import {
  arrStations,
  callStations,
  depStations,
  inCallStations,
  tallyStations,
} from "../src/stationBreakdown";
import { origin, pack } from "./fixture";

const sum = (s: { n: number }[]) => s.reduce((a, x) => a + x.n, 0);

test("tally sorts by count desc then name", () => {
  const r = tallyStations([
    { zh: "乙", en: "B" },
    { zh: "甲", en: "A" },
    { zh: "乙", en: "B" },
    { zh: "丙", en: "C" },
  ]);
  expect(r.map((x) => x.zh + x.n)).toEqual(["乙2", "丙1", "甲1"]);
});

describe("departures from a city", () => {
  test("重庆: several stations, sum == departures, filters respected", () => {
    const o = origin("重庆");
    const s = depStations(o.deps);
    expect(s.length).toBeGreaterThan(2);
    expect(sum(s)).toBe(o.deps.length);
    expect(s.map((x) => x.zh)).toContain("重庆北");
    const f = filterOrigin(o, { classes: ["G"] });
    expect(sum(depStations(f.deps))).toBe(f.deps.length);
    expect(f.deps.length).toBeLessThan(o.deps.length);
  });
  test("other cities sum too", () => {
    for (const zh of ["成都", "北京", "拉萨"]) {
      const o = origin(zh);
      expect(sum(depStations(o.deps))).toBe(o.deps.length);
    }
  });
});

describe("trains calling at a destination", () => {
  test("重庆 -> 成都: stations sum to the call count, with and without class filters", () => {
    const { atlas } = pack();
    const st = atlas.data.station_table;
    for (const cls of [[], ["G"], ["D", "C"]]) {
      const cur = filterOrigin(origin("重庆"), { classes: cls });
      const d = cur.dests.find((x) => x.zh === "成都")!;
      const s = callStations(d.calls, st, atlas.schedules)!;
      expect(sum(s)).toBe(d.calls.length);
      expect(s.some((x) => x.zh === "其他")).toBe(false);
      expect(s.map((x) => x.zh)).toContain("成都东");
    }
  });
  test("calls of several origins resolve to stations", () => {
    const { atlas } = pack();
    for (const zh of ["北京", "广州"]) {
      let calls = 0;
      let other = 0;
      for (const d of origin(zh).dests.slice(0, 20)) {
        const s = callStations(d.calls, atlas.data.station_table, atlas.schedules)!;
        expect(sum(s)).toBe(d.calls.length);
        calls += d.calls.length;
        other += s.filter((x) => x.zh === "其他").reduce((a, x) => a + x.n, 0);
      }
      expect(other / calls).toBeLessThan(0.01);
    }
  });
  test("null while schedules are not loaded", () => {
    expect(callStations([], [], undefined)).toBeNull();
  });
});

describe("inbound", () => {
  // The fixture loads only the outbound pack, so use hand-made rows.
  test("arrivals and arriving-from rows sum to their counts", () => {
    const arrs = [
      { tsZh: "成都东", tsEn: "Chengdu East" },
      { tsZh: "成都", tsEn: "Chengdu" },
      { tsZh: "成都东", tsEn: "Chengdu East" },
    ] as any[];
    const a = arrStations(arrs);
    expect(a.map((x) => x.zh + x.n)).toEqual(["成都东2", "成都1"]);
    expect(sum(a)).toBe(arrs.length);
    const calls = [
      { bsZh: "重庆北", bsEn: "Chongqing North" },
      { bsZh: "重庆西", bsEn: "Chongqing West" },
      { bsZh: "重庆北", bsEn: "Chongqing North" },
    ] as any[];
    const c = inCallStations(calls);
    expect(c.map((x) => x.zh + x.n)).toEqual(["重庆北2", "重庆西1"]);
    expect(sum(c)).toBe(calls.length);
  });
});

describe("class filters narrow the station counts", () => {
  test("departures: sum == class-filtered rows, zero stations dropped", () => {
    const o = origin("广州");
    const all = depStations(o.deps);
    for (const cls of [["G"], ["G", "D"], ["K"]]) {
      const rows = o.deps.filter((d) => cls.includes(d.cls));
      const s = depStations(o.deps, cls);
      expect(sum(s)).toBe(rows.length);
      expect(s.every((x) => x.n > 0)).toBe(true);
      expect(s.length).toBeLessThanOrEqual(all.length);
    }
    expect(sum(depStations(o.deps, []))).toBe(o.deps.length);
    expect(depStations(o.deps, ["#"])).toEqual([]);
  });
  test("calls at a destination", () => {
    const { atlas } = pack();
    const d = origin("重庆").dests.find((x) => x.zh === "成都")!;
    for (const cls of [["G"], ["D", "C"]]) {
      const rows = d.calls.filter((c) => cls.includes(c.dep.cls));
      const s = callStations(d.calls, atlas.data.station_table, atlas.schedules, cls)!;
      expect(sum(s)).toBe(rows.length);
      expect(s.every((x) => x.n > 0)).toBe(true);
    }
  });
  test("inbound arrivals and arrive-from", () => {
    const arrs = [
      { cls: "G", tsZh: "甲", tsEn: "A" },
      { cls: "D", tsZh: "乙", tsEn: "B" },
      { cls: "G", tsZh: "乙", tsEn: "B" },
    ] as any[];
    const a = arrStations(arrs, ["G"]);
    expect(a.map((x) => x.zh + x.n)).toEqual(["乙1", "甲1"]);
    expect(arrStations(arrs, ["D"]).map((x) => x.zh)).toEqual(["乙"]);
    const calls = [
      { arr: { cls: "G" }, bsZh: "甲", bsEn: "A" },
      { arr: { cls: "K" }, bsZh: "乙", bsEn: "B" },
      { arr: { cls: "G" }, bsZh: "甲", bsEn: "A" },
    ] as any[];
    const c = inCallStations(calls, ["G"]);
    expect(c.map((x) => x.zh + x.n)).toEqual(["甲2"]);
    expect(sum(inCallStations(calls, ["G", "K"]))).toBe(3);
  });
});
