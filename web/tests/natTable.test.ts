// National trains table: rows come from the schedules, the same selection that
// filters the map picks them, and the windowing keeps a bounded slice in the DOM.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { buildNatRows, natHistRows, natSelect, selectNatRows, sortNatRows } from "../src/lib";
import type { NatFilter } from "../src/lib";
import { NAT_ROW_H, rowWindow } from "../src/components/departures/WindowedTable";
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
    expect(rows[1]).toMatchObject({ from: "乙", to: "丙", dep: 1380, arr: 1500, dur: 120, km: 120.5 });
    expect(sortNatRows(rows.slice(), "dur", -1).map((r) => r.code)).toEqual(["K2", "G1"]);
    expect(selectNatRows(rows, Uint8Array.of(0, 1)).map((r) => r.code)).toEqual(["K2"]);
  });

  test("windowing renders a bounded slice", () => {
    expect(rowWindow(0, 400, 11248, NAT_ROW_H)[0]).toBe(0);
    const [a, b] = rowWindow(5000 * NAT_ROW_H, 400, 11248, NAT_ROW_H);
    expect(a).toBeGreaterThan(4900);
    expect(b - a).toBeLessThan(40);
    expect(rowWindow(1e9, 400, 10, NAT_ROW_H)).toEqual([10, 10]);
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
    // km is the legs added up (the last stop's own leg alone would be tiny).
    expect(r.km).toBeGreaterThan(sched.schedules[0][sched.schedules[0].length - 1][4]);
    // Search: by train code and by an end station's name.
    expect(rows.filter((x) => x.hay.indexOf(tt[5].code.toLowerCase()) !== -1).length).toBeGreaterThan(0);
    expect(rows.filter((x) => x.hay.indexOf("guangzhou") !== -1).length).toBeGreaterThan(100);
  });

  test.skipIf(!have)("real pack: histogram rows fall in the index's bins, so a bar counts what a click selects", () => {
    const shared = rd("atlas-v2-shared.json");
    const sched = rd("atlas-v2-schedules.json");
    const ix = rd("atlas-v2-national-index.json");
    const rows = buildNatRows(shared.train_table, shared.station_table, sched);
    for (const unit of ["km", "mi"] as const) {
      const hr = natHistRows(rows, ix, unit);
      expect(hr.length).toBe(rows.length);
      const size = unit === "km" ? 100 : 50;
      const bins = unit === "km" ? ix.dist_km : ix.dist_mi;
      const nb = unit === "km" ? 31 : 41;
      hr.forEach((h, i) => {
        const v = unit === "km" ? h.distKm : h.distKm * 0.621371;
        expect(Math.min(nb - 1, Math.floor(v / size))).toBe(bins[rows[i].t]);
        expect(Number(h.time.slice(0, 2))).toBe(ix.hour[rows[i].t]);
        expect(Math.min(24, Math.floor(h.dur / 60))).toBe(ix.dur[rows[i].t]);
      });
    }
    expect(natHistRows(rows, null, "km")).toEqual([]);
  });
});
