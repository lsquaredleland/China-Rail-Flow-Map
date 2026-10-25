/* Flow layer: routed section flows, the infrastructure overlay, dashed
   chords and the hover highlight, plus the section-tracing helpers. */
import type { ChordVM, Palette } from "../../types";
import {
  chordPlan,
  chordVisible,
  flowColor,
  isFerrySection,
  flowPasses,
  getActiveDestSectionCounts as modelActiveDestSectionCounts,
  getDestSectionCounts as modelDestSectionCounts,
  highlightSegN,
  infraPasses,
  isolatedCorridor,
} from "../../lib";
import type { ModelState } from "../../lib";
import type { MapCtx } from "./context";

/* Infrastructure overlay: each flow section's track geometry stroked
   once more at this fixed screen-space width, in CSS px — the canvas
   transform scales it by the device pixel ratio like everything else,
   and it never grows with zoom, so the superimposed centreline stays a
   crisp hairline tracing every corridor at any scale. */
const INFRA_WIDTH = 1.25;


/* ---------- drawing ---------- */
export function inViewBB(
  M: MapCtx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  marginDeg: number,
): boolean {
  const { S, toLon, toLat } = M;
  const { W, H } = S.current;
  const m = marginDeg || 0;
  const lonL = toLon(-40) - m,
    lonR = toLon(W + 40) + m;
  const latB = toLat(H + 40) - m,
    latT = toLat(-40) + m;
  return x1 >= lonL && x0 <= lonR && y1 >= latB && y0 <= latT;
}

// Append one polyline (flat coords, offset in floats) to the current path,
// skipping points that land on (nearly) the same pixel as the previous one.
// Optional waterMode isolates open-water ferry crossings from overland track.
export function traceInto(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  arr: ArrayLike<number>,
  off: number,
  count: number,
  waterMode?: "landOnly" | "waterOnly",
  isRev: boolean = false,
) {
  const { X, Y } = M;
  if (!waterMode) {
    let lx = -1e9,
      ly = -1e9,
      started = false;
    const step = isRev ? -1 : 1;
    const startIdx = isRev ? count - 1 : 0;
    const endIdx = isRev ? -1 : count;
    for (let i = startIdx; i !== endIdx; i += step) {
      const x = X(arr[off + i * 2]),
        y = Y(arr[off + i * 2 + 1]);
      const dx = x - lx,
        dy = y - ly;
      if (started && dx * dx + dy * dy < 0.42 && i !== (isRev ? 0 : count - 1)) continue;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
      lx = x;
      ly = y;
    }
    return;
  }

  let lx = -1e9,
    ly = -1e9,
    started = false;
  const step = isRev ? -1 : 1;
  const startIdx = isRev ? count - 1 : 0;
  const endIdx = isRev ? -1 : count;
  for (let i = startIdx; i !== endIdx; i += step) {
    const lon = arr[off + i * 2];
    const lat = arr[off + i * 2 + 1];

    if (i !== startIdx) {
      const prevLon = arr[off + (i - step) * 2];
      const prevLat = arr[off + (i - step) * 2 + 1];
      const isWaterCross =
        ((prevLat < 20.10 && lat > 20.18) || (prevLat > 20.18 && lat < 20.10)) &&
        prevLon > 109.9 && prevLon < 110.4 &&
        lon > 109.9 && lon < 110.4;

      if (waterMode === "landOnly" && isWaterCross) {
        started = false;
      } else if (waterMode === "waterOnly") {
        if (isWaterCross) {
          ctx.moveTo(X(prevLon), Y(prevLat));
          ctx.lineTo(X(lon), Y(lat));
        }
        continue;
      }
    }

    if (waterMode === "waterOnly") continue;

    const x = X(lon),
      y = Y(lat);
    const dx = x - lx,
      dy = y - ly;
    if (started && dx * dx + dy * dy < 0.42 && i !== (isRev ? 0 : count - 1)) continue;
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
    lx = x;
    ly = y;
  }
}

