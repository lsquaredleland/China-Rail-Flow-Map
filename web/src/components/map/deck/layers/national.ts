/* National-mode layers. The flows (B, P3.2; A+B, P3.3) are at the end of
   this file. Trains (A, P2.2): every national train's dot, tail and
   dwell ring at the clock's minute, wrap-around (lib natPositions). The
   timeline is built once per (atlas, national trains file) on the first
   national frame; each frame then fills pooled buffers:

     frame.buf   natPositions' 6 floats per dot (lon, lat, ux, uy, speed,
                 cls | dwell<<4), read by the dot layer directly as a
                 strided binary attribute (§2.2: stride 24, offset 0)
     line        the dot's glow colour, 4 B per dot, by speed class
     tail*       source / target / colour of each moving dot's tail
     dwell*      position / colour of each dwelling dot's ring

   Same marks as the origin view's train layers (layers/trains.ts): dot radius
   3 px with a 2 px glow ring over a white core, tails 12 px × speed fraction,
   dwell ring 6.5 px. `?natSynth=N` (perf runs only) repeats the trains with a
   +37 min shift until there are about N. No module state shared with the
   entry bundle (C23): the cache and the pool are private to this chunk. */
import type { Layer } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type {
  DecodedAtlas,
  NationalEntriesPack,
  NationalFlowsPack,
  NationalIndexPack,
  NationalTimeline,
  NationalTrainsData,
} from "../../../../types";
import {
  NAT_WIDTH_FACTOR,
  WIDTH_K,
  flowUnits,
  flowWidth,
  buildNational,
  natPositions,
  natXY,
  natCityCounts,
  natCityEvents,
  natCityEventsAt,
  natFilterKey,
  natFlowCounts,
  natIndexActive,
  natSelect,
  nationalCountsAt,
  nationalFlowPasses,
  palette,
  rgba,
  natCityR,
  natCityTier,
  stationZoomK,
} from "../../../../lib";
import type { CityPointVM } from "../../../../types";
import type { InfraPass, NatCityEvents, NatFilter } from "../../../../lib";
import { TailLayer } from "../TailLayer";
import type { PassData } from "./flows";
import { buildPassData, infraLayers, passDataLayers, recountPassData, wholePath } from "./flows";
import { rippleRing } from "./stations";
import type { Ripple } from "./stations";
import { glowOf } from "./trains";

/** Glow colour per NationalTimeline class: 0 G/D/C, 1 Z/T/K/S, 2 other. */
const GLOW = [glowOf("G"), glowOf("K"), glowOf("")];

/** Copies of every train, each shifted by +37 min from the last, until n is
    `target` (perf load only). Each copy repeats its path refs and stops, since
    natXY reads a train's refs as pOff[q] .. pOff[q + 1]. */
export function synthNational(tl: NationalTimeline, target: number): NationalTimeline {
  if (tl.n === 0 || target <= tl.n) return tl;
  const n = target;
  const reps = Math.ceil(n / tl.n);
  const nP = tl.pId.length * reps, nS = tl.sDist.length * reps;
  const out: NationalTimeline = {
    ...tl,
    n,
    tIdx: new Int32Array(n),
    cls: new Uint8Array(n),
    start: new Float32Array(n),
    end: new Float32Array(n),
    total: new Float64Array(n),
    pOff: new Int32Array(n + 1),
    pId: new Int32Array(nP),
    pStart: new Float64Array(nP),
    sOff: new Int32Array(n + 1),
    sDist: new Float64Array(nS),
    sArr: new Float32Array(nS),
    sDep: new Float32Array(nS),
  };
  let pi = 0, si = 0;
  for (let i = 0; i < n; i++) {
    const q = i % tl.n;
    const sh = Math.floor(i / tl.n) * 37;
    out.tIdx[i] = tl.tIdx[q];
    out.cls[i] = tl.cls[q];
    out.start[i] = tl.start[q] + sh;
    out.end[i] = tl.end[q] + sh;
    out.total[i] = tl.total[q];
    const a = tl.pOff[q], b = tl.pOff[q + 1];
    out.pOff[i] = pi;
    out.pId.set(tl.pId.subarray(a, b), pi);
    out.pStart.set(tl.pStart.subarray(a, b), pi);
    pi += b - a;
    out.sOff[i] = si;
    for (let s = tl.sOff[q]; s < tl.sOff[q + 1]; s++, si++) {
      out.sDist[si] = tl.sDist[s];
      out.sArr[si] = tl.sArr[s] + sh;
      out.sDep[si] = tl.sDep[s] < 0 ? -1 : tl.sDep[s] + sh;
    }
  }
  out.pOff[n] = pi;
  out.sOff[n] = si;
  return out;
}

