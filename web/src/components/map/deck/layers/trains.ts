/* Train layers: the moving dots, their gradient tails, station-dwell rings and
   the hover / selected / isolated ring, as deck.gl layers. Mirrors
   map/trains.ts drawTrains; which trains are shown (class filter, selected
   destination window, isolation) comes from lib isTrainShown, so both
   renderers agree.

   Dots and tails are binary attributes filled into per-frame buffers (§2.2):
   every frame builds a new `data` object over the same typed arrays, so deck
   re-uploads them and nothing is allocated per train. The dot is a
   ScatterplotLayer with `getRadius 3`, `getLineWidth 2` (isolated 4.15 / 2.7):
   the stroke is centred on the radius (C17), so the ring spans 2-4 px (4.15 ±
   1.35 = 2.8-5.5 isolated) over a white core, as in Canvas. No module state
   shared with the entry bundle (C23): the buffer pool is private to this chunk. */
import type { Layer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { ActiveTrainVM } from "../../../../types";
import type { RGBA } from "../../../../lib";
import { TailLayer } from "../TailLayer";

const AMBER: RGBA = [245, 158, 11, 255]; // G D C
const CYAN: RGBA = [6, 182, 212, 255]; // Z T K S
const SLATE: RGBA = [226, 232, 240, 255]; // 普 and the rest

/** The train's glow colour (map/trains.ts: high-speed amber, conventional cyan). */
export function glowOf(cls: string): RGBA {
  if (cls === "G" || cls === "D" || cls === "C") return AMBER;
  if (cls === "Z" || cls === "T" || cls === "K" || cls === "S") return CYAN;
  return SLATE;
}

/** Tail length in px: 12 (22 isolated) times speed fraction; none while dwelling or on a chord. */
export function tailLength(tr: ActiveTrainVM, isolated: boolean): number {
  const dwelling = Boolean(tr.isDwelling);
  const speedFrac = tr.speedFrac !== undefined ? tr.speedFrac : dwelling ? 0 : 1;
  return dwelling || tr.onChord ? 0 : Math.round((isolated ? 22 : 12) * speedFrac);
}

/** The trains drawn this frame: `isShown` is lib isTrainShown (class filter,
    destination window); an isolated train hides all others. */
export function shownTrains(
  trains: readonly ActiveTrainVM[],
  isShown: (code: string) => boolean,
  isolatedCode: string | null | undefined,
): ActiveTrainVM[] {
  const out: ActiveTrainVM[] = [];
  for (const tr of trains) {
    if (!isShown(tr.code)) continue;
    if (isolatedCode && tr.code !== isolatedCode) continue;
    out.push(tr);
  }
  return out;
}

interface Disc {
  pos: [number, number];
  r: number;
  w: number;
  col: RGBA;
}

export interface TrainBuffers {
  /** Dot count; the typed arrays are longer (pooled). */
  count: number;
  pos: Float32Array;
  line: Uint8Array;
  fill: Uint8Array;
  /** Tail count and endpoints (source = pos − heading·len/scale). */
  tailCount: number;
  tailSrc: Float32Array;
  tailTgt: Float32Array;
  tailCol: Uint8Array;
  dwell: Disc[];
  rings: Disc[];
}

let cap = 0;
let pool: Pick<TrainBuffers, "pos" | "line" | "fill" | "tailSrc" | "tailTgt" | "tailCol"> | null = null;
function ensure(n: number) {
  if (pool && n <= cap) return pool;
  cap = Math.max(n, cap * 2, 1024);
  pool = {
    pos: new Float32Array(cap * 2),
    line: new Uint8Array(cap * 4),
    fill: new Uint8Array(cap * 4),
    tailSrc: new Float32Array(cap * 2),
    tailTgt: new Float32Array(cap * 2),
    tailCol: new Uint8Array(cap * 4),
  };
  return pool;
}

/** Fills the pooled buffers for `trains` (already filtered by `shownTrains`). */
export function buildTrainBuffers(
  trains: readonly ActiveTrainVM[],
  scale: number,
  isolatedCode: string | null | undefined,
  selectedCode: string | null | undefined,
  hoveredCode: string | null,
): TrainBuffers {
  const b = ensure(trains.length);
  const dwell: Disc[] = [];
  const rings: Disc[] = [];
  let tc = 0;
  for (let i = 0; i < trains.length; i++) {
    const tr = trains[i];
    const iso = isolatedCode === tr.code;
    const g = glowOf(tr.cls);
    const a = tr.onChord ? 115 : 255; // globalAlpha 0.45 on chords
    b.pos[i * 2] = tr.lon;
    b.pos[i * 2 + 1] = tr.lat;
    b.line[i * 4] = g[0];
    b.line[i * 4 + 1] = g[1];
    b.line[i * 4 + 2] = g[2];
    b.line[i * 4 + 3] = a;
    b.fill[i * 4] = 255;
    b.fill[i * 4 + 1] = 255;
    b.fill[i * 4 + 2] = 255;
    b.fill[i * 4 + 3] = a;
    const len = tailLength(tr, iso);
    if (len > 0) {
      const dx = (Math.cos(tr.heading) * len) / scale;
      const dy = (Math.sin(tr.heading) * len) / scale;
      b.tailSrc[tc * 2] = tr.lon - dx;
      b.tailSrc[tc * 2 + 1] = tr.lat - dy;
      b.tailTgt[tc * 2] = tr.lon;
      b.tailTgt[tc * 2 + 1] = tr.lat;
      b.tailCol[tc * 4] = g[0];
      b.tailCol[tc * 4 + 1] = g[1];
      b.tailCol[tc * 4 + 2] = g[2];
      b.tailCol[tc * 4 + 3] = 255;
      tc++;
    }
    if (tr.isDwelling) {
      dwell.push({ pos: [tr.lon, tr.lat], r: iso ? 8.5 : 6.5, w: 1.3, col: [g[0], g[1], g[2], 217] });
    }
    if (hoveredCode === tr.code || selectedCode === tr.code || iso) {
      rings.push({
        pos: [tr.lon, tr.lat],
        r: iso ? 9 : 7,
        w: iso ? 2.5 : 2,
        col: iso ? [g[0], g[1], g[2], 255] : [255, 255, 255, 255],
      });
    }
  }
  return {
    count: trains.length,
    pos: b.pos,
    line: b.line,
    fill: b.fill,
    tailCount: tc,
    tailSrc: b.tailSrc,
    tailTgt: b.tailTgt,
    tailCol: b.tailCol,
    dwell,
    rings,
  };
}

export interface TrainLayerInput {
  trains: readonly ActiveTrainVM[];
  scale: number;
  isolatedCode: string | null | undefined;
  selectedCode: string | null | undefined;
  hoveredCode: string | null;
  /** The clock, as an update-trigger for the per-frame disc accessors. */
  animTime: number;
}

export function trainLayers(inp: TrainLayerInput): Layer[] {
  const iso = !!inp.isolatedCode;
  const b = buildTrainBuffers(inp.trains, inp.scale, inp.isolatedCode, inp.selectedCode, inp.hoveredCode);
  const common = { radiusUnits: "pixels", lineWidthUnits: "pixels", stroked: true, filled: false } as const;
  const trig = inp.animTime + "|" + inp.scale;
  return [
    new TailLayer({
      id: "tails",
      data: {
        length: b.tailCount,
        attributes: {
          getSourcePosition: { value: b.tailSrc, size: 2 },
          getTargetPosition: { value: b.tailTgt, size: 2 },
          getColor: { value: b.tailCol, size: 4 },
        },
      },
      widthUnits: "pixels",
      getWidth: iso ? 3.5 : 2.5,
      pickable: false,
    }),
    new ScatterplotLayer({
      id: "trains",
      data: {
        length: b.count,
        attributes: {
          getPosition: { value: b.pos, size: 2 },
          getLineColor: { value: b.line, size: 4 },
          getFillColor: { value: b.fill, size: 4 },
        },
      },
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      stroked: true,
      filled: true,
      getRadius: iso ? 4.15 : 3,
      getLineWidth: iso ? 2.7 : 2,
      pickable: false,
      parameters: { depthCompare: "always" },
    }),
    new ScatterplotLayer<Disc>({
      ...common,
      id: "dwell",
      data: b.dwell,
      getPosition: (d) => d.pos,
      getRadius: (d) => d.r,
      getLineWidth: (d) => d.w,
      getLineColor: (d) => d.col,
      pickable: false,
      updateTriggers: { getPosition: trig, getRadius: trig, getLineColor: trig },
    }),
    new ScatterplotLayer<Disc>({
      ...common,
      id: "trainring",
      data: b.rings,
      getPosition: (d) => d.pos,
      getRadius: (d) => d.r,
      getLineWidth: (d) => d.w,
      getLineColor: (d) => d.col,
      pickable: false,
      updateTriggers: { getPosition: trig, getRadius: trig, getLineColor: trig },
    }),
  ];
}
