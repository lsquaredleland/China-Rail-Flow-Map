// @ts-nocheck
/* SPIKE (secondary): national dots + tails on deck behind ?national=deck.
   Reuses lib/national.ts from spike/national-anim @ 600b3de unchanged.
   ?natSynth=N duplicates trains with a +37 min shift until n ~ N (perf only). */
import { ScatterplotLayer } from "./vendor";
import { TailLayer } from "./TailLayer";
import { OUT_TABLES_URL, SCHEDULES_URL, fetchData } from "../../../data";
import { buildNational, nat, natState, natXY } from "../../../lib/national";
import type { NationalTimeline } from "../../../lib/national";
import type { MapCtx } from "../context";

const Q = new URLSearchParams(location.search);
export const NAT_MODE = Q.get("national") === "deck";
const SYNTH = +(Q.get("natSynth") || 0);
const W: any = window;
W.__nat = { ready: false, count: 0, startedAt: 0, firstFrameAt: 0, ms: { pos: 0, frames: 0 } };

const GLOW = [[245, 158, 11], [6, 182, 212], [226, 232, 240]];
let tl: NationalTimeline | null = null;
let loading = false;
let base: Int32Array, shift: Float32Array, nVirt = 0;
let cap = 0;
let pos: Float32Array, col: Uint8Array, tSrc: Float32Array, tTgt: Float32Array, tCol: Uint8Array;
let dwell: { pos: number[]; col: number[] }[] = [];
const tmp = new Float32Array(6);

function ensure(M: MapCtx) {
  if (tl || loading) return;
  const atlas = M.P.current.atlas;
  if (!atlas) return;
  loading = true;
  W.__nat.startedAt = performance.now();
  Promise.all([fetchData(OUT_TABLES_URL), fetchData(SCHEDULES_URL)]).then(([out, sc]: any) => {
    const t1 = performance.now();
    const cls = atlas.data.train_table.map((t: any) => t.class);
    tl = buildNational(atlas, out, sc.schedules, cls);
    const t2 = performance.now();
    nVirt = SYNTH > 0 ? Math.max(tl.n, SYNTH) : tl.n;
    base = new Int32Array(nVirt);
    shift = new Float32Array(nVirt);
    for (let i = 0; i < nVirt; i++) { base[i] = i % tl.n; shift[i] = Math.floor(i / tl.n) * 37; }
    cap = nVirt * 3;
    pos = new Float32Array(cap * 2); col = new Uint8Array(cap * 4);
    tSrc = new Float32Array(cap * 2); tTgt = new Float32Array(cap * 2); tCol = new Uint8Array(cap * 4);
    W.__nat.ready = true;
    W.__nat.load = { fetchParseMs: t1 - W.__nat.startedAt, buildMs: t2 - t1, n: tl.n, nVirt, verts: tl.vx.length };
    requestAnimationFrame(() => M.S.current && W.__draw && W.__draw());
  });
}

export function natLayers(M: MapCtx, pal: any, R: any) {
  ensure(M);
  if (!tl) return [];
  const st = M.S.current;
  const m = ((st.animTime % 1440) + 1440) % 1440;
  const scale = st.view.scale;
  const p0 = performance.now();
  let c = 0, tc = 0;
  dwell = [];
  for (let i = 0; i < nVirt; i++) {
    const q = base[i], sh = shift[i];
    const s = tl.start[q], e = tl.end[q];
    let k = Math.ceil((s - (m - sh)) / 1440);
    for (; m - sh + 1440 * k <= e; k++) {
      const a = m - sh + 1440 * k;
      natState(tl, q, a);
      natXY(tl, q, nat.dist, tmp, 0);
      const g = GLOW[tl.cls[q]];
      pos[c * 2] = tmp[0]; pos[c * 2 + 1] = tmp[1];
      col[c * 4] = g[0]; col[c * 4 + 1] = g[1]; col[c * 4 + 2] = g[2]; col[c * 4 + 3] = 255;
      if (nat.dwell) dwell.push({ pos: [tmp[0], tmp[1]], col: [g[0], g[1], g[2], 217] });
      else {
        const L = Math.round(12 * nat.speed);
        if (L > 0) {
          tSrc[tc * 2] = tmp[0] - (tmp[2] * L) / scale; tSrc[tc * 2 + 1] = tmp[1] - (tmp[3] * L) / scale;
          tTgt[tc * 2] = tmp[0]; tTgt[tc * 2 + 1] = tmp[1];
          tCol[tc * 4] = g[0]; tCol[tc * 4 + 1] = g[1]; tCol[tc * 4 + 2] = g[2]; tCol[tc * 4 + 3] = 255;
          tc++;
        }
      }
      c++;
    }
  }
  W.__nat.ms.pos += performance.now() - p0;
  W.__nat.ms.frames++;
  W.__nat.count = c;
  W.__nat.tails = tc;
  R.trainList = [];
  R.trainCount = 0;
  return [
    new TailLayer({
      id: "tails", data: { length: tc, attributes: { getSourcePosition: { value: tSrc, size: 2 }, getTargetPosition: { value: tTgt, size: 2 }, getColor: { value: tCol, size: 4, normalized: true } } },
      widthUnits: "pixels", getWidth: 2.5, pickable: false,
    }),
    new ScatterplotLayer({
      id: "trains", data: { length: c, attributes: { getPosition: { value: pos, size: 2 }, getLineColor: { value: col, size: 4, normalized: true } } },
      radiusUnits: "pixels", lineWidthUnits: "pixels", stroked: true, filled: true,
      getRadius: 3, getLineWidth: 2, getFillColor: [255, 255, 255, 255], pickable: false,
    }),
    new ScatterplotLayer({
      id: "dwell", data: dwell, radiusUnits: "pixels", lineWidthUnits: "pixels", stroked: true, filled: false,
      getPosition: (d: any) => d.pos, getRadius: 6.5, getLineWidth: 1.3, getLineColor: (d: any) => d.col, pickable: false, updateTriggers: { all: st.animTime },
    }),
  ];
}