const SYNTH = typeof location !== "undefined" ? +(new URLSearchParams(location.search).get("natSynth") || 0) : 0;

let built: { atlas: DecodedAtlas; data: NationalTrainsData; tl: NationalTimeline; ms: number } | null = null;

/** The national timeline for this atlas and trains file, built on first use. */
export function nationalTimeline(atlas: DecodedAtlas, data: NationalTrainsData | null | undefined): { tl: NationalTimeline; ms: number } | null {
  if (!data) return null;
  if (!built || built.atlas !== atlas || built.data !== data) {
    const t0 = performance.now();
    let tl = buildNational(atlas, data.trains, data.schedules);
    if (SYNTH > tl.n) tl = synthNational(tl, SYNTH);
    built = { atlas, data, tl, ms: performance.now() - t0 };
  }
  return built;
}

/** Most dots the timeline can show at once: a run of L minutes covers at
    most floor(L / 1440) + 1 instants m + 1440k. */
export function maxDots(tl: NationalTimeline): number {
  let c = 0;
  for (let q = 0; q < tl.n; q++) c += Math.floor(Math.max(0, tl.end[q] - tl.start[q]) / 1440) + 1;
  return c;
}

/** The national filters resolved once per (atlas, index, filter): the selected
    `train_table` rows (null = every train), the flow counts and, with the
    pack's `cities`, the city counts. */
export interface NatView {
  key: string;
  sel: Uint8Array | null;
  counts: Uint32Array;
  cities: { idx: number[]; dep: Uint32Array; arr: Uint32Array };
  /** An index filter (hour / distance / duration / code) is applied. */
  indexed: boolean;
}
let viewMemo: { atlas: DecodedAtlas; nf: NationalFlowsPack | null; ix: NationalIndexPack | null; key: string; v: NatView } | null = null;
export function natView(atlas: DecodedAtlas, nf: NationalFlowsPack | null, ix: NationalIndexPack | null, f: NatFilter): NatView {
  const key = natFilterKey(f) + (ix ? "|i" : "");
  if (viewMemo && viewMemo.atlas === atlas && viewMemo.nf === nf && viewMemo.ix === ix && viewMemo.key === key) return viewMemo.v;
  const sel = natSelect(atlas.data.train_table, ix, f);
  const v: NatView = {
    key,
    sel,
    counts: nf ? natFlowCounts(nf, ix, f, sel) : new Uint32Array(0),
    cities: nf ? natCityCounts(nf, ix, f, sel) : { idx: [], dep: new Uint32Array(0), arr: new Uint32Array(0) },
    indexed: !!ix && natIndexActive(f),
  };
  viewMemo = { atlas, nf, ix, key, v };
  return v;
}

/** Per-timeline-train 0/1 flag from the selected `train_table` rows (null =
    all). Memoised per (timeline, selection). */
let keepMemo: { tl: NationalTimeline; sel: Uint8Array; keep: Uint8Array } | null = null;
export function nationalKeep(tl: NationalTimeline, sel: Uint8Array | null): Uint8Array | null {
  if (!sel) return null;
  if (keepMemo && keepMemo.tl === tl && keepMemo.sel === sel) return keepMemo.keep;
  const keep = new Uint8Array(tl.n);
  for (let q = 0; q < tl.n; q++) keep[q] = sel[tl.tIdx[q]];
  keepMemo = { tl, sel, keep };
  return keep;
}

export interface NationalFrame {
  count: number;
  /** Distinct trains among the dots (a run over 24 h shows more than one dot). */
  running: number;
  buf: Float32Array;
  /** Train index of each dot, for picking. */
  qOf: Int32Array;
  line: Uint8Array;
  tailCount: number;
  tailSrc: Float32Array;
  tailTgt: Float32Array;
  tailCol: Uint8Array;
  dwellCount: number;
  dwellPos: Float32Array;
  dwellCol: Uint8Array;
}

