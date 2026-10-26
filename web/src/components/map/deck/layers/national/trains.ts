/* National trains (A, P2.2): every national train's dot, tail and dwell ring at
   the clock's minute, wrap-around (lib natPositions). Each frame fills pooled
   buffers:

     frame.buf   natPositions' 6 floats per dot (lon, lat, ux, uy, speed,
                 cls | dwell<<4), read by the dot layer directly as a
                 strided binary attribute (stride 24, offset 0)
     line        the dot's glow colour, 4 B per dot, by speed class
     tail*       source / target / colour of each moving dot's tail
     dwell*      position / colour of each dwelling dot's ring

   Same marks as the origin view's train layers (../trains.ts). Memo keys: see
   ./index.ts. */
import type { Layer } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { DecodedAtlas, NationalTimeline } from "../../../../../types";
import { natPositions, natXY } from "../../../../../lib";
import { TailLayer } from "../../TailLayer";
import { glowOf, isoDwellRings } from "../trains";
import { maxDots } from "./timeline";

/** Glow colour per NationalTimeline class: 0 G/D/C, 1 Z/T/K/S, 2 other. */
const GLOW = [glowOf("G"), glowOf("K"), glowOf("")];

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
    if (iso && (f.buf[i * 6 + 5] & 16) !== 0) {
      // Dwelling at a station: the same stop rings as the origin view.
      rings.push(...isoDwellRings([f.buf[i * 6], f.buf[i * 6 + 1]], g));
      continue;
    }
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
