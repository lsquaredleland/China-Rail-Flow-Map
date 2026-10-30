// National filters on the per-train index (hour / distance / duration / code):
// train selection by lookup, sums over the selected trains, and "everything
// selected equals the precomputed totals". A synthetic pack always; the real
// staged / shipped pair too when it can be found.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import {
  DATA_FMT,
  natCityCounts,
  natFlowCounts,
  natHistogram,
  natIndexActive,
  natSelect,
  nationalCounts,
  requireNationalIndex,
} from "../src/lib";
import type { NatFilter } from "../src/lib";
import type { NationalFlowsPack, NationalIndexPack, RawTrain } from "../src/types";
import { ASSETS } from "./fixture";

const none: NatFilter = { classes: [], hours: [], distBins: [], durBins: [], trainCodes: [], unit: "km" };
const delta = (a: number[]) => a.map((v, i) => (i ? v - a[i - 1] : v));

/* 4 trains over 5 sections and 3 cities (city_table ids 7, 9, 12). */
const tt = [
  { code: "G1", class: "G", ci: 0 },
  { code: "G2", class: "G", ci: 0 },
  { code: "K3", class: "K", ci: 6 },
  { code: "1461", class: "plain", ci: 7 },
] as RawTrain[];
const rows = {
  secs: [[0, 1, 2], [1, 2], [2, 3, 4], [0, 4]],
  dep: [[7], [7], [9], [12]],
  arr: [[9], [12], [12], [9]],
};
const ix: NationalIndexPack = {
  fmt: DATA_FMT,
  n_sec: 5,
  n_train: 4,
  hour: [8, 8, 22, -1],
  dist_km: [12, 5, 20, 2],
  dist_mi: [15, 6, 25, 3],
  dur: [3, 1, 12, 24],
  secs: rows.secs.map(delta),
  dep: rows.dep.map(delta),
  arr: rows.arr.map(delta),
};
const classOf = (c: string) => ["G", "D", "C", "S", "Z", "T", "K", "plain"].indexOf(c);
const total = [0, 0, 0, 0, 0];
const bc = Array.from({ length: 8 }, () => [0, 0, 0, 0, 0]);
rows.secs.forEach((r, t) => r.forEach((s) => (total[s]++, bc[classOf(tt[t].class)][s]++)));
const cityIdx = [7, 9, 12];
const dep = [0, 0, 0], arr = [0, 0, 0];
const dbc = Array.from({ length: 8 }, () => [0, 0, 0]), abc = Array.from({ length: 8 }, () => [0, 0, 0]);
rows.dep.forEach((r, t) => r.forEach((c) => (dep[cityIdx.indexOf(c)]++, dbc[classOf(tt[t].class)][cityIdx.indexOf(c)]++)));
rows.arr.forEach((r, t) => r.forEach((c) => (arr[cityIdx.indexOf(c)]++, abc[classOf(tt[t].class)][cityIdx.indexOf(c)]++)));
const nf: NationalFlowsPack = {
  fmt: DATA_FMT,
  trains: 4,
  total,
  by_class: bc,
  cities: { idx: cityIdx, dep, arr, dep_by_class: dbc, arr_by_class: abc },
};