let pool: { tl: NationalTimeline; f: NationalFrame } | null = null;

/** Fills the pooled frame buffers for display minute m (0..1440). */
export function nationalFrame(tl: NationalTimeline, atlas: DecodedAtlas, m: number, scale: number, keep?: Uint8Array | null): NationalFrame {
  if (!pool || pool.tl !== tl) {
    const cap = Math.max(1, maxDots(tl));
    pool = {
      tl,
      f: {
        count: 0,
        running: 0,
        buf: new Float32Array(cap * 6),
        qOf: new Int32Array(cap),
        line: new Uint8Array(cap * 4),
        tailCount: 0,
        tailSrc: new Float32Array(cap * 2),
        tailTgt: new Float32Array(cap * 2),
        tailCol: new Uint8Array(cap * 4),
        dwellCount: 0,
        dwellPos: new Float32Array(cap * 2),
        dwellCol: new Uint8Array(cap * 4),
      },
    };
  }
  const f = pool.f;
  const c = natPositions(tl, atlas, m, f.buf, f.qOf, keep);
  let tc = 0, dc = 0, run = 0;
  for (let i = 0; i < c; i++) {
    if (i === 0 || f.qOf[i] !== f.qOf[i - 1]) run++;
    const o = i * 6;
    const x = f.buf[o], y = f.buf[o + 1];
    const flags = f.buf[o + 5];
    const g = GLOW[flags & 15] || GLOW[2];
    f.line[i * 4] = g[0];
    f.line[i * 4 + 1] = g[1];
    f.line[i * 4 + 2] = g[2];
    f.line[i * 4 + 3] = 255;
    if (flags & 16) {
      f.dwellPos[dc * 2] = x;
      f.dwellPos[dc * 2 + 1] = y;
      f.dwellCol[dc * 4] = g[0];
      f.dwellCol[dc * 4 + 1] = g[1];
      f.dwellCol[dc * 4 + 2] = g[2];
      f.dwellCol[dc * 4 + 3] = 217;
      dc++;
      continue;
    }
    const len = Math.round(12 * f.buf[o + 4]);
    if (len <= 0) continue;
    f.tailSrc[tc * 2] = x - (f.buf[o + 2] * len) / scale;
    f.tailSrc[tc * 2 + 1] = y - (f.buf[o + 3] * len) / scale;
    f.tailTgt[tc * 2] = x;
    f.tailTgt[tc * 2 + 1] = y;
    f.tailCol[tc * 4] = g[0];
    f.tailCol[tc * 4 + 1] = g[1];
    f.tailCol[tc * 4 + 2] = g[2];
    f.tailCol[tc * 4 + 3] = 255;
    tc++;
  }
  f.count = c;
  f.running = run;
  f.tailCount = tc;
  f.dwellCount = dc;
  return f;
}

/** Tails under dots under dwell rings; new `data` objects every frame, so deck
    re-uploads the pooled buffers. Only the dots are pickable, and only while
    the clock is paused (P2.3 picks them). */
export function nationalLayers(f: NationalFrame, pickable: boolean, isolated = false): Layer[] {
  return [
    new TailLayer({
      id: "nat-tails",
      data: {
        length: f.tailCount,
        attributes: {
          getSourcePosition: { value: f.tailSrc, size: 2 },
          getTargetPosition: { value: f.tailTgt, size: 2 },
          getColor: { value: f.tailCol, size: 4 },
        },
      },
      widthUnits: "pixels",
      getWidth: isolated ? 3.5 : 2.5,
      pickable: false,
    }),
    new ScatterplotLayer({
      id: "nat-trains",
      data: {
        length: f.count,
        attributes: {
          getPosition: { value: f.buf, size: 2, stride: 24, offset: 0 },
          getLineColor: { value: f.line, size: 4 },
        },
      },
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      stroked: true,
      filled: true,
      getRadius: 3,
      getLineWidth: 2,
      getFillColor: [255, 255, 255, 255],
      pickable,
      parameters: { depthCompare: "always" },
    }),
    new ScatterplotLayer({
      id: "nat-dwell",
      data: {
        length: f.dwellCount,
        attributes: {
          getPosition: { value: f.dwellPos, size: 2 },
          getLineColor: { value: f.dwellCol, size: 4 },
        },
      },
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      stroked: true,
      filled: false,
      getRadius: 6.5,
      getLineWidth: 1.3,
      pickable: false,
    }),
  ];
}

