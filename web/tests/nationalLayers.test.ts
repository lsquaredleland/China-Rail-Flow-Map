// National-mode deck layers (P2.2): the frame buffers from natPositions, the
// layer props, and the ?natSynth load. No GPU.
import { describe, expect, test } from "bun:test";
import { DATA_FMT, NAT_WIDTH_FACTOR, STATION_R_MAX, STATION_R_MIN, WIDTH_K, classIndex, flowUnits, natCityCounts, natCityR, natPositions, natSelect, natTrainVM, stationR, tooltipHtml } from "../src/lib";
import { nationalFlowsPair } from "./fixture";
import type { NatFilter } from "../src/lib";

const NOF: NatFilter = { classes: [], hours: [], distBins: [], durBins: [], trainCodes: [], unit: "km" };
import type { NationalTrainsData } from "../src/types";
import { maxDots, natView, nationalCityDots, nationalFlowLayers, nationalFrame, nationalHighlight, nationalKeep, nationalLayers, nationalTimeline, synthNational } from "../src/components/map/deck/layers/national";
import { glowOf } from "../src/components/map/deck/layers/trains";
import { nationalTrains, pack } from "./fixture";

const { atlas } = pack();
const data: NationalTrainsData = { trains: nationalTrains().data, schedules: atlas.schedules! };
const { tl } = nationalTimeline(atlas, data)!;

describe("national layers", () => {
  test("the timeline is built once per (atlas, file)", () => {
    expect(nationalTimeline(atlas, data)!.tl).toBe(tl);
    expect(nationalTimeline(atlas, null)).toBeNull();
  });

  test("frame: every dot coloured by class, tails for movers, rings for dwellers", () => {
    const f = nationalFrame(tl, atlas, 1095, 100);
    const ref = new Float32Array(maxDots(tl) * 6);
    expect(f.count).toBe(natPositions(tl, atlas, 1095, ref));
    expect(f.buf.length).toBeGreaterThanOrEqual(f.count * 6);
    let dwell = 0, moving = 0;
    for (let i = 0; i < f.count; i++) {
      const flags = f.buf[i * 6 + 5];
      const g = glowOf(["G", "K", ""][flags & 15]);
      expect([...f.line.subarray(i * 4, i * 4 + 4)]).toEqual([g[0], g[1], g[2], 255]);
      if (flags & 16) dwell++;
      else if (Math.round(12 * f.buf[i * 6 + 4]) > 0) moving++;
    }
    expect(f.dwellCount).toBe(dwell);
    expect(f.tailCount).toBe(moving);
    expect(dwell).toBeGreaterThan(0);
    expect(moving).toBeGreaterThan(0);
    // a tail ends at its dot and is at most 12 px long at scale 100
    const L = Math.hypot(f.tailTgt[0] - f.tailSrc[0], f.tailTgt[1] - f.tailSrc[1]) * 100;
    expect(L).toBeLessThanOrEqual(12.001);
  });

  test("layers: strided dot positions, pickable only when asked", () => {
    const f = nationalFrame(tl, atlas, 1095, 100);
    const [tails, dots, rings] = nationalLayers(f, false);
    expect([tails.id, dots.id, rings.id]).toEqual(["nat-tails", "nat-trains", "nat-dwell"]);
    const pos = (dots.props.data as { attributes: { getPosition: { stride: number; value: Float32Array } } }).attributes.getPosition;
    expect([pos.stride, pos.value]).toEqual([24, f.buf]);
    expect(dots.props.pickable).toBe(false);
    expect(nationalLayers(f, true)[1].props.pickable).toBe(true);
    expect(tails.props.pickable).toBe(false);
  });

  test("natSynth: copies shifted by 37 min, positions of the originals unchanged", () => {
    const s = synthNational(tl, tl.n * 2 + 5);
    expect(s.n).toBe(tl.n * 2 + 5);
    expect(s.start[tl.n]).toBe(tl.start[0] + 37);
    expect(s.end[2 * tl.n + 4]).toBe(tl.end[4] + 74);
    const a = new Float32Array(maxDots(s) * 6), b = new Float32Array(maxDots(tl) * 6);
    // copy k at m + 37k is the original at m
    const ca = natPositions(s, atlas, 600, a);
    const cb = natPositions(tl, atlas, 600, b);
    expect(ca).toBeGreaterThan(cb);
    expect([...a.subarray(0, cb * 6)]).toEqual([...b.subarray(0, cb * 6)]);
    expect(synthNational(tl, tl.n)).toBe(tl);
  });
  test("running counts distinct trains: a run over 24 h shows two dots but is one train", () => {
    const f = nationalFrame(tl, atlas, 1095, 100);
    expect(f.running).toBe(new Set(f.qOf.subarray(0, f.count)).size);
    expect(f.running).toBeLessThanOrEqual(f.count);
    const long = { ...tl, end: Float32Array.from(tl.end, (e) => e + 1500) };
    const g = nationalFrame(long, atlas, 600, 100);
    expect(g.count).toBeGreaterThan(g.running);
    expect(g.running).toBe(new Set(g.qOf.subarray(0, g.count)).size);
  });

  test("natTrainVM: the tooltip view-model of a dot", () => {
    const f = nationalFrame(tl, atlas, 1095, 100);
    for (let i = 0; i < f.count; i += 7) {
      const q = f.qOf[i];
      const k = Math.ceil((tl.start[q] - 1095) / 1440);
      let first = i;
      while (first > 0 && f.qOf[first - 1] === q) first--;
      const vm = natTrainVM(tl, atlas.data, data.schedules, q, 1095 + 1440 * (k + i - first), f.buf[i * 6], f.buf[i * 6 + 1], f.buf[i * 6 + 2], f.buf[i * 6 + 3]);
      expect(vm.code).toBe(atlas.data.train_table[tl.tIdx[q]].code);
      expect(vm.progressPct).toBeGreaterThanOrEqual(0);
      expect(vm.progressPct).toBeLessThanOrEqual(100);
      expect(vm.fromStation).not.toBe("");
      expect(!!vm.isDwelling).toBe((f.buf[i * 6 + 5] & 16) !== 0);
      expect(tooltipHtml({ kind: "train", train: vm }, { data: atlas.data, cur: null as never, direction: "out", distUnit: "km", panelDest: null, dark: false, ferry: false })).toContain(vm.code);
    }
  });
});

