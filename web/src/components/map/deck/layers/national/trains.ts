/* National trains (A, P2.2): every national train's dot, tail and dwell ring at
   the clock's minute, wrap-around (lib natPositions). Each frame fills pooled
   buffers:

     frame.pos   natPositions' 6 floats per dot (lon, lat, ux, uy, speed,
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
import { dotLayers, glowOf, isoDwellRings, ringLayer } from "../trains";
import type { Disc, DotBuffers } from "../trains";
import { maxDots } from "./timeline";

/** Glow colour per NationalTimeline class: 0 G/D/C, 1 Z/T/K/S, 2 other. */
const GLOW = [glowOf("G"), glowOf("K"), glowOf("")];

interface NationalFrame extends DotBuffers {
  count: number;
  /** Distinct trains among the dots (a run over 24 h shows more than one dot). */
  running: number;
  pos: Float32Array;
  posStride: 24;
  /** Train index of each dot, for picking. */
  qOf: Int32Array;
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
        pos: new Float32Array(cap * 6),
        posStride: 24,
        qOf: new Int32Array(cap),
        line: new Uint8Array(cap * 4),
        tailCount: 0,
        tailSrc: new Float32Array(cap * 2),
        tailTgt: new Float32Array(cap * 2),
        tailCol: new Uint8Array(cap * 4),
        dwell: [],
      },
    };
  }
  const f = pool.f;
  f.dwell = [];
  const c = natPositions(tl, atlas, m, f.pos, f.qOf, keep);
  let tc = 0, run = 0;
  for (let i = 0; i < c; i++) {
    if (i === 0 || f.qOf[i] !== f.qOf[i - 1]) run++;
    const o = i * 6;
    const x = f.pos[o], y = f.pos[o + 1];
    const flags = f.pos[o + 5];
    const g = GLOW[flags & 15] || GLOW[2];
    f.line[i * 4] = g[0];
    f.line[i * 4 + 1] = g[1];
    f.line[i * 4 + 2] = g[2];
    f.line[i * 4 + 3] = 255;
    if (flags & 16) {
      f.dwell.push({ pos: [x, y], r: 6.5, w: 1.3, col: [g[0], g[1], g[2], 217] });
      continue;
    }
    const len = Math.round(12 * f.pos[o + 4]);
    if (len <= 0) continue;
    f.tailSrc[tc * 2] = x - (f.pos[o + 2] * len) / scale;
    f.tailSrc[tc * 2 + 1] = y - (f.pos[o + 3] * len) / scale;
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
  return f;
}

/** Tails under dots under dwell rings (ids `nat-tails | nat-trains | nat-dwell`); new `data`
    objects every frame, so deck re-uploads the pooled buffers. Only the dots are pickable, and
    only while the clock is paused (P2.3 picks them). The isolated train's dot and tail are
    enlarged as in the origin view. */
export function nationalLayers(f: NationalFrame, pickable: boolean, isolated = false): Layer[] {
  return dotLayers("nat-", f, { pickable, isolated, trigger: f.count });
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
  const rings: Disc[] = [];
  for (let i = 0; i < f.count; i++) {
    const q = f.qOf[i];
    const code = tt[tl.tIdx[q]]?.code;
    if (!code || !(code === codes.hover || code === codes.selected || code === codes.isolated)) continue;
    const iso = code === codes.isolated;
    const g = GLOW[tl.cls[q]] || GLOW[2];
    if (iso && (f.pos[i * 6 + 5] & 16) !== 0) {
      // Dwelling at a station: the same stop rings as the origin view.
      rings.push(...isoDwellRings([f.pos[i * 6], f.pos[i * 6 + 1]], g));
      continue;
    }
    rings.push({
      pos: [f.pos[i * 6], f.pos[i * 6 + 1]],
      r: iso ? 9 : 7,
      w: iso ? 2.5 : 2,
      col: iso ? [g[0], g[1], g[2], 255] : [255, 255, 255, 255],
    });
  }
  return rings.length ? [ringLayer("nat-train-rings", rings, f.count)] : [];
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