/** The origin view's emphasis rings on the hovered / selected / isolated
    train's dot: white for hover and selection, the class colour (bigger,
    thicker) for the isolated one. */
export function nationalRings(
  f: NationalFrame,
  tl: NationalTimeline,
  atlas: DecodedAtlas,
  codes: { hover: string | null; selected: string | null | undefined; isolated: string | null | undefined },
): Layer[] {
  if (!codes.hover && !codes.selected && !codes.isolated) return [];
  const tt = atlas.data.train_table;
  const rings: { pos: [number, number]; r: number; w: number; col: [number, number, number, number] }[] = [];
  for (let i = 0; i < f.count; i++) {
    const q = f.qOf[i];
    const code = tt[tl.tIdx[q]]?.code;
    if (!code || !(code === codes.hover || code === codes.selected || code === codes.isolated)) continue;
    const iso = code === codes.isolated;
    const g = GLOW[tl.cls[q]] || GLOW[2];
    rings.push({
      pos: [f.buf[i * 6], f.buf[i * 6 + 1]],
      r: iso ? 9 : 7,
      w: iso ? 2.5 : 2,
      col: iso ? [g[0], g[1], g[2], 255] : [255, 255, 255, 255],
    });
  }
  if (!rings.length) return [];
  return [
    new ScatterplotLayer({
      id: "nat-train-rings",
      data: rings,
      getPosition: (d: (typeof rings)[number]) => d.pos,
      getRadius: (d: (typeof rings)[number]) => d.r,
      getLineWidth: (d: (typeof rings)[number]) => d.w,
      getLineColor: (d: (typeof rings)[number]) => d.col,
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      stroked: true,
      filled: false,
      pickable: false,
      updateTriggers: { getPosition: [f.buf, f.count], getRadius: [f.count] },
    }),
  ];
}

/* ---------- one isolated train ---------- */

/** The timeline row of the train with this code (null if it has no run) and a
    keep mask holding only it. Memoised per (timeline, code). */
let isoMemo: { tl: NationalTimeline; code: string; v: { q: number; keep: Uint8Array } | null } | null = null;
export function nationalIsolated(atlas: DecodedAtlas, tl: NationalTimeline, code: string): { q: number; keep: Uint8Array } | null {
  if (isoMemo && isoMemo.tl === tl && isoMemo.code === code) return isoMemo.v;
  const t = atlas.data.train_table.findIndex((r) => r.code === code);
  let v: { q: number; keep: Uint8Array } | null = null;
  for (let q = 0; t >= 0 && q < tl.n; q++) {
    if (tl.tIdx[q] !== t) continue;
    const keep = new Uint8Array(tl.n);
    keep[q] = 1;
    v = { q, keep };
    break;
  }
  isoMemo = { tl, code, v };
  return v;
}

/** The isolated train's whole run as a line in its class colour (the origin
    view's corridor): sampled along the run with natXY. */
const corridorMemo = new WeakMap<NationalTimeline, Map<number, number[]>>();
export function nationalCorridor(tl: NationalTimeline, atlas: DecodedAtlas, q: number): Layer[] {
  let m = corridorMemo.get(tl);
  if (!m) corridorMemo.set(tl, (m = new Map()));
  let path = m.get(q);
  if (!path) {
    const total = tl.total[q];
    const n = Math.max(2, Math.min(600, Math.ceil(total / 5)));
    const o = new Float32Array(4);
    path = [];
    for (let i = 0; i <= n; i++) {
      natXY(tl, atlas, q, (total * i) / n, o, 0);
      path.push(o[0], o[1]);
    }
    m.set(q, path);
  }
  const g = GLOW[tl.cls[q]] || GLOW[2];
  return [
    new PathLayer<number[]>({
      id: "nat-corridor",
      data: [path],
      getPath: (d: number[]) => d,
      positionFormat: "XY",
      widthUnits: "pixels",
      getWidth: 2.5,
      getColor: [g[0], g[1], g[2], 255],
      capRounded: true,
      jointRounded: true,
    } as object),
  ];
}

