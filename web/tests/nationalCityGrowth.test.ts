// National city circles grow with the clock: the selected trains' stop events
// (dep_min / arr_min of the index) counted up to the minute. Synthetic pack:
// 4 trains over 3 cities (city_table 0, 1, 2).
import { describe, expect, test } from "bun:test";
import { DATA_FMT, natCityCounts, natCityEvents, natCityEventsAt, natSelect } from "../src/lib";
import type { NatFilter } from "../src/lib";
import { NAT_RIPPLE_MIN, nationalCityDots, nationalCityLayers } from "../src/components/map/deck/layers/national";
import type { NationalFlowsPack, NationalIndexPack, RawTrain } from "../src/types";
import { pack } from "./fixture";

const { atlas } = pack();
const none: NatFilter = { classes: [], hours: [], distBins: [], durBins: [], trainCodes: [], unit: "km" };
const delta = (a: number[]) => a.map((v, i) => (i ? v - a[i - 1] : v));
const tt = [{ code: "G1", class: "G", ci: 0 }, { code: "G2", class: "G", ci: 0 }, { code: "K3", class: "K", ci: 6 }, { code: "1461", class: "plain", ci: 7 }] as RawTrain[];
const rows = {
  dep: [[0], [0], [1], [2]],
  arr: [[1], [2], [2], [1]],
  depMin: [[60], [60], [1000], [0]],
  arrMin: [[120], [600], [1439], [30]],
};
const ix: NationalIndexPack = {
  fmt: DATA_FMT,
  n_sec: 1,
  n_train: 4,
  hour: [1, 1, 16, 0],
  dist_km: [1, 1, 1, 1],
  dist_mi: [1, 1, 1, 1],
  dur: [1, 1, 1, 1],
  secs: [[0], [0], [0], [0]],
  dep: rows.dep.map(delta),
  arr: rows.arr.map(delta),
  dep_min: rows.depMin,
  arr_min: rows.arrMin,
};
const classOf = (c: string) => ["G", "D", "C", "S", "Z", "T", "K", "plain"].indexOf(c);
const dep = [0, 0, 0], arr = [0, 0, 0];
const dbc = Array.from({ length: 8 }, () => [0, 0, 0]), abc = Array.from({ length: 8 }, () => [0, 0, 0]);
rows.dep.forEach((r, t) => r.forEach((c) => (dep[c]++, dbc[classOf(tt[t].class)][c]++)));
rows.arr.forEach((r, t) => r.forEach((c) => (arr[c]++, abc[classOf(tt[t].class)][c]++)));
const nf: NationalFlowsPack = {
  fmt: DATA_FMT,
  trains: 4,
  total: [4],
  by_class: Array.from({ length: 8 }, () => [0]),
  cities: { idx: [0, 1, 2], dep, arr, dep_by_class: dbc, arr_by_class: abc },
};

function dots(f: NatFilter, t: number | null) {
  const sel = natSelect(tt, ix, f);
  const ev = natCityEvents(nf, ix, sel)!;
  return nationalCityDots(atlas, nf, natCityCounts(nf, ix, f, sel), 0, 4, t === null ? null : { ev, t })!;
}
const sorted = (d: { idx: number[] }) => [...d.idx].sort();
const sizeOf = (d: { idx: number[]; r: number[] }, city: number) => {
  const i = d.idx.indexOf(city);
  return i < 0 ? 0 : d.r[i];
};

describe("national city growth", () => {
  test("no minutes in the index: no events (circles show the totals as before)", () => {
    expect(natCityEvents(nf, { ...ix, dep_min: undefined, arr_min: undefined }, null)).toBeNull();
    expect(dots(none, null).ripple).toEqual([]);
  });
  test("events per city are the selected trains' dep + arr, sorted; all of them by 24:00", () => {
    const ev = natCityEvents(nf, ix, null)!;
    for (let i = 0; i < 3; i++) expect(natCityEventsAt(ev, i, 1439)).toBe(dep[i] + arr[i]);
    expect(Array.from(ev.minutes.subarray(ev.off[2], ev.off[3]))).toEqual([0, 600, 1439]);
    expect(natCityEventsAt(ev, 2, -1)).toBe(0);
    expect(natCityEventsAt(ev, 2, 0)).toBe(1);
    expect(natCityEventsAt(ev, 2, 999)).toBe(2);
  });
  test("empty before the first event, monotone, full size at 24:00 (the totals' size)", () => {
    expect(dots(none, -1).idx).toEqual([]);
    expect(dots(none, 0).idx).toEqual([2]); // a 00:00 event counts at 00:00
    let prev = [0, 0, 0];
    for (let t = 0; t <= 1440; t += 5) {
      const d = dots(none, t);
      const now = [0, 1, 2].map((c) => sizeOf(d, c));
      now.forEach((r, c) => expect(r).toBeGreaterThanOrEqual(prev[c]));
      prev = now;
    }
    const full = dots(none, 1440);
    const day = dots(none, null);
    expect(sorted(full)).toEqual(sorted(day));
    for (const c of day.idx) expect(sizeOf(full, c)).toBe(sizeOf(day, c));
  });
  test("a city is drawn from its first event on", () => {
    expect(sorted(dots(none, 29))).toEqual([2]);
    expect(sorted(dots(none, 30))).toEqual([1, 2]);
    expect(sorted(dots(none, 60))).toEqual([0, 1, 2]);
  });
  test("filters are respected: only the selected trains' events count", () => {
    const g = { ...none, classes: ["G"] };
    expect(sorted(dots(g, 1440))).toEqual([0, 1, 2]);
    expect(dots(g, 59).idx).toEqual([]); // train 3 (plain) is out
    const k = { ...none, trainCodes: ["K3"] };
    expect(dots(k, 999).idx).toEqual([]);
    expect(dots(k, 1000).idx).toEqual([1]);
    expect(sorted(dots(k, 1439))).toEqual([1, 2]);
  });
  test("ripple: from the event until 20 minutes after, spreading, then gone", () => {
    const at = (t: number) => {
      const d = dots(none, t);
      return d.ripple[d.idx.indexOf(0)];
    };
    expect(at(60)).toBe(0);
    expect(at(70)).toBeCloseTo(0.5);
    expect(at(60 + NAT_RIPPLE_MIN)).toBe(1);
    expect(at(60 + NAT_RIPPLE_MIN + 1)).toBe(-1);
    expect(nationalCityLayers(dots(none, 70), false).map((l) => l.id)).toContain("nat-city-ripples");
    expect(nationalCityLayers(dots(none, 300), false).map((l) => l.id)).not.toContain("nat-city-ripples");
    expect(nationalCityLayers(dots(none, null), false).map((l) => l.id)).not.toContain("nat-city-ripples");
  });
});
