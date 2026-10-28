// City close-ups: station grouping, the split animation, dot places and the station labels.
import { describe, expect, test } from "bun:test";
import { CLOSEUP_Z, cityStations, dotPlaces, placeLabels, retarget, scaleOfZoom, splitK, splitRadius } from "../src/lib";
import type { RawCity, RawStation } from "../src/types";

const cities: RawCity[] = [
  { zh: "成都", en: "Chengdu", pt: [104.14, 30.63] },
  { zh: "乐山", en: "Leshan", pt: [103.75, 29.55] },
];
const stations: RawStation[] = [
  { zh: "成都东", en: "Chengdu East", pt: [104.14, 30.63], city: 0, closeup: true },
  { zh: "成都西", en: "Chengdu West", pt: [103.98, 30.69], city: 0, closeup: true },
  { zh: "成都南", en: "Chengdu South", pt: [104.07, 30.61], city: 0, closeup: true },
  { zh: "郫县", en: "Pixian", pt: [103.88, 30.81], city: 0 }, // not a close-up station
  { zh: "乐山", en: "Leshan", pt: [103.75, 29.55], city: 1, closeup: true },
  { zh: "峨眉", en: "Emei", city: 1, closeup: true }, // no point: never drawn
  { zh: "某站", en: "Somewhere", pt: [100, 30], closeup: true }, // no city
];

describe("cityStations", () => {
  test("groups the flagged stations by city, keeps cities with two or more placed", () => {
    const m = cityStations(stations, cities);
    expect([...m.keys()]).toEqual(["成都"]);
    expect(m.get("成都")!.map((s) => s.zh)).toEqual(["成都东", "成都西", "成都南"]);
  });
  test("an older pack (no closeup / pt / city) splits nothing", () => {
    expect(cityStations([{ zh: "成都东", en: "Chengdu East" }], cities).size).toBe(0);
    expect(cityStations(stations.slice(0, 4).map(({ closeup, ...s }) => s), cities).size).toBe(0);
  });
});

describe("split animation", () => {
  test("z9 threshold matches the URL zoom", () => {
    expect(Math.log2((scaleOfZoom(CLOSEUP_Z) * 360) / 256)).toBeCloseTo(9, 9);
  });
  test("runs 0 → 1, eased, and ends exactly on its target", () => {
    const a = retarget({ from: 0, to: 0, at: 0 }, 1, 1000);
    expect(splitK(a, 1000)).toBe(0);
    const mid = splitK(a, 1225);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
    expect(splitK(a, 5000)).toBe(1);
  });
  test("reversing mid-way starts from where it is", () => {
    const a = retarget({ from: 0, to: 0, at: 0 }, 1, 0);
    const k = splitK(a, 100);
    const b = retarget(a, 0, 100);
    expect(b.from).toBe(k);
    expect(splitK(b, 100)).toBe(k);
    expect(retarget(b, 0, 200)).toBe(b);
  });
});

describe("dotPlaces", () => {
  const list = cityStations(stations, cities).get("成都")!;
  const pt: [number, number] = [104.1, 30.65];
  test("merged: one dot at the city", () => {
    expect(dotPlaces(pt, list, 0)).toEqual([{ pos: pt, f: 1 }]);
    expect(dotPlaces(pt, undefined, 1)).toEqual([{ pos: pt, f: 1 }]);
  });
  test("split: one dot per station at the station, sharing the city's area", () => {
    const p = dotPlaces(pt, list, 1);
    expect(p.map((d) => d.pos)).toEqual(list.map((s) => s.pt));
    expect(p[0].f).toBeCloseTo(1 / Math.sqrt(3), 9);
  });
  test("half-way: between the city and the station", () => {
    const p = dotPlaces(pt, list, 0.5)[1];
    expect(p.pos[0]).toBeCloseTo((pt[0] + 103.98) / 2, 9);
    expect(p.pos[1]).toBeCloseTo((pt[1] + 30.69) / 2, 9);
  });
  test("station dots keep a 4 px floor, never above the city's own", () => {
    expect(splitRadius(20, 1)).toBe(20);
    expect(splitRadius(20, 0.1)).toBe(4);
    expect(splitRadius(3, 0.1)).toBe(3);
    expect(splitRadius(20, 0.5)).toBe(10);
  });
});

describe("placeLabels close-ups", () => {
  const view = { scale: scaleOfZoom(9), tx: 0, ty: 0 };
  // Centre the view on Chengdu.
  view.tx = 600 - 104.06 * view.scale;
  view.ty = 400 + 30.65 * view.scale;
  const measure = (text: string) => 7 * [...text].length;
  const chengdu = { idx: 0, zh: "成都", en: "Chengdu", pt: [104.06, 30.65] as [number, number], trains: 300 };
  test("a split city's own label gives way to its stations', even with labels off", () => {
    const labels = placeLabels([chengdu], view, 1200, 800, measure, {
      origin: null,
      panelDest: null,
      showDest: false,
      fitScale: 10,
      sk: 1,
      closeups: {
        skip: new Set(["成都"]),
        stations: stations.slice(0, 3).map((s) => ({ zh: s.zh, en: s.en, pt: s.pt!, off: 6, boxed: false })),
      },
    });
    expect(labels.map((l) => l.text).sort()).toEqual(["Chengdu East · 成都东", "Chengdu South · 成都南", "Chengdu West · 成都西"]);
  });
  test("a skipped origin keeps no label of its own", () => {
    const labels = placeLabels([], view, 1200, 800, measure, {
      origin: { zh: "成都", en: "Chengdu", pt: chengdu.pt },
      panelDest: null,
      showDest: true,
      fitScale: 10,
      sk: 1,
      closeups: { skip: new Set(["成都"]), stations: [] },
    });
    expect(labels).toEqual([]);
  });
});
