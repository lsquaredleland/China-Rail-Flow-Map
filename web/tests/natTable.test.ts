// National trains table: rows come from the schedules, the same selection that
// filters the map picks them, and the windowing keeps a bounded slice in the DOM.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { buildNatRows, natSelect, selectNatRows, sortNatRows } from "../src/lib";
import type { NatFilter } from "../src/lib";
import { natWindow, NAT_ROW_H } from "../src/components/NationalTable";
import { ASSETS } from "./fixture";

const none: NatFilter = { classes: [], hours: [], distBins: [], durBins: [], trainCodes: [], unit: "km" };
const rd = (n: string) => JSON.parse(brotliDecompressSync(readFileSync(join(ASSETS, n + ".br"))).toString("utf8"));
const have = ["atlas-v2-shared.json", "atlas-v2-schedules.json", "atlas-v2-national-index.json"].every((n) =>
  existsSync(join(ASSETS, n + ".br")),
);

describe("national table", () => {
  test("synthetic: first / last stop, +1 day arrival, sorting", () => {
    const tt = [
      { code: "G1", class: "G", days: "11" },
      { code: "K2", class: "K", days: "10" },
    ];
    const st = [{ zh: "甲", en: "A" }, { zh: "乙", en: "B" }];
    const sched = {
      extra_stations: ["丙"],
      schedules: [
        [[0, -1, 600, 0, 0], [1, 700, 700, 0, 300]],
        [[1, -1, 1380, 0, 0], [2, 60, 60, 1, 120.5]],
      ],
    } as any;
    const rows = buildNatRows(tt, st, sched);
    expect(rows[1]).toMatchObject({ from: "乙", to: "丙", dep: 1380, arr: 1500, dur: 120, km: 120.5, days: 1 });
    expect(sortNatRows(rows.slice(), "dur", -1).map((r) => r.code)).toEqual(["K2", "G1"]);
    expect(selectNatRows(rows, Uint8Array.of(0, 1)).map((r) => r.code)).toEqual(["K2"]);
  });

  test("windowing renders a bounded slice", () => {
    expect(natWindow(0, 400, 11248)[0]).toBe(0);
    const [a, b] = natWindow(5000 * NAT_ROW_H, 400, 11248);
    expect(a).toBeGreaterThan(4900);
    expect(b - a).toBeLessThan(40);
    expect(natWindow(1e9, 400, 10)).toEqual([10, 10]);
  });

  test.skipIf(!have)("real pack: rows == filtered train count", () => {
    const shared = rd("atlas-v2-shared.json");
    const sched = rd("atlas-v2-schedules.json");
    const ix = rd("atlas-v2-national-index.json");
    const tt = shared.train_table;
    const rows = buildNatRows(tt, shared.station_table, sched);
    expect(rows.length).toBe(tt.length);
    expect(selectNatRows(rows, natSelect(tt, ix, none)).length).toBe(tt.length);
    const filters: NatFilter[] = [
      { ...none, classes: ["G"] },
      { ...none, hours: [8] },
      { ...none, classes: ["G", "D"], hours: [8, 9], durBins: [{ bin: 2, nb: 25, size: 60, label: "" }] },
      { ...none, trainCodes: [tt[5].code] },
    ];
    for (const f of filters) {
      const sel = natSelect(tt, ix, f)!;
      let n = 0;
      for (const v of sel) n += v;
      expect(selectNatRows(rows, sel).length).toBe(n);
    }
    expect(selectNatRows(rows, natSelect(tt, ix, filters[3])).length).toBe(1);
    // A sampled train: first / last stop come from the schedule.
    const r = rows[0];
    expect(r.dep).toBe(sched.schedules[0][0][2]);
  });
});
