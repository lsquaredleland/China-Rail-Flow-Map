/* Hit-testing and the floating tooltip. */
import type { ChordVM, FlowVM, Hit } from "../../types";
import {
  dotPlaces,
  isFerrySection,
  isTrainShown as modelIsTrainShown,
  natTrainVM,
  stationR,
  stationZoomK,
  tooltipHtml,
  pickableChords,
  pickableFlows,
  pickPriority,
  sectionLines,
  splitRadius,
  TRAIN_RADIUS,
} from "../../lib";
import type { PickCandidate } from "../../lib";
import type { MapCtx } from "./context";
import { stationT } from "./camera";
import { closeupOf } from "./closeup";
import { getDestSectionCounts, modelState } from "./flows";


/* ---------- hit testing & tooltip ---------- */
/* Picking (D6): GPU candidates from the deck handle, then the priority and
   distances recomputed exactly in lib/pick.ts. One single-pass
   rectangle query on hairline proxy layers (sections + chords) plus exact scans
   for stations and, while paused, trains. Layer data is read back through the
   layers' own fields: chords by `info.object`, flow paths through the pass's
   `idxToSec` prop (C19).
   GPU query radius: the hit radius plus 2 px, because the nearest drawn pixel of
   a 1 px proxy can be that much farther than its centre; lib/pick.ts applies
   the exact radii. */
const SEC_RADIUS = 12;

/* Stations, the origin and trains are not picked on the GPU: they are at most a few thousand
   dots, a one-pass query shows only the top dot of any pixel (dots closer than about 1 px
   hide each other, e.g. 东莞 / 望牛墩, or trains 0.05 px apart), and the exact scan costs
   microseconds. The candidates go through the same pickPriority. */
function stationCandidates(M: MapCtx, px: number, py: number, cands: PickCandidate[], hits: Hit[]) {
  const { S, P, X, Y } = M;
  const cur = P.current.cur;
  if (!cur) return;
  const { W, H } = S.current;
  const sk = stationT(M);
  const pts = M.points();
  // With a destination selected (the two-city focus), only that city and the
  // origin answer the pointer until the focus is closed.
  const pd = P.current.panelDest;
  // A split city answers at each of its station dots (lib/closeups), still as the city.
  const cu = closeupOf(M);
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i];
    if (pd && c.idx !== pd.idx) continue;
    if (S.current.unlitCities?.has(c.idx)) continue;
    for (const p of dotPlaces([c.pt[0], c.pt[1]], cu?.byCity.get(c.zh), cu?.k ?? 0)) {
      const x = X(p.pos[0]),
        y = Y(p.pos[1]);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      const radius = p.f >= 1 ? 14 * stationZoomK(stationR(c.trains), sk) : Math.max(8, splitRadius(14 * stationZoomK(stationR(c.trains), sk), p.f));
      const dx = px - x,
        dy = py - y;
      if (dx * dx + dy * dy > radius * radius) continue;
      cands.push({ kind: "station", index: i, pos: p.pos, radius });
      hits.push({ kind: "station", station: c });
    }
  }
  for (const p of dotPlaces([cur.o.pt[0], cur.o.pt[1]], cu?.byCity.get(cur.o.zh), cu?.k ?? 0)) {
    cands.push({ kind: "origin", index: 0, pos: p.pos });
    hits.push({ kind: "origin" });
  }
}

/* Paused only: the active trains, filtered by isTrainShown (no isolation filter). */
function isTrainShown(M: MapCtx, code: string): boolean {
  return modelIsTrainShown(M.P.current, M.S.current, M.S.current.animTime, code);
}

function trainCandidates(M: MapCtx, cands: PickCandidate[], hits: Hit[]) {
  const { S, activeTimeline, activeTrainsAt } = M;
  const st = S.current;
  if (!st.animEnabled || st.animPlaying) return;
  const timeline = activeTimeline();
  if (!timeline) return;
  const trains = activeTrainsAt(timeline, st.animTime);
  for (let i = 0; i < trains.length; i++) {
    const tr = trains[i];
    if (!isTrainShown(M, tr.code)) continue;
    cands.push({ kind: "train", index: i, pos: [tr.lon, tr.lat] });
    hits.push({ kind: "train", train: tr });
  }
}

/* National mode (P2.3): the same exact scan over the current frame's dots, paused
   only. The candidate index is the dot's index; the view-model is built for the
   winner only. */
function pickNational(M: MapCtx, px: number, py: number): Hit | null {
  return pickNationalTrain(M, px, py) ?? pickNationalCity(M, px, py) ?? pickNationalFlow(M, px, py);
}

/* A national flow line near the pointer: the busiest section whose hairline
   pick proxy is within SEC_RADIUS (the origin view's rule: busier wins). */
