// National flows lib (P3.2) on a small synthetic pack: class-filter sums,
// widths on the origin flows' scale, the widest-first pass, the file check.
// A+B counts (P3.3, nationalCountsAt) on a synthetic entries pack and on the
// flows / entries pair (the full staged files when found, else the committed
// sample, as national.test.ts).
import { describe, expect, test } from "bun:test";
import {
  DATA_FMT,
  FLOW_CLASSES,
  flowWidth,
  nationalCounts,
  nationalCountsAt,
  nationalFlowPasses,
  nationalWidths,
  requireNationalEntries,
  requireNationalFlows,
} from "../src/lib";
import type { NationalEntriesPack, NationalFlowsPack } from "../src/types";
import { nationalFlowsPair } from "./fixture";

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

/* Synthetic entries for the 5-section pack above: by_class[c][s] holds
   byClass[c][s] sorted ticks (0.1 min) spread over the day, so at 24:00 the
   counts are the pack's. */
const syntheticEntries = (): NationalEntriesPack => ({
  fmt: DATA_FMT,
  n_sec: 5,
  trains: 12,
  ticks_per_min: 10,
  by_class: byClass.map((row, c) =>
    row.map((n, s) => Array.from({ length: n }, (_, k) => (c * 1777 + s * 523 + k * 4099) % 14400).sort((a, b) => a - b)),
  ),
});

describe("national flows by minute (A+B)", () => {
  test("upper bound: an entry counts from its own tick on", () => {
    // one section, class G: ticks 0, 0.5 min, 10:00, 10:00.1, 23:59.9
    const ne: NationalEntriesPack = {
      fmt: DATA_FMT,
      n_sec: 1,
      trains: 5,
      ticks_per_min: 10,
      by_class: [[[0, 5, 6000, 6001, 14399]], [[]], [[]], [[]], [[]], [[]], [[]], [[]]],
    };
    const at = (m: number) => nationalCountsAt(ne, [], m)[0];
    expect(at(0)).toBe(1);
    expect(at(0.4)).toBe(1);
    expect(at(0.5)).toBe(2);
    expect(at(599.9)).toBe(2);
    expect(at(600)).toBe(3);
    expect(at(600.1)).toBe(4);
    expect(at(1439.8)).toBe(4);
    expect(at(1439.9)).toBe(5);
    expect(at(1440)).toBe(5);
    expect(nationalCountsAt(ne, ["D"], 1440)[0]).toBe(0);
  });

  test("synthetic: 24:00 equals B for every class filter, monotone in the minute", () => {
    const ne = syntheticEntries();
    for (const cls of [[], ["G"], ["K", "plain"], ["G", "D", "C"], [...FLOW_CLASSES]]) {
      expect(Array.from(nationalCountsAt(ne, cls, 1440))).toEqual(Array.from(nationalCounts(nf, cls)));
    }
    let prev = nationalCountsAt(ne, [], 0);
    for (let m = 1; m <= 1440; m++) {
      const c = nationalCountsAt(ne, [], m);
      for (let s = 0; s < 5; s++) expect(c[s]).toBeGreaterThanOrEqual(prev[s]);
      prev = c;
    }
  });

  test("the entries file check: fmt, n_sec and section-parallel class rows", () => {
    const ne = syntheticEntries();
    expect(() => requireNationalEntries(ne, 5, "e")).not.toThrow();
    const err = (d: NationalEntriesPack, n: number) => {
      try {
        requireNationalEntries(d, n, "e");
      } catch (e) {
        return (e as Error).name;
      }
      return "ok";
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(err(ne, 6)).toBe("FmtError");
      expect(err({ ...ne, n_sec: 6 }, 6)).toBe("FmtError");
      expect(err({ ...ne, fmt: DATA_FMT + 1 }, 5)).toBe("FmtError");
      expect(err({ ...ne, ticks_per_min: 0 }, 5)).toBe("FmtError");
      expect(err({ ...ne, by_class: ne.by_class.slice(0, 7) }, 5)).toBe("FmtError");
      expect(err({ ...ne, by_class: [...ne.by_class.slice(0, 7), [[], []]] }, 5)).toBe("FmtError");
    } finally {
      console.error = quiet;
    }
  });

  const pair = nationalFlowsPair();
  const F: NationalFlowsPack = pair.flows;
  const E: NationalEntriesPack = pair.entries;
  // Expected per source, counted independently (a linear scan of every tick).
  const EXPECT = pair.source === "full" ? { sections: 9106, total: 609273, at1095: 450766 } : { sections: 466, total: 34895, at1095: 25670 };
  const sum = (a: Uint32Array) => a.reduce((x, y) => x + y, 0);

  test(`${pair.source} files: the pair matches and 24:00 equals B`, () => {
    expect(F.total.length).toBe(EXPECT.sections);
    expect(() => requireNationalFlows(F, EXPECT.sections, "flows")).not.toThrow();
    expect(() => requireNationalEntries(E, EXPECT.sections, "entries")).not.toThrow();
    expect(E.trains).toBe(F.trains);
    expect(sum(nationalCountsAt(E, [], 1440))).toBe(EXPECT.total);
    expect(sum(nationalCountsAt(E, [], 1095))).toBe(EXPECT.at1095);
    const subsets = [[], ...FLOW_CLASSES.map((c) => [c]), ["G", "D", "C"], ["S", "Z", "T", "K", "plain"], ["K", "plain"]];
    for (const cls of subsets) {
      expect(Array.from(nationalCountsAt(E, cls, 1440))).toEqual(Array.from(nationalCounts(F, cls)));
    }
  });

  test(`${pair.source} files: monotone in the minute`, () => {
    let prev = nationalCountsAt(E, [], 0);
    let bad = 0;
    for (let m = 5; m <= 1440; m += 5) {
      const c = nationalCountsAt(E, [], m);
      for (let s = 0; s < c.length; s++) if (c[s] < prev[s]) bad++;
      prev = c;
    }
    expect(bad).toBe(0);
  });

  test(`${pair.source} files: class subsets sum`, () => {
    for (const m of [0, 360, 1095, 1439.9, 1440]) {
      const all = nationalCountsAt(E, [], m);
      expect(Array.from(nationalCountsAt(E, [...FLOW_CLASSES], m))).toEqual(Array.from(all));
      // disjoint subsets add up; a repeated class counts once
      const a = nationalCountsAt(E, ["G", "S", "Z", "plain"], m);
      const b = nationalCountsAt(E, ["D", "C", "T", "K", "K"], m);
      expect(Array.from(a, (n, s) => n + b[s])).toEqual(Array.from(all));
      let per = new Uint32Array(all.length);
      for (const c of FLOW_CLASSES) {
        const one = nationalCountsAt(E, [c], m);
        per = per.map((n, s) => n + one[s]);
      }
      expect(Array.from(per)).toEqual(Array.from(all));
    }
  });
});