/* ---------- national flows (B, P3.2; A+B, P3.3) ---------- */

export interface NationalFlowsInput {
  atlas: DecodedAtlas;
  nf: NationalFlowsPack;
  /** The entry ticks; with `minute` the flows are the trains entered by then (A+B). */
  ne: NationalEntriesPack | null;
  /** Whole minute of the day, 0..1440 (A+B), or null for the day's totals (B). */
  minute: number | null;
  /** The class filter (the entry ticks are per class) and the resolved filter view. */
  classes: readonly string[];
  view: NatView;
  dark: boolean;
  scale: number;
  fitScale: number;
}

export interface NationalFlows {
  layers: Layer[];
  /** Sections drawn (count > 0). */
  sections: number;
  /** Trains per section as drawn (the day's totals, or entered by the clock's minute). */
  counts: Uint32Array | number[];
  /** ms of this call's count update (B pass build or A+B recount); 0 when cached. */
  updateMs: number;
}

/* B's pass per (file, class filter, theme). Its paint order (widest first by
   the day's counts) is also A+B's, so A+B keeps the geometry and recounts. */
let dayMemo: { nf: NationalFlowsPack; cls: string; dark: boolean; pd: PassData; maxN: number; sections: number } | null = null;
let atMemo: { day: PassData; ne: NationalEntriesPack; minute: number; pd: PassData; sections: number; counts: Uint32Array } | null = null;

/** The national flow layers (under the dots): B draws the day's totals; A+B
    the same paths with each section's trains entered by `minute`, recounted
    only when the minute, class filter, theme or file changes. */
export function nationalFlowLayers(inp: NationalFlowsInput): NationalFlows {
  const { atlas, nf, ne, minute, classes, view, dark, scale, fitScale } = inp;
  const pal = palette(dark);
  const cls = view.key;
  let updateMs = 0;
  if (!dayMemo || dayMemo.nf !== nf || dayMemo.cls !== cls || dayMemo.dark !== dark) {
    const t0 = performance.now();
    const pass = nationalFlowPasses(view.counts)[0];
    const pd = buildPassData(atlas.sec, pass.items, pal, 1, pass.maxN);
    dayMemo = { nf, cls, dark, pd, maxN: pass.maxN, sections: pass.items.length };
    updateMs = performance.now() - t0;
  }
  const day = dayMemo;
  let pd = day.pd;
  let sections = day.sections;
  let drawnCounts: Uint32Array | number[] = view.counts;
  if (minute !== null && ne) {
    if (!atMemo || atMemo.day !== day.pd || atMemo.ne !== ne || atMemo.minute !== minute) {
      const t0 = performance.now();
      const counts = nationalCountsAt(ne, classes, minute);
      let drawn = 0;
      for (let s = 0; s < counts.length; s++) if (counts[s] > 0) drawn++;
      atMemo = { day: day.pd, ne, minute, pd: recountPassData(day.pd, counts, pal, day.maxN), sections: drawn, counts };
      updateMs = performance.now() - t0;
    }
    pd = atMemo.pd;
    sections = atMemo.sections;
    drawnCounts = atMemo.counts;
  }
  // Width = flowUnits(n) * WIDTH_K / fitScale, so the national factor rides on fitScale.
  return { layers: passDataLayers("national", pd, 1, true, pal, dark, scale, fitScale / NAT_WIDTH_FACTOR), sections, counts: drawnCounts, updateMs };
}

/** The hovered section's highlight, as the origin view draws it: the whole
    section a little wider than its flow. */
export function nationalHighlight(atlas: DecodedAtlas, s: number, n: number, scale: number, fitScale: number, dark: boolean): Layer[] {
  const hw = Math.max(0.5, flowWidth(n, scale, fitScale) * NAT_WIDTH_FACTOR) + 1.6;
  return [
    new PathLayer<number[]>({
      id: "nat-seg-highlight",
      data: [wholePath(atlas.sec, s, false)],
      getPath: (d: number[]) => d,
      positionFormat: "XY",
      widthUnits: "pixels",
      getWidth: hw,
      getColor: rgba(palette(dark).flowHi),
      capRounded: true,
      jointRounded: true,
      updateTriggers: { getWidth: hw },
    } as object),
  ];
}

/* ---------- national city circles ---------- */