function pickNationalFlow(M: MapCtx, px: number, py: number): Hit | null {
  const { S, deck } = M;
  const counts = S.current.natCounts;
  if (!deck || !counts) return null;
  const infos = deck.pickRect({
    x: px - SEC_RADIUS,
    y: py - SEC_RADIUS,
    width: 2 * SEC_RADIUS + 1,
    height: 2 * SEC_RADIUS + 1,
    layerIds: ["pick-flows-national"],
  });
  let best: Hit | null = null;
  for (const info of infos) {
    if (!info.layer || info.index < 0) continue;
    const s = (info.layer.props as unknown as LayerProps).idxToSec?.[info.index];
    const n = s === undefined ? 0 : counts[s] ?? 0;
    if (n > 0 && (!best || (best.kind === "seg" && n > best.n))) best = { kind: "seg", s: s!, n };
  }
  return best;
}

/* A city circle under the pointer (the smallest, as it is drawn on top). */
export function pickNationalCity(M: MapCtx, px: number, py: number): Hit | null {
  const { S, X, Y } = M;
  const d = S.current.natCities;
  if (!d) return null;
  let best = -1;
  for (let i = 0; i < d.idx.length; i++) {
    const dx = px - X(d.pos[i][0]), dy = py - Y(d.pos[i][1]);
    if (dx * dx + dy * dy > (d.r[i] + 2) * (d.r[i] + 2)) continue;
    if (best < 0 || d.r[i] < d.r[best]) best = i;
  }
  return best < 0 ? null : { kind: "natCity", idx: d.idx[best], dep: d.dep[best], arr: d.arr[best] };
}

function pickNationalTrain(M: MapCtx, px: number, py: number): Hit | null {
  const { S, P, X, Y } = M;
  const st = S.current;
  const f = st.natPick;
  const data = P.current.nationalTrains;
  const atlas = P.current.atlas;
  if (!f || !data || !atlas || !st.animEnabled || st.animPlaying) return null;
  const cands: PickCandidate[] = [];
  const lim2 = TRAIN_RADIUS * TRAIN_RADIUS;
  for (let i = 0; i < f.count; i++) {
    const lon = f.buf[i * 6], lat = f.buf[i * 6 + 1];
    const dx = px - X(lon), dy = py - Y(lat);
    if (dx * dx + dy * dy >= lim2) continue;
    cands.push({ kind: "train", index: i, pos: [lon, lat] });
  }
  const win = pickPriority(cands, px, py, st.view, { paused: true });
  if (!win) return null;
  const i = win.index, q = f.qOf[i];
  let j = i;
  while (j > 0 && f.qOf[j - 1] === q) j--;
  const a = f.m + 1440 * (Math.ceil((f.tl.start[q] - f.m) / 1440) + (i - j));
  const o = i * 6;
  return {
    kind: "train",
    train: natTrainVM(f.tl, atlas.data, data.schedules, q, a, f.buf[o], f.buf[o + 1], f.buf[o + 2], f.buf[o + 3]),
  };
}

type LayerProps = { idxToSec?: Int32Array };

export function pick(M: MapCtx, px: number, py: number): Hit | null {
  const deck = M.deck;
  if (!deck) return null;
  const { S, P } = M;
  const cur = P.current.cur;
  const set = M.flowsSet();
  // National mode: dots only; origin stations / flows are not drawn there (D13).
  if (P.current.national) return pickNational(M, px, py);
  if (!cur) return null;
  const st = S.current;
  const paused = st.animEnabled && !st.animPlaying;
  const q = (radius: number, layerIds: string[]) =>
    deck.pickRect({ x: px - radius, y: py - radius, width: 2 * radius + 1, height: 2 * radius + 1, layerIds });
  const infos = q(SEC_RADIUS, ["pick-chords", "pick-flows-all", "pick-flows-focus"]);

  const cands: PickCandidate[] = [];
  const hits: Hit[] = [];
  stationCandidates(M, px, py, cands, hits);
  trainCandidates(M, cands, hits);
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
    if (id === "pick-chords") {
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
      if (index === undefined) continue; // drawn but not hoverable
      const f = flows[index];
      cands.push({ kind: "section", index, n: f.n, line: { pts: set.pts, off: set.off[s], count: set.len[s] } });
      const subN = destSecCounts && destSecCounts.has(s) ? destSecCounts.get(s) : undefined;
      hits.push({ kind: "seg", s, n: f.n, subN });
    }
  }
  const win = pickPriority(cands, px, py, st.view, { paused, direction, destSelected: !!destSecCounts });
  return win ? hits[cands.indexOf(win)] : null;
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
    lines: hit.kind === "seg" ? sectionLines(atlas.data, P.current, hit.s) : [],
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
  if (a.kind === "natCity" && b.kind === "natCity") return a.idx === b.idx;
  if (a.kind === "station" && b.kind === "station")
    return a.station === b.station;
  return true; // origin
}