describe("national class filter on the dots", () => {
  const classOf = (q: number) => atlas.data.train_table[tl.tIdx[q]].class;
  test("no filter keeps everything (null mask)", () => {
    expect(nationalKeep(tl, natSelect(atlas.data.train_table, null, { ...NOF, classes: [] }))).toBeNull();
  });
  test("the mask is the train_table class lookup", () => {
    const keep = nationalKeep(tl, natSelect(atlas.data.train_table, null, { ...NOF, classes: ["G"] }))!;
    let g = 0;
    for (let q = 0; q < tl.n; q++) {
      expect(keep[q]).toBe(classIndex(classOf(q)) === 0 ? 1 : 0);
      g += keep[q];
    }
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThan(tl.n);
  });
  test("frames hold only the selected classes' dots; the classes partition the all-class frame", () => {
    const all = nationalFrame(tl, atlas, 1095, 100).count;
    const g = nationalFrame(tl, atlas, 1095, 100, nationalKeep(tl, natSelect(atlas.data.train_table, null, { ...NOF, classes: ["G"] }))).count;
    const rest = nationalFrame(tl, atlas, 1095, 100, nationalKeep(tl, natSelect(atlas.data.train_table, null, { ...NOF, classes: ["D", "C", "S", "Z", "T", "K", "plain"] }))).count;
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThan(all);
    expect(g + rest).toBe(all);
    const f = nationalFrame(tl, atlas, 1095, 100, nationalKeep(tl, natSelect(atlas.data.train_table, null, { ...NOF, classes: ["G"] })));
    for (let i = 0; i < f.count; i++) expect(classIndex(classOf(f.qOf[i]))).toBe(0);
  });
});