export function tracePartialSec(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  arr: ArrayLike<number>,
  off: number,
  count: number,
  endLon: number,
  endLat: number,
  isRev: boolean = false,
) {
  const { X, Y } = M;
  if (count <= 0) return;
  let bestK = 0;
  let bestD2 = 1e9;
  for (let k = 0; k < count; k++) {
    const d2 =
      (arr[off + k * 2] - endLon) ** 2 +
      (arr[off + k * 2 + 1] - endLat) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestK = k;
    }
  }
  let lx = -1e9,
    ly = -1e9,
    started = false;
  if (!isRev) {
    for (let i = 0; i <= bestK; i++) {
      const x = X(arr[off + i * 2]),
        y = Y(arr[off + i * 2 + 1]);
      const dx = x - lx,
        dy = y - ly;
      if (started && dx * dx + dy * dy < 0.42 && i !== bestK) continue;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
      lx = x;
      ly = y;
    }
  } else {
    for (let i = count - 1; i >= bestK; i--) {
      const x = X(arr[off + i * 2]),
        y = Y(arr[off + i * 2 + 1]);
      const dx = x - lx,
        dy = y - ly;
      if (started && dx * dx + dy * dy < 0.42 && i !== bestK) continue;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
      lx = x;
      ly = y;
    }
  }
  if (!started) {
    ctx.moveTo(X(endLon), Y(endLat));
  } else {
    ctx.lineTo(X(endLon), Y(endLat));
  }
}

/* ---------- model access: the decisions live in lib/mapModel ---------- */
export function modelState(M: MapCtx): ModelState {
  const { S, P } = M;
  return {
    cur: P.current.cur,
    baseCur: P.current.baseCur,
    dir: P.current.direction,
    animTime: S.current.animTime,
    animEnabled: S.current.animEnabled,
    showInfra: P.current.showInfra,
    panelDest: P.current.panelDest,
    iso: P.current.isolatedTrainCode,
    dark: P.current.dark,
  };
}

/* ---------- exact per-train section counts for a selected station ---------- */
export function getDestSectionCounts(M: MapCtx): Map<number, number> | null {
  return modelDestSectionCounts(modelState(M), M.S.current);
}

export function getActiveDestSectionCounts(M: MapCtx, tMins: number): Map<number, number> {
  return modelActiveDestSectionCounts(modelState(M), M.S.current, tMins);
}


