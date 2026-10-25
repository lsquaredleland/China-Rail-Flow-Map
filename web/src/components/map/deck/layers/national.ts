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
import { ScatterplotLayer } from "@deck.gl/layers";
import type {
  DecodedAtlas,
  NationalEntriesPack,
  NationalFlowsPack,
  NationalTimeline,
  NationalTrainsData,
} from "../../../../types";
import {
  buildNational,
  natPositions,
  nationalCounts,
  nationalCountsAt,
  nationalFlowPasses,
  palette,
} from "../../../../lib";
import { TailLayer } from "../TailLayer";
import type { PassData } from "./flows";
import { buildPassData, passDataLayers, recountPassData } from "./flows";
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
export function nationalFrame(tl: NationalTimeline, atlas: DecodedAtlas, m: number, scale: number): NationalFrame {
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
  const c = natPositions(tl, atlas, m, f.buf, f.qOf);
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
export function nationalLayers(f: NationalFrame, pickable: boolean): Layer[] {
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
      getWidth: 2.5,
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

/* ---------- national flows (B, P3.2; A+B, P3.3) ---------- */

export interface NationalFlowsInput {
  atlas: DecodedAtlas;
  nf: NationalFlowsPack;
  /** The entry ticks; with `minute` the flows are the trains entered by then (A+B). */
  ne: NationalEntriesPack | null;
  /** Whole minute of the day, 0..1440 (A+B), or null for the day's totals (B). */
  minute: number | null;
  classes: readonly string[];
  dark: boolean;
  scale: number;
  fitScale: number;
}

export interface NationalFlows {
  layers: Layer[];
  /** Sections drawn (count > 0). */
  sections: number;
  /** ms of this call's count update (B pass build or A+B recount); 0 when cached. */
  updateMs: number;
}

/* B's pass per (file, class filter, theme). Its paint order (widest first by
   the day's counts) is also A+B's, so A+B keeps the geometry and recounts. */
let dayMemo: { nf: NationalFlowsPack; cls: string; dark: boolean; pd: PassData; maxN: number; sections: number } | null = null;
let atMemo: { day: PassData; ne: NationalEntriesPack; minute: number; pd: PassData; sections: number } | null = null;

/** The national flow layers (under the dots): B draws the day's totals; A+B
    the same paths with each section's trains entered by `minute`, recounted
    only when the minute, class filter, theme or file changes. */
export function nationalFlowLayers(inp: NationalFlowsInput): NationalFlows {
  const { atlas, nf, ne, minute, classes, dark, scale, fitScale } = inp;
  const pal = palette(dark);
  const cls = [...new Set(classes)].sort().join(",");
  let updateMs = 0;
  if (!dayMemo || dayMemo.nf !== nf || dayMemo.cls !== cls || dayMemo.dark !== dark) {
    const t0 = performance.now();
    const pass = nationalFlowPasses(nationalCounts(nf, classes))[0];
    const pd = buildPassData(atlas.sec, pass.items, pal, 1, pass.maxN);
    dayMemo = { nf, cls, dark, pd, maxN: pass.maxN, sections: pass.items.length };
    updateMs = performance.now() - t0;
  }
  const day = dayMemo;
  let pd = day.pd;
  let sections = day.sections;
  if (minute !== null && ne) {
    if (!atMemo || atMemo.day !== day.pd || atMemo.ne !== ne || atMemo.minute !== minute) {
      const t0 = performance.now();
      const counts = nationalCountsAt(ne, classes, minute);
      let drawn = 0;
      for (let s = 0; s < counts.length; s++) if (counts[s] > 0) drawn++;
      atMemo = { day: day.pd, ne, minute, pd: recountPassData(day.pd, counts, pal, day.maxN), sections: drawn };
      updateMs = performance.now() - t0;
    }
    pd = atMemo.pd;
    sections = atMemo.sections;
  }
  return { layers: passDataLayers("national", pd, 1, false, pal, dark, scale, fitScale), sections, updateMs };
}
