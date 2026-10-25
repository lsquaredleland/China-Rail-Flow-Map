/* SPIKE (throwaway): national 24h render path behind ?national=1.
   Not production code; exists to measure draw() cost. Variants are chosen
   through window.__natVariant: a b c c2 d. */
import type { OutTablesPack, SchedulesData } from "../../types";
import { OUT_TABLES_URL, SCHEDULES_URL, fetchData } from "../../data";
import { buildNational, natPositions } from "../../lib/national";
import type { NationalTimeline } from "../../lib/national";
import type { MapCtx } from "./context";

export const NAT: boolean =
  typeof location !== "undefined" && new URLSearchParams(location.search).has("national");

const COL = ["#F59E0B", "#06B6D4", "#E2E8F0"];

let tl: NationalTimeline | null = null;
let loading = false;
let buf = new Float32Array(0);
let bbox: Float32Array | null = null; // per train x0,y0,x1,y1
const W = window as any;
W.__nat = { ready: false, ms: { posSum: 0, layerSum: 0, frames: 0 } };

export function natReady() {
  return !!tl;
}

function ensure(M: MapCtx) {
  if (tl || loading) return;
  const atlas = M.P.current.atlas;
  if (!atlas) return;
  loading = true;
  const t0 = performance.now();
  Promise.all([fetchData<OutTablesPack>(OUT_TABLES_URL), fetchData<SchedulesData>(SCHEDULES_URL)]).then(
    ([out, sc]) => {
      const t1 = performance.now();
      const cls = atlas.data.train_table.map((t) => t.class);
      tl = buildNational(atlas, out, sc.schedules, cls);
      const t2 = performance.now();
      buf = new Float32Array(tl.n * 3 * 6);
      bbox = new Float32Array(tl.n * 4);
      for (let q = 0; q < tl.n; q++) {
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (let i = tl.vOff[q]; i < tl.vOff[q + 1]; i++) {
          const x = tl.vx[i], y = tl.vy[i];
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        bbox[q * 4] = x0; bbox[q * 4 + 1] = y0; bbox[q * 4 + 2] = x1; bbox[q * 4 + 3] = y1;
      }
      const t3 = performance.now();
      W.__nat.ready = true;
      W.__nat.tl = tl;
      W.__nat.buf = buf;
      W.__nat.load = { fetchParseMs: t1 - t0, buildMs: t2 - t1, bboxMs: t3 - t2, n: tl.n, verts: tl.vx.length };
      M.S.current.rafPending = false;
      requestAnimationFrame(() => (W.__draw ? W.__draw() : 0));
    },
  );
}

/** Position all trains at display minute m (timed). Returns count. */
function positions(M: MapCtx, m: number, cull: boolean): number {
  const t = tl!;
  const p0 = performance.now();
  let c: number;
  if (!cull) c = natPositions(t, m, buf);
  else c = natPositionsCulled(M, t, m);
  W.__nat.ms.posSum += performance.now() - p0;
  return c;
}

import { nat, natState, natXY } from "../../lib/national";
function natPositionsCulled(M: MapCtx, t: NationalTimeline, m: number): number {
  const { S, toLon, toLat } = M;
  const { W: w, H: h } = S.current;
  const lonL = toLon(-20), lonR = toLon(w + 20);
  const latT = toLat(-20), latB = toLat(h + 20);
  let c = 0;
  for (let q = 0; q < t.n; q++) {
    const bi = q * 4;
    if (bbox![bi + 2] < lonL || bbox![bi] > lonR || bbox![bi + 3] < latB || bbox![bi + 1] > latT) continue;
    const s = t.start[q], e = t.end[q];
    let k = Math.ceil((s - m) / 1440);
    for (; m + 1440 * k <= e; k++) {
      natState(t, q, m + 1440 * k);
      natXY(t, q, nat.dist, buf, c * 6);
      buf[c * 6 + 4] = nat.speed;
      buf[c * 6 + 5] = t.cls[q] | (nat.dwell ? 16 : 0);
      c++;
    }
  }
  return c;
}

const grads = new Map<string, CanvasGradient>();
const spriteCache = new Map<string, HTMLCanvasElement>();
/** hb >= 0: moving with tail at heading bucket hb; -1 plain dot; -2 dwelling ring dot. */
function sprites(dpr: number, cl: number, hb: number): HTMLCanvasElement {
  const key = dpr + "|" + cl + "|" + hb;
  let cv = spriteCache.get(key);
  if (cv) return cv;
  cv = document.createElement("canvas");
  cv.width = cv.height = Math.round(40 * dpr);
  const g = cv.getContext("2d")!;
  g.scale(dpr, dpr);
  g.translate(20, 20);
  const glow = COL[cl];
  if (hb >= 0) {
    g.save();
    g.rotate((hb / 16) * 6.2832);
    const gr = g.createLinearGradient(-12, 0, 0, 0);
    gr.addColorStop(0, "rgba(255,255,255,0)");
    gr.addColorStop(1, glow);
    g.strokeStyle = gr; g.lineWidth = 2.5; g.lineCap = "round";
    g.beginPath(); g.moveTo(-12, 0); g.lineTo(0, 0); g.stroke();
    g.restore();
  }
  g.fillStyle = glow; g.beginPath(); g.arc(0, 0, 4, 0, 6.2832); g.fill();
  g.fillStyle = "#fff"; g.beginPath(); g.arc(0, 0, 2, 0, 6.2832); g.fill();
  if (hb === -2) { g.globalAlpha = 0.85; g.strokeStyle = glow; g.lineWidth = 1.3; g.beginPath(); g.arc(0, 0, 6.5, 0, 6.2832); g.stroke(); }
  spriteCache.set(key, cv);
  return cv;
}

export function drawNational(M: MapCtx, ctx: CanvasRenderingContext2D) {
  ensure(M);
  if (!tl) return;
  const variant: string = W.__natVariant || "a";
  const { S, X, Y } = M;
  const { W: w, H: h } = S.current;
  const L0 = performance.now();
  const m = ((S.current.animTime % 1440) + 1440) % 1440;
  const cull = variant === "d";
  const c = positions(M, m, cull);
  W.__nat.count = c;
  const b = buf;

  if (variant === "a") {
    for (let i = 0; i < c; i++) {
      const o = i * 6;
      const px = X(b[o]), py = Y(b[o + 1]);
      if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
      const f = b[o + 5] | 0;
      const cl = f & 15;
      const dwell = (f & 16) !== 0;
      const glow = COL[cl];
      const tailLen = dwell ? 0 : Math.round(12 * b[o + 4]);
      if (tailLen > 0) {
        const key = glow + tailLen;
        let grad = grads.get(key);
        if (!grad) {
          grad = ctx.createLinearGradient(-tailLen, 0, 0, 0);
          grad.addColorStop(0, "rgba(255, 255, 255, 0)");
          grad.addColorStop(1, glow);
          grads.set(key, grad);
        }
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(Math.atan2(-b[o + 3], b[o + 2])); // screen vy = -uy
        ctx.beginPath();
        ctx.moveTo(-tailLen, 0);
        ctx.lineTo(0, 0);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, 6.2832);
      ctx.fillStyle = glow;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, 6.2832);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      if (dwell) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, 6.5, 0, 6.2832);
        ctx.strokeStyle = glow;
        ctx.lineWidth = 1.3;
        ctx.globalAlpha = 0.85;
        ctx.stroke();
        ctx.restore();
      }
    }
  } else if (variant === "b") {
    for (let i = 0; i < c; i++) {
      const o = i * 6;
      const px = X(b[o]), py = Y(b[o + 1]);
      if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, 6.2832);
      ctx.fillStyle = COL[(b[o + 5] | 0) & 15];
      ctx.fill();
    }
  } else if (variant === "c" || variant === "d") {
    for (let cl = 0; cl < 3; cl++) {
      ctx.beginPath();
      for (let i = 0; i < c; i++) {
        const o = i * 6;
        if (((b[o + 5] | 0) & 15) !== cl) continue;
        const px = X(b[o]), py = Y(b[o + 1]);
        if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
        ctx.moveTo(px + 3, py);
        ctx.arc(px, py, 3, 0, 6.2832);
      }
      ctx.fillStyle = COL[cl];
      ctx.fill();
    }
  } else if (variant === "c2") {
    for (let cl = 0; cl < 3; cl++) {
      ctx.fillStyle = COL[cl];
      for (let i = 0; i < c; i++) {
        const o = i * 6;
        if (((b[o + 5] | 0) & 15) !== cl) continue;
        const px = X(b[o]), py = Y(b[o + 1]);
        if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      }
    }
  } else if (variant === "s" || variant === "st") {
    // pre-rendered sprites (glow+core), "st" adds a tail in 16 heading buckets
    const dpr = S.current.DPR;
    for (let i = 0; i < c; i++) {
      const o = i * 6;
      const px = X(b[o]), py = Y(b[o + 1]);
      if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
      const f = b[o + 5] | 0;
      const cl = f & 15;
      const dwell = (f & 16) !== 0;
      if (variant === "st" && !dwell && b[o + 4] > 0.3) {
        let hb = Math.round((Math.atan2(-b[o + 3], b[o + 2]) / 6.2832 + 1) * 16) & 15;
        const sp = sprites(dpr, cl, hb);
        ctx.drawImage(sp, px - 20, py - 20, 40, 40);
      } else {
        ctx.drawImage(sprites(dpr, cl, -1 - (dwell ? 1 : 0)), px - 20, py - 20, 40, 40);
      }
    }
  } else if (variant === "none") {
    /* positions only */
  }
  W.__nat.ms.layerSum += performance.now() - L0;
  W.__nat.ms.frames++;
}
