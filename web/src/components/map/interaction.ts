/* Hit-testing and the floating tooltip. */
import type {
  ActiveTrainVM,
  ChordVM,
  CityPointVM,
  DestVM,
  FlowVM,
  Hit,
  SrcVM,
} from "../../types";
import {
  isFerrySection,
  stationR,
  stationZoomK,
  tooltipHtml,
  pickableChords,
  pickableFlows,
} from "../../lib";
import type { MapCtx } from "./context";
import { stationT } from "./camera";
import { getDestSectionCounts, modelState } from "./flows";
import { isTrainShown } from "./trains";


/* ---------- hit testing & tooltip ---------- */
export function distToSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px,
    ey = ay + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}

export function pickStation(M: MapCtx, px: number, py: number): Hit | null {
  const { S, P, X, Y, points } = M;
  const cur = P.current.cur;
  if (!cur) return null;
  const { W, H } = S.current;
  const pts = points();
  let best: CityPointVM | null = null;
  const sk = stationT(M);
  let bestD2 = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i];
    const x = X(c.pt[0]),
      y = Y(c.pt[1]);
    if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
    const dx = px - x,
      dy = py - y,
      d2 = dx * dx + dy * dy;
    const hitR = 14 * stationZoomK(stationR(c.trains), sk);
    if (d2 <= hitR * hitR && d2 <= bestD2) {
      best = c;
      bestD2 = d2;
    }
  }
  const cx = X(cur.o.pt[0]),
    cy = Y(cur.o.pt[1]);
  const odx = px - cx,
    ody = py - cy,
    od2 = odx * odx + ody * ody;
  if (od2 <= 15 * 15 && (best === null || od2 <= bestD2))
    return { kind: "origin" };
  return best ? { kind: "station", station: best } : null;
}

export function pickSegment(M: MapCtx, px: number, py: number): Hit | null {
  const { S, P, X, Y, toLon, toLat, flowsSet } = M;
  const atlas = P.current.atlas;
  const cur = P.current.cur;
  const set = flowsSet();
  if (!atlas || !cur || !set) return null;
  const sec = set;
  const ms = modelState(M);
  const flows = pickableFlows(ms, S.current);
  const lon = toLon(px),
    lat = toLat(py);
  const thrDeg = 12 / S.current.view.scale;
  let segBest: FlowVM | null = null;
  let bestDist = 10;
  let i: number, k: number;
  const destSecCounts = getDestSectionCounts(M);

  for (i = 0; i < flows.length; i++) {
    const f = flows[i];
    const s = f.s;
    if (
      lon < sec.bb[s * 4] - thrDeg ||
      lon > sec.bb[s * 4 + 2] + thrDeg ||
      lat < sec.bb[s * 4 + 1] - thrDeg ||
      lat > sec.bb[s * 4 + 3] + thrDeg
    )
      continue;
    const off = sec.off[s],
      cnt = sec.len[s];
    for (k = 0; k + 1 < cnt; k++) {
      const d = distToSeg(
        px,
        py,
        X(sec.pts[off + k * 2]),
        Y(sec.pts[off + k * 2 + 1]),
        X(sec.pts[off + k * 2 + 2]),
        Y(sec.pts[off + k * 2 + 3]),
      );
      if (
        d < bestDist - 0.75 ||
        (d <= bestDist + 0.75 && segBest && f.n > segBest.n)
      ) {
        if (d < bestDist || (segBest && f.n > segBest.n)) {
          segBest = f;
          bestDist = Math.min(d, bestDist);
        }
      }
    }
  }
  if (segBest) {
    const destSecCounts = getDestSectionCounts(M);
    const subN =
      destSecCounts && destSecCounts.has(segBest.s)
        ? destSecCounts.get(segBest.s)
        : undefined;
    return { kind: "seg", s: segBest.s, n: segBest.n, subN };
  }
  if (P.current.direction !== "out" || destSecCounts) return null;
  let chordBest: ChordVM | null = null;
  const chords = pickableChords(ms, S.current);
  for (i = 0; i < chords.length; i++) {
    const ch = chords[i];
    if (
      lon < ch.bb.x0 - thrDeg ||
      lon > ch.bb.x1 + thrDeg ||
      lat < ch.bb.y0 - thrDeg ||
      lat > ch.bb.y1 + thrDeg
    )
      continue;
    for (k = 0; k + 1 < ch.count; k++) {
      const dd = distToSeg(
        px,
        py,
        X(ch.flat[k * 2]),
        Y(ch.flat[k * 2 + 1]),
        X(ch.flat[k * 2 + 2]),
        Y(ch.flat[k * 2 + 3]),
      );
      if (dd < bestDist) {
        chordBest = ch;
        bestDist = dd;
      }
    }
  }
  return chordBest ? { kind: "chord", chord: chordBest } : null;
}