export interface NationalCityDots {
  /** `city_table` index, position, departures, arrivals and drawn radius (px) of each circle. */
  idx: number[];
  pos: [number, number][];
  dep: Uint32Array;
  arr: Uint32Array;
  r: number[];
  /** Per circle, how far (0..1) through its 20-minute golden ripple it is, or
      -1 for none; empty when the circles are not growing with the clock. */
  ripple: number[];
}

/** The ripple lasts this many minutes after a stop event (the origin view's). */
export const NAT_RIPPLE_MIN = 20;

/** The growing circles' input: the selected trains' event minutes per city and
    the clock's minute. A city is drawn from its first event on, sized by the
    events so far (departures + arrivals, all of them at 24:00). */
export interface NatGrowth {
  ev: NatCityEvents;
  t: number;
}

/** The per-city event minutes of a view's selection, built once per view. */
const eventsMemo = new WeakMap<NatView, NatCityEvents | null>();
export function natViewEvents(view: NatView, nf: NationalFlowsPack | null, ix: NationalIndexPack | null): NatCityEvents | null {
  if (!nf) return null;
  let ev = eventsMemo.get(view);
  if (ev === undefined) {
    ev = natCityEvents(nf, ix, view.sel);
    eventsMemo.set(view, ev);
  }
  return ev;
}

/* The cities with trains, busiest first (ties by city id), per counts object. */
const rankMemo = new WeakMap<object, number[]>();
function ranked(c: { idx: number[]; dep: Uint32Array; arr: Uint32Array }): number[] {
  let r = rankMemo.get(c);
  if (!r) {
    r = [];
    for (let i = 0; i < c.idx.length; i++) if (c.dep[i] + c.arr[i] > 0) r.push(i);
    r.sort((a, b) => c.dep[b] + c.arr[b] - (c.dep[a] + c.arr[a]) || c.idx[a] - c.idx[b]);
    rankMemo.set(c, r);
  }
  return r;
}

/** A circle per city sized by departures + arrivals under the filters, on
    the radius scale `natCityR` and the origin dots' zoom growth (`stationT`).
    Only the busiest `natCityTier(.., zoom)` cities (by the day's totals, so
    the set does not change with the clock) are drawn (and so pickable).
    Cities with no trains are left out. With `growth` the size is the events
    so far and a city with none yet is left out too, with a ripple when its
    last event was within 20 minutes. Null when the pack carries no `cities`. */
export function nationalCityDots(
  atlas: DecodedAtlas,
  nf: NationalFlowsPack,
  c: { idx: number[]; dep: Uint32Array; arr: Uint32Array },
  stationT: number,
  zoom: number,
  growth: NatGrowth | null = null,
): NationalCityDots | null {
  if (!nf.cities) return null;
  const order = ranked(c);
  const k = natCityTier(order.length, zoom);
  const out: NationalCityDots = { idx: [], pos: [], dep: new Uint32Array(k), arr: new Uint32Array(k), r: [], ripple: [] };
  let n = 0;
  for (let j = 0; j < k; j++) {
    const i = order[j];
    let size = c.dep[i] + c.arr[i];
    let ripple = -1;
    if (growth) {
      const { ev, t } = growth;
      size = natCityEventsAt(ev, i, t);
      if (size === 0) continue;
      const dt = t - ev.minutes[ev.off[i] + size - 1];
      if (dt >= 0 && dt <= NAT_RIPPLE_MIN) ripple = dt / NAT_RIPPLE_MIN;
    }
    const r0 = natCityR(size);
    out.idx.push(c.idx[i]);
    out.pos.push(atlas.data.city_table[c.idx[i]].pt);
    out.dep[n] = c.dep[i];
    out.arr[n] = c.arr[i];
    n++;
    out.r.push(r0 * stationZoomK(r0, stationT));
    if (growth) out.ripple.push(ripple);
  }
  if (n < k) {
    out.dep = out.dep.slice(0, n);
    out.arr = out.arr.slice(0, n);
  }
  return out;
}

/** The label layout was tuned on an origin's per-city train counts (size
    tiers at 50 / 20 / 5 trains); a national city's departures + arrivals are
    about this many times larger, so labels see its count divided by this. */
export const LABEL_TRAINS_PER_UNIT = 10;