describe("national index filters (synthetic)", () => {
  test("the check accepts a matching index and rejects a mismatch", () => {
    expect(() => requireNationalIndex(ix, 5, 4, "ix")).not.toThrow();
    expect(() => requireNationalIndex({ ...ix, n_train: 3 }, 5, 4, "ix")).toThrow();
  });
  test("no filter: no selection; class alone needs no index", () => {
    expect(natSelect(tt, ix, none)).toBeNull();
    expect(Array.from(natSelect(tt, null, { ...none, classes: ["G"] })!)).toEqual([1, 1, 0, 0]);
    expect(natIndexActive({ ...none, classes: ["G"] })).toBe(false);
  });
  test("selects by hour, distance bin (km / mi), duration bin and code; unknown matches nothing", () => {
    const sel = (f: Partial<NatFilter>) => Array.from(natSelect(tt, ix, { ...none, ...f })!);
    expect(sel({ hours: [8] })).toEqual([1, 1, 0, 0]);
    expect(sel({ hours: [22, 8] })).toEqual([1, 1, 1, 0]); // the -1 hour never matches
    const bin = (b: number) => ({ bin: b, nb: 31, size: 100, label: "" });
    expect(sel({ distBins: [bin(5), bin(2)] })).toEqual([0, 1, 0, 1]);
    expect(sel({ distBins: [bin(6)], unit: "mi" })).toEqual([0, 1, 0, 0]);
    expect(sel({ durBins: [{ bin: 24, nb: 25, size: 60, label: "" }] })).toEqual([0, 0, 0, 1]);
    expect(sel({ trainCodes: ["K3", "G1"] })).toEqual([1, 0, 1, 0]);
    expect(sel({ hours: [8], classes: ["K"] })).toEqual([0, 0, 0, 0]); // class and index filters combine
  });
  test("flows and city counts are the selected trains' rows added up", () => {
    const f: NatFilter = { ...none, hours: [8] };
    const sel = natSelect(tt, ix, f);
    expect(Array.from(natFlowCounts(nf, ix, f, sel))).toEqual([1, 2, 2, 0, 0]);
    const c = natCityCounts(nf, ix, f, sel);
    expect([c.idx, Array.from(c.dep), Array.from(c.arr)]).toEqual([cityIdx, [2, 0, 0], [0, 1, 1]]);
  });
  test("everything selected equals the precomputed totals", () => {
    const f: NatFilter = { ...none, trainCodes: tt.map((r) => r.code) };
    const sel = natSelect(tt, ix, f);
    expect(Array.from(sel!)).toEqual([1, 1, 1, 1]);
    expect(Array.from(natFlowCounts(nf, ix, f, sel))).toEqual(total);
    const c = natCityCounts(nf, ix, f, sel);
    expect([Array.from(c.dep), Array.from(c.arr)]).toEqual([dep, arr]);
    // without an index filter the totals come from the class rows
    expect(Array.from(natFlowCounts(nf, ix, none, null))).toEqual(total);
    expect(Array.from(natFlowCounts(nf, null, { ...none, classes: ["G"] }, null))).toEqual(Array.from(nationalCounts(nf, ["G"])));
  });
  test("a histogram counts one dimension under the other filters", () => {
    expect(natHistogram(tt, ix, none, "hour").slice(8, 9)).toEqual([2]);
    const dur = natHistogram(tt, ix, { ...none, hours: [8] }, "dur");
    expect([dur[3], dur[1], dur[12], dur[24]]).toEqual([1, 1, 0, 0]);
    // its own dimension is not applied to itself
    expect(natHistogram(tt, ix, { ...none, hours: [8] }, "hour")[22]).toBe(1);
  });
});

/* The real pair, when the pack has been swapped in or staged. */
function findReal(): { nf: NationalFlowsPack; ix: NationalIndexPack; train_table: RawTrain[] } | null {
  const dirs = [ASSETS];
  for (let d = join(import.meta.dir, ".."); ; d = dirname(d)) {
    dirs.push(join(d, "staging/national-cities/run1"));
    if (dirname(d) === d) break;
  }
  for (const dir of dirs) {
    const p = (n: string) => join(dir, n + ".br");
    if (!existsSync(p("atlas-v2-national-index.json")) || !existsSync(p("atlas-v2-shared.json"))) continue;
    const rd = (n: string) => JSON.parse(brotliDecompressSync(readFileSync(p(n))).toString("utf8"));
    const nfr = rd("atlas-v2-national.json");
    if (!nfr.cities) continue;
    return { nf: nfr, ix: rd("atlas-v2-national-index.json"), train_table: rd("atlas-v2-shared.json").train_table };
  }
  return null;
}
const real = findReal();
if (real) {
  describe("national index (real pack)", () => {
    test("every train selected by code equals the shipped totals", () => {
      const f: NatFilter = { ...none, trainCodes: real.train_table.map((r) => r.code) };
      const sel = natSelect(real.train_table, real.ix, f);
      expect(Array.from(natFlowCounts(real.nf, real.ix, f, sel))).toEqual(real.nf.total);
      const c = natCityCounts(real.nf, real.ix, f, sel);
      expect(Array.from(c.dep)).toEqual(real.nf.cities!.dep);
      expect(Array.from(c.arr)).toEqual(real.nf.cities!.arr);
    });
    test("each class selected through the index equals its precomputed class sums", () => {
      for (const cls of ["G", "K"]) {
        const f: NatFilter = { ...none, classes: [cls], trainCodes: real.train_table.map((r) => r.code) };
        const sel = natSelect(real.train_table, real.ix, f);
        expect(Array.from(natFlowCounts(real.nf, real.ix, f, sel))).toEqual(Array.from(nationalCounts(real.nf, [cls])));
      }
    });
  });
}
