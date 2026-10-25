// National flows lib (P3.2) on a small synthetic pack: class-filter sums,
// widths on the origin flows' scale, the widest-first pass, the file check.
import { describe, expect, test } from "bun:test";
import {
  DATA_FMT,
  FLOW_CLASSES,
  flowWidth,
  nationalCounts,
  nationalFlowPasses,
  nationalWidths,
  requireNationalFlows,
} from "../src/lib";
import type { NationalFlowsPack } from "../src/types";

// 5 sections; class rows in FLOW_CLASSES order (G D C S Z T K plain).
// Section 3 carries no trains; sections 1 and 4 tie on total.
const byClass = [
  [4, 0, 1, 0, 2], // G
  [1, 2, 0, 0, 0], // D
  [0, 0, 3, 0, 0], // C
  [0, 1, 0, 0, 0], // S
  [0, 0, 0, 0, 1], // Z
  [2, 0, 0, 0, 0], // T
  [0, 3, 0, 0, 3], // K
  [3, 0, 1, 0, 0], // plain
];
const total = [10, 6, 5, 0, 6];
const nf: NationalFlowsPack = { fmt: DATA_FMT, trains: 12, total, by_class: byClass };

describe("national flows", () => {
  test("the classes sum to the total on every section", () => {
    for (let s = 0; s < total.length; s++) {
      expect(byClass.reduce((a, row) => a + row[s], 0)).toBe(total[s]);
    }
    expect(Array.from(nationalCounts(nf, [...FLOW_CLASSES]))).toEqual(total);
  });

  test("no class filter is the total", () => {
    expect(Array.from(nationalCounts(nf, []))).toEqual(total);
  });

  test("class filter subsets sum the selected rows", () => {
    expect(Array.from(nationalCounts(nf, ["G"]))).toEqual([4, 0, 1, 0, 2]);
    expect(Array.from(nationalCounts(nf, ["G", "D", "C"]))).toEqual([5, 2, 4, 0, 2]);
    expect(Array.from(nationalCounts(nf, ["K", "plain"]))).toEqual([3, 3, 1, 0, 3]);
    // a repeated class counts once
    expect(Array.from(nationalCounts(nf, ["T", "T"]))).toEqual([2, 0, 0, 0, 0]);
    // complementary subsets add up to the total
    const a = nationalCounts(nf, ["G", "S", "Z", "plain"]);
    const b = nationalCounts(nf, ["D", "C", "T", "K"]);
    expect(Array.from(a, (n, s) => n + b[s])).toEqual(total);
  });

  test("widths use the origin flows' width scale", () => {
    const counts = nationalCounts(nf, []);
    for (const [scale, fit] of [[100, 100], [350, 100], [40, 100]]) {
      const w = nationalWidths(counts, scale, fit);
      expect(Array.from(w)).toEqual(total.map((n) => Math.fround(flowWidth(n, scale, fit))));
    }
    // the hairline floor applies to empty sections too (they are not drawn)
    expect(nationalWidths(counts, 100, 100)[3]).toBe(0.5);
  });

  test("one pass, n > 0 only, widest first, ties in section order", () => {
    const passes = nationalFlowPasses(nationalCounts(nf, []));
    expect(passes.length).toBe(1);
    const p = passes[0];
    expect(p.items).toEqual([
      { s: 0, n: 10 },
      { s: 1, n: 6 },
      { s: 4, n: 6 },
      { s: 2, n: 5 },
    ]);
    expect(p.maxN).toBe(10);
    expect(p.alpha).toBe(1);
    expect(p.role).toBe("all");
    expect(p.pickable).toBe(true);
    const g = nationalFlowPasses(nationalCounts(nf, ["S"]))[0];
    expect(g.items).toEqual([{ s: 1, n: 1 }]);
    expect(g.maxN).toBe(1);
    expect(nationalFlowPasses(new Uint32Array(3))[0]).toMatchObject({ items: [], maxN: 1 });
  });

  test("the file check: fmt and section-parallel arrays", () => {
    expect(() => requireNationalFlows(nf, 5, "n")).not.toThrow();
    const err = (d: NationalFlowsPack, n: number) => {
      try {
        requireNationalFlows(d, n, "n");
      } catch (e) {
        return (e as Error).name;
      }
      return "ok";
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(err(nf, 6)).toBe("FmtError");
      expect(err({ ...nf, fmt: DATA_FMT + 1 }, 5)).toBe("FmtError");
      expect(err({ ...nf, by_class: byClass.slice(0, 7) }, 5)).toBe("FmtError");
      expect(err({ ...nf, by_class: [...byClass.slice(0, 7), [1, 2]] }, 5)).toBe("FmtError");
    } finally {
      console.error = quiet;
    }
  });
});