/** The drawn cities as label candidates, busiest first (same tiering as the
    circles, so only visible cities are named). Memoised per circle set. */
const labelMemo = new WeakMap<NationalCityDots, CityPointVM[]>();
export function nationalLabelPoints(atlas: DecodedAtlas | null | undefined, d: NationalCityDots): CityPointVM[] {
  let pts = labelMemo.get(d);
  if (!pts && atlas) {
    pts = d.idx.map((idx, i) => {
      const c = atlas.data.city_table[idx];
      return {
        idx,
        zh: c.zh,
        en: c.en,
        pt: c.pt,
        trains: Math.round((d.dep[i] + d.arr[i]) / LABEL_TRAINS_PER_UNIT),
        fast: 0,
        endpoint: 0,
        fastest: 0,
        median: 0,
        crow: 0,
        rail: -1,
        nn: 0,
      };
    });
    labelMemo.set(d, pts);
  }
  return pts ?? [];
}

/** The infrastructure overlay for the sections the national flows draw
    (those with trains under the filters), memoised per counts array. */
const infraMemo = new WeakMap<object, InfraPass[]>();
export function nationalInfraLayers(atlas: DecodedAtlas, counts: ArrayLike<number>, dark: boolean): Layer[] {
  let passes = infraMemo.get(counts);
  if (!passes) {
    const sections: { s: number }[] = [];
    for (let s = 0; s < counts.length; s++) if (counts[s] > 0) sections.push({ s });
    passes = [{ alpha: 1, sections: sections as InfraPass["sections"] }];
    infraMemo.set(counts, passes);
  }
  return infraLayers(atlas.sec, passes, palette(dark), dark);
}

/** The city circles, biggest first so small ones stay on top: a translucent
    fill (so the flows show through) and a thin stroke; the hovered city
    (`hoverIdx`, a `city_table` index) is opaque with a ring. */
export function nationalCityLayers(d: NationalCityDots, dark: boolean, hoverIdx = -1): Layer[] {
  const pal = palette(dark);
  const order = d.idx.map((_, i) => i).sort((a, b) => d.r[b] - d.r[a]);
  const layers: Layer[] = [
    new ScatterplotLayer<number>({
      id: "nat-cities",
      data: order,
      getPosition: (i: number) => d.pos[i],
      getRadius: (i: number) => d.r[i],
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      stroked: true,
      filled: true,
      // The city view's dot colours and edge rule (1.5 px day, 3 px night), thinner on the smallest circles.
      getFillColor: rgba(pal.dot, dark ? 0.4 : 0.35),
      getLineColor: rgba(pal.dotEdge),
      getLineWidth: (i: number) => Math.min(dark ? 3 : 1.5, 0.3 * d.r[i]),
      pickable: false,
      updateTriggers: { getPosition: [d], getRadius: [d], getLineWidth: [d, dark] },
    }),
  ];
  const rip: Ripple[] = [];
  for (let i = 0; i < d.ripple.length; i++) {
    if (d.ripple[i] >= 0) rip.push(rippleRing(d.pos[i], d.r[i], d.ripple[i], dark));
  }
  if (rip.length) {
    layers.push(
      new ScatterplotLayer<Ripple>({
        id: "nat-city-ripples",
        data: rip,
        getPosition: (r: Ripple) => r.pos,
        getRadius: (r: Ripple) => r.r,
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        stroked: true,
        filled: false,
        getLineWidth: 1.5,
        getLineColor: (r: Ripple) => r.col,
        pickable: false,
        updateTriggers: { getPosition: [rip], getRadius: [rip], getLineColor: [rip] },
      }),
    );
  }
  const h = hoverIdx >= 0 ? d.idx.indexOf(hoverIdx) : -1;
  if (h >= 0) {
    layers.push(
      new ScatterplotLayer<number>({
        id: "nat-city-hover",
        data: [h],
        getPosition: (i: number) => d.pos[i],
        getRadius: (i: number) => d.r[i],
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        stroked: true,
        filled: true,
        getFillColor: rgba(pal.dot, 1),
        getLineColor: rgba(pal.dotEdge),
        getLineWidth: 2,
        pickable: false,
        updateTriggers: { getPosition: [d], getRadius: [d] },
      }),
    );
  }
  return layers;
}