export function pickTrain(M: MapCtx, px: number, py: number): Hit | null {
  const { S, P, X, Y, activeTimeline, activeTrainsAt } = M;
  const st = S.current;
  // Paused only: moving train tooltips are strictly active when visualization is paused
  if (!st.animEnabled || st.animPlaying) return null;
  const cur = P.current.cur;
  if (!cur) return null;
  const timeline = activeTimeline();
  if (!timeline) return null;
  const activeTrains = activeTrainsAt(timeline, st.animTime);
  if (!activeTrains || activeTrains.length === 0) return null;

  let bestDist = 14;
  let bestTrain: ActiveTrainVM | null = null;
  for (let i = 0; i < activeTrains.length; i++) {
    const tr = activeTrains[i];
    if (!isTrainShown(M, tr.code)) {
      continue;
    }
    const tx = X(tr.lon);
    const ty = Y(tr.lat);
    const d = Math.hypot(px - tx, py - ty);
    if (d < bestDist) {
      bestDist = d;
      bestTrain = tr;
    }
  }
  return bestTrain ? { kind: "train", train: bestTrain } : null;
}

export function pick(M: MapCtx, px: number, py: number): Hit | null {
  const tr = pickTrain(M, px, py);
  if (tr) return tr;
  const c = pickStation(M, px, py);
  if (c) return c;
  return pickSegment(M, px, py);
}

export function showTooltip(M: MapCtx, hit: Hit, px: number, py: number) {
  const { S, P, flowsSet, tooltipRef } = M;
  const atlas = P.current.atlas;
  const cur = P.current.cur;
  const tooltip = tooltipRef.current;
  if (!atlas || !cur || !tooltip) return;
  const st = S.current;
  st.lastTip = { hit, x: px, y: py };
  const set = flowsSet();
  const html = tooltipHtml(hit, {
    data: atlas.data,
    cur,
    direction: P.current.direction,
    distUnit: P.current.distUnit,
    panelDest: P.current.panelDest,
    dark: P.current.dark,
    ferry: hit.kind === "seg" && !!set && isFerrySection(set.bb, hit.s),
  });
  tooltip.innerHTML = html;
  tooltip.classList.add("show");
  const tw = tooltip.offsetWidth,
    th = tooltip.offsetHeight;
  let x = px + 14,
    y = py + 14;
  if (x + tw > st.W - 6) x = px - tw - 10;
  if (y + th > st.H - 6) y = py - th - 10;
  tooltip.style.left = Math.max(4, x) + "px";
  tooltip.style.top = Math.max(4, y) + "px";
}

export function hideTooltip(M: MapCtx) {
  const { S, tooltipRef } = M;
  const tooltip = tooltipRef.current;
  if (tooltip) tooltip.classList.remove("show");
  S.current.pinned = false;
}

export function sameHit(a: Hit | null, b: Hit | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "seg" && b.kind === "seg") return a.s === b.s;
  if (a.kind === "chord" && b.kind === "chord") return a.chord === b.chord;
  if (a.kind === "train" && b.kind === "train") return a.train.code === b.train.code;
  if (a.kind === "station" && b.kind === "station")
    return a.station === b.station;
  return true; // origin
}
