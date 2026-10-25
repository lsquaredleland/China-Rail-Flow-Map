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
  distToSeg,
  pickPriority,
} from "../../lib";
import type { PickCandidate } from "../../lib";
import type { MapCtx } from "./context";
import { stationT } from "./camera";
import { getDestSectionCounts, modelState } from "./flows";
import { isTrainShown } from "./trains";


/* ---------- hit testing & tooltip ---------- */
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

/* Deck mode (D6): GPU candidates from the deck handle, then the same priority
   and distances as above, recomputed exactly in lib/pick.ts. Two single-pass
   rectangle queries on hairline proxy layers (trains, paused only; sections +
   chords) plus an exact scan for stations. Layer data is read back through the
   layers' own fields: chords by `info.object`, flow paths through the pass's
   `idxToSec` prop (C19), train dots through the `shown` prop.
   GPU query radii: the hit radius plus 2 px, because the nearest drawn pixel of
   a 1 px proxy can be that much farther than its centre; lib/pick.ts applies
   the exact radii. */
const TRAIN_RADIUS = 16;
const SEC_RADIUS = 12;

/* Stations and the origin are not picked on the GPU: they are at most a few hundred
   dots, a one-pass query shows only the top dot of any pixel (two stations closer than about
   1 px hide each other, e.g. 东莞 / 望牛墩), and the exact scan costs microseconds. The
   candidates go through the same pickPriority. */
function stationCandidates(M: MapCtx, px: number, py: number, cands: PickCandidate[], hits: Hit[]) {
  const { S, P, X, Y } = M;
  const cur = P.current.cur;
  if (!cur) return;
  const { W, H } = S.current;
  const sk = stationT(M);
  const pts = M.points();
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i];
    const x = X(c.pt[0]),
      y = Y(c.pt[1]);
    if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
    const radius = 14 * stationZoomK(stationR(c.trains), sk);
    const dx = px - x,
      dy = py - y;
    if (dx * dx + dy * dy > radius * radius) continue;
    cands.push({ kind: "station", index: i, pos: [c.pt[0], c.pt[1]], radius });
    hits.push({ kind: "station", station: c });
  }
  cands.push({ kind: "origin", index: 0, pos: [cur.o.pt[0], cur.o.pt[1]] });
  hits.push({ kind: "origin" });
}

type LayerProps = { idxToSec?: Int32Array; shown?: ActiveTrainVM[] };

export function pickDeck(M: MapCtx, px: number, py: number): Hit | null {
  const deck = M.deck;
  if (!deck) return null;
  const { S, P } = M;
  const cur = P.current.cur;
  const set = M.flowsSet();
  if (!cur) return null;
  const st = S.current;
  const paused = st.animEnabled && !st.animPlaying;
  const q = (radius: number, layerIds: string[]) =>
    deck.pickRect({ x: px - radius, y: py - radius, width: 2 * radius + 1, height: 2 * radius + 1, layerIds });
  const infos = [
    ...(paused ? q(TRAIN_RADIUS, ["pick-trains"]) : []),
    ...q(SEC_RADIUS, ["pick-chords", "pick-flows-all", "pick-flows-focus"]),
  ];

  const cands: PickCandidate[] = [];
  const hits: Hit[] = [];
  stationCandidates(M, px, py, cands, hits);
  const direction = P.current.direction;
  const destSecCounts = getDestSectionCounts(M);
  let flowIdx: Map<number, number> | null = null;
  let flows: FlowVM[] = [];
  let chordList: ChordVM[] | null = null;
  const seen = new Set<number>();

  for (const info of infos) {
    const layer = info.layer;
    if (!layer || info.index < 0) continue;
    const props = layer.props as unknown as LayerProps;
    const id = layer.id;
    if (id === "pick-trains") {
      const tr = props.shown?.[info.index];
      if (!tr) continue;
      cands.push({ kind: "train", index: info.index, pos: [tr.lon, tr.lat] });
      hits.push({ kind: "train", train: tr });
    } else if (id === "pick-chords") {
      if (direction !== "out" || destSecCounts) continue;
      const ch = (info.object as { ch?: ChordVM } | null)?.ch;
      if (!ch) continue;
      chordList ??= pickableChords(modelState(M), st);
      const index = chordList.indexOf(ch);
      if (index < 0) continue;
      cands.push({ kind: "chord", index, line: { pts: ch.flat, off: 0, count: ch.count } });
      hits.push({ kind: "chord", chord: ch });
    } else if (props.idxToSec && set) {
      const s = props.idxToSec[info.index];
      if (seen.has(s)) continue;
      seen.add(s);
      if (!flowIdx) {
        flows = pickableFlows(modelState(M), st);
        flowIdx = new Map();
        for (let i = 0; i < flows.length; i++) flowIdx.set(flows[i].s, i);
      }
      const index = flowIdx.get(s);
      if (index === undefined) continue; // drawn but not hoverable (as on Canvas)
      const f = flows[index];
      cands.push({ kind: "section", index, n: f.n, line: { pts: set.pts, off: set.off[s], count: set.len[s] } });
      const subN = destSecCounts && destSecCounts.has(s) ? destSecCounts.get(s) : undefined;
      hits.push({ kind: "seg", s, n: f.n, subN });
    }
  }
  const win = pickPriority(cands, px, py, st.view, { paused, direction, destSelected: !!destSecCounts });
  return win ? hits[cands.indexOf(win)] : null;
}

export function pick(M: MapCtx, px: number, py: number): Hit | null {
  if (M.deck) return pickDeck(M, px, py);
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