// Flow sections batched into one stroke per (width, colour) bucket
// (0.25 px width steps). When a station is selected (`destSecCounts`),
// Pass 1 draws all origin flows faded at full trunk width, and Pass 2
// draws the exact city-pair flow on top at its exact train count.
export function drawFlows(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  _destSecCounts: Map<number, number> | null,
) {
  const { S, P, X, Y, widthOf, flowsSet, activeTrainsAt } = M;
  const atlas = P.current.atlas;
  const cur = P.current.cur;
  const set = flowsSet();
  if (!atlas || !cur || !set) return;
  const { pts, off, len, bb } = set;
  const ms = modelState(M);

  const isFerry = (s: number) => isFerrySection(bb, s);

  function strokeFlowList(
    items: { s: number; n: number }[],
    alpha: number,
    normMaxN: number,
  ) {
    ctx.globalAlpha = alpha;
    let curW = -1,
      curCol = "",
      open = false;
    ctx.lineCap = "round";
    ctx.setLineDash([]);

    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      if (f.n <= 0) continue;
      if (
        !inViewBB(
          M,
          bb[f.s * 4],
          bb[f.s * 4 + 1],
          bb[f.s * 4 + 2],
          bb[f.s * 4 + 3],
          0.35,
        )
      )
        continue;
      const bw0 = Math.round(widthOf(f.n) * 4) / 4;
      const col = flowColor(f.n, normMaxN, pal);
      if (bw0 !== curW || col !== curCol) {
        if (open) ctx.stroke();
        ctx.beginPath();
        ctx.lineWidth = bw0;
        ctx.strokeStyle = col;
        curW = bw0;
        curCol = col;
        open = true;
      }
      if (isFerry(f.s)) {
        traceInto(M, ctx, pts, off[f.s], len[f.s], "landOnly");
      } else {
        traceInto(M, ctx, pts, off[f.s], len[f.s]);
      }
    }
    if (open) ctx.stroke();

    // Open-water ferry crossing dashed lines (Qiongzhou Strait water connector)
    const ferryBlue = P.current.dark ? "#38BDF8" : "#0284C7";
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      if (f.n <= 0) continue;
      if (!isFerry(f.s)) continue;
      if (
        !inViewBB(
          M,
          bb[f.s * 4],
          bb[f.s * 4 + 1],
          bb[f.s * 4 + 2],
          bb[f.s * 4 + 3],
          0.35,
        )
      )
        continue;
      const bw0 = Math.round(widthOf(f.n) * 4) / 4;
      ctx.beginPath();
      ctx.lineWidth = bw0;
      ctx.strokeStyle = ferryBlue;
      ctx.lineCap = "butt";
      const dashLen = Math.max(12, bw0 * 2.5);
      const gapLen = Math.max(9, bw0 * 1.8);
      ctx.setLineDash([dashLen, gapLen]);
      traceInto(M, ctx, pts, off[f.s], len[f.s], "waterOnly");
      ctx.stroke();
    }
    ctx.lineCap = "round";
    ctx.setLineDash([]);
  }

  for (const pass of flowPasses(ms, S.current)) {
    strokeFlowList(pass.items, pass.alpha, pass.maxN);
  }

  const corridor = isolatedCorridor(ms, activeTrainsAt);
  if (corridor) {
    // Illuminate the exact physical corridor of the isolated train as a crisp thin line
    ctx.globalAlpha = 1.0;
    ctx.lineWidth = 2.0;
    ctx.strokeStyle = corridor.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([]);
    if (corridor.secs.length > 0) {
      ctx.beginPath();
      for (const sc of corridor.secs) {
        if (sc.end) {
          tracePartialSec(M, ctx, pts, off[sc.s], len[sc.s], sc.end.lon, sc.end.lat, sc.rev);
        } else {
          traceInto(M, ctx, pts, off[sc.s], len[sc.s], undefined, sc.rev);
        }
      }
      ctx.stroke();
    } else if (corridor.chord) {
      const { chord: ch, to } = corridor.chord;
      ctx.beginPath();
      if (to) {
        ctx.moveTo(X(ch.flat[0]), Y(ch.flat[1]));
        ctx.lineTo(X(to.lon), Y(to.lat));
      } else {
        traceInto(M, ctx, ch.flat, 0, ch.count);
      }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1.0;
}


// Infrastructure overlay: uniform hairline in two colours (conventional
// rail first, then high-speed rail on top), superimposed on the flow
// mass.
export function drawInfra(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  _destSecCounts: Map<number, number> | null,
) {
  const { S, P, flowsSet } = M;
  const atlas = P.current.atlas;
  const cur = P.current.cur;
  const set = flowsSet();
  if (!atlas || !cur || !set) return;
  const { pts, off, len, bb, hsr } = set;
  ctx.lineWidth = INFRA_WIDTH;
  ctx.setLineDash([]);

  const isFerry = (s: number) => isFerrySection(bb, s);

  function infraPass(sections: { s: number }[], alpha: number) {
    ctx.globalAlpha = alpha;

    for (let pass = 0; pass < 2; pass++) {
      const wantHsr = pass === 1 ? 1 : 0;
      ctx.strokeStyle = pass === 1 ? pal.infraHsr : pal.infraConv;
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < sections.length; i++) {
        const f = sections[i];
        if ((hsr[f.s] ? 1 : 0) !== wantHsr) continue;
        if (
          !inViewBB(
            M,
            bb[f.s * 4],
            bb[f.s * 4 + 1],
            bb[f.s * 4 + 2],
            bb[f.s * 4 + 3],
            0.35,
          )
        )
          continue;
        if (pass === 0 && isFerry(f.s)) {
          traceInto(M, ctx, pts, off[f.s], len[f.s], "landOnly");
        } else {
          traceInto(M, ctx, pts, off[f.s], len[f.s]);
        }
        any = true;
      }
      if (any) ctx.stroke();

      // Depict train ferry crossing with a maritime dashed line in water blue (open water only)
      if (pass === 0) {
        ctx.beginPath();
        ctx.lineCap = "butt";
        ctx.strokeStyle = P.current.dark ? "#38BDF8" : "#0284C7";
        ctx.setLineDash([7, 6]);
        let anyFerry = false;
        for (let i = 0; i < sections.length; i++) {
          const f = sections[i];
          if (!isFerry(f.s)) continue;
          if (
            !inViewBB(
              M,
              bb[f.s * 4],
              bb[f.s * 4 + 1],
              bb[f.s * 4 + 2],
              bb[f.s * 4 + 3],
              0.35,
            )
          )
            continue;
          traceInto(M, ctx, pts, off[f.s], len[f.s], "waterOnly");
          anyFerry = true;
        }
        if (anyFerry) ctx.stroke();
        ctx.lineCap = "round";
        ctx.setLineDash([]);
      }
    }
  }

  for (const p of infraPasses(modelState(M), S.current)) infraPass(p.sections, p.alpha);
  ctx.globalAlpha = 1.0;
}