describe("national city circles", () => {
  const nCities = atlas.data.city_table.length;
  const z = () => new Array(nCities >= 2 ? 2 : 1).fill(0);
  const nf = {
    fmt: DATA_FMT,
    trains: 0,
    total: [],
    by_class: [],
    cities: {
      idx: [0, 1],
      dep: [100, 0],
      arr: [50, 0],
      dep_by_class: [[100, 0], ...Array.from({ length: 7 }, z)],
      arr_by_class: [[20, 0], [30, 0], ...Array.from({ length: 6 }, z)],
    },
  };
  test("a pack without cities draws none", () => {
    expect(nationalCityDots(atlas, { ...nf, cities: undefined }, natCityCounts(nf, null, { ...NOF, classes: [] }, null), 0)).toBeNull();
  });
  test("radius from departures + arrivals, empty cities left out, class filter applied", () => {
    const d = nationalCityDots(atlas, nf, natCityCounts(nf, null, { ...NOF, classes: [] }, null), 0)!;
    expect(d.idx).toEqual([0]);
    expect([d.dep[0], d.arr[0]]).toEqual([100, 50]);
    expect(d.pos[0]).toEqual(atlas.data.city_table[0].pt);
    const g = nationalCityDots(atlas, nf, natCityCounts(nf, null, { ...NOF, classes: ["G"] }, null), 0)!;
    expect([g.dep[0], g.arr[0]]).toEqual([100, 20]);
    expect(g.r[0]).toBeLessThan(d.r[0]);
    expect(nationalCityDots(atlas, nf, natCityCounts(nf, null, { ...NOF, classes: ["D"] }, null), 0)!.idx).toEqual([0]);
    expect(nationalCityDots(atlas, nf, natCityCounts(nf, null, { ...NOF, classes: ["C"] }, null), 0)!.idx).toEqual([]);
  });
  test("tooltip: city name, departures and arrivals", () => {
    const html = tooltipHtml({ kind: "natCity", idx: 0, dep: 1234, arr: 1 }, { data: atlas.data } as never);
    const c = atlas.data.city_table[0];
    expect(html).toContain(c.zh);
    expect(html).toContain("1,234 departures");
    expect(html).toContain("1 arrival");
  });
});

describe("national flow picking and circle size", () => {
  const pair = nationalFlowsPair();
  const nfReal = pair.flows;
  const view = natView(atlas, nfReal, null, NOF);
  const out = nationalFlowLayers({ atlas, nf: nfReal, ne: null, minute: null, classes: [], view, dark: false, scale: 100, fitScale: 100 });
  test("the flows come with a hairline pick proxy mapping paths to sections", () => {
    const pick = out.layers.find((l) => l.id === "pick-flows-national")!;
    expect(pick).toBeDefined();
    expect(pick.props.pickable).toBe(true);
    const idxToSec = (pick.props as unknown as { idxToSec: Int32Array }).idxToSec;
    expect(idxToSec.length).toBeGreaterThan(0);
    for (let i = 0; i < idxToSec.length; i++) expect(out.counts[idxToSec[i]]).toBeGreaterThan(0);
    // widest first: the first path belongs to the busiest section
    expect(out.counts[idxToSec[0]]).toBe(Math.max(...Array.from(out.counts)));
  });
  test("the hover highlight is one wider path on the hovered section", () => {
    const n = 40;
    const [h] = nationalHighlight(atlas, 0, n, 100, 100, false);
    expect(h.id).toBe("nat-seg-highlight");
    expect(h.props.getWidth).toBeCloseTo(Math.max(0.5, flowUnits(n) * WIDTH_K * NAT_WIDTH_FACTOR) + 1.6, 9);
  });
  test("natCityR: half the origin radius at the reference counts, monotone, bounded", () => {
    for (const n of [100, 300]) expect(natCityR(n)).toBeCloseTo(stationR(n) / 2, 9);
    expect(natCityR(0)).toBe(STATION_R_MIN);
    let prev = 0;
    for (let n = 0; n <= 20000; n += 25) {
      const r = natCityR(n);
      expect(r).toBeGreaterThanOrEqual(prev);
      expect(r).toBeLessThanOrEqual(STATION_R_MAX);
      prev = r;
    }
    // the top end is compressed: 2000 trains draw smaller than half the origin's 2000
    expect(natCityR(2000)).toBeLessThan(stationR(2000) / 2);
  });
});