export function drawChords(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  highlight: ChordVM | null,
  _hasSelectedDest: boolean,
) {
  const { S, P, widthOf } = M;
  const cur = P.current.cur;
  if (!cur) return;
  const st = S.current;
  const plan = chordPlan(modelState(M), st);
  if (!plan) return;
  if (plan.alpha !== 1) ctx.globalAlpha = plan.alpha;
  for (let i = 0; i < cur.chords.length; i++) {
    const ch = cur.chords[i];
    if (highlight === ch) continue;
    if (!inViewBB(M, ch.bb.x0, ch.bb.y0, ch.bb.x1, ch.bb.y1, 0.35)) continue;
    if (!chordVisible(plan, ch, st.animTime)) continue;
    const w = plan.isolated ? 1.5 : widthOf(ch.n);
    ctx.lineWidth = w;
    ctx.strokeStyle = pal.chord;
    ctx.setLineDash([Math.max(3, w * 1.1), Math.max(2.5, w * 0.8)]);
    ctx.beginPath();
    traceInto(M, ctx, ch.flat, 0, ch.count);
    ctx.stroke();
  }
  ctx.globalAlpha = 1.0;
  ctx.setLineDash([]);
  if (highlight && !plan.isolated) {
    const hw = widthOf(highlight.n) + 1.6;
    ctx.lineWidth = hw;
    ctx.strokeStyle = pal.flowHi;
    ctx.setLineDash([Math.max(3, hw * 1.1), Math.max(2.5, hw * 0.8)]);
    ctx.beginPath();
    traceInto(M, ctx, highlight.flat, 0, highlight.count);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export function drawHighlightSeg(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  sIdx: number,
  n: number,
) {
  const { S, P, widthOf, flowsSet } = M;
  const cur = P.current.cur;
  if (!cur) return;
  const effectiveN = highlightSegN(modelState(M), S.current, sIdx, n);
  if (effectiveN === null) return;
  const set = flowsSet();
  if (!set) return;
  const isFerry = isFerrySection(set.bb, sIdx);
  const hw = widthOf(effectiveN) + 1.6;
  ctx.lineWidth = hw;
  if (isFerry) {
    // Overland portions of the ferry route highlighted in standard flowHi
    ctx.strokeStyle = pal.flowHi;
    ctx.lineCap = "round";
    ctx.setLineDash([]);
    ctx.beginPath();
    traceInto(M, ctx, set.pts, set.off[sIdx], set.len[sIdx], "landOnly");
    ctx.stroke();

    // Open-water crossing highlighted in luminous water blue
    ctx.strokeStyle = P.current.dark ? "#7DD3FC" : "#0284C7";
    ctx.lineCap = "butt";
    ctx.setLineDash([Math.max(12, hw * 2.5), Math.max(9, hw * 1.8)]);
    ctx.beginPath();
    traceInto(M, ctx, set.pts, set.off[sIdx], set.len[sIdx], "waterOnly");
    ctx.stroke();
  } else {
    ctx.strokeStyle = pal.flowHi;
    ctx.lineCap = "round";
    ctx.setLineDash([]);
    ctx.beginPath();
    traceInto(M, ctx, set.pts, set.off[sIdx], set.len[sIdx]);
    ctx.stroke();
  }
  ctx.lineCap = "round";
  ctx.setLineDash([]);
}
