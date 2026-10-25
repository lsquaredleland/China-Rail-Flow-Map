// @ts-nocheck
/* SPIKE (throwaway, never merged): the ORIGIN view drawn by deck.gl behind
   ?renderer=deck. Everything is deliberately direct and ugly: it reads the
   same MapCtx the Canvas renderer reads and replaces only draw(M).
   Layout of the DOM in deck mode (inside #mapwrap):
     canvas#deckcv   deck.gl (WebGL), pointer-events none
     canvas#map      the old 2D canvas, transparent: label overlay + pointer capture
   The camera stays S.current.view; the Deck viewState is derived per frame
   (viewstate.ts). */
import { Deck, OrthographicView, PathLayer, ScatterplotLayer, LineLayer, SolidPolygonLayer, DataFilterExtension, PathStyleExtension } from "./vendor";
import { TailLayer } from "./TailLayer";
import { palette as makePalette, rampColor, stationR, stationZoomK, WIDTH_K } from "../../../lib";
import type { MapCtx } from "../context";
import { stationT, scheduleViewReport, updateScaleBar } from "../camera";
import { getDestSectionCounts, getActiveDestSectionCounts } from "../flows";
import { drawLabels } from "../stations";
import { getAllowedTrainCodes, getSelCache, isTrainShown } from "../trains";
import { viewToViewState } from "./viewstate";
import { natLayers, NAT_MODE } from "./nat";

const Q = new URLSearchParams(location.search);
export const DECK_MODE = Q.get("renderer") === "deck";
const GPU_TIME = Q.get("gputime") === "1";
const W: any = window;

/* ---------------- tiny helpers ---------------- */
const ids = new WeakMap<object, number>();
let idc = 0;
const idOf = (o: object | null | undefined) => (o ? (ids.get(o) ?? (ids.set(o, ++idc), idc)) : 0);

const colCache = new Map<string, number[]>();
export function rgba(s: string, a = 1): number[] {
  const k = s + "|" + a;
  let c = colCache.get(k);
  if (c) return c;
  let r = 0, g = 0, b = 0, al = 1;
  if (s[0] === "#") {
    const h = s.length === 4 ? s.slice(1).replace(/./g, (x) => x + x) : s.slice(1);
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = s.match(/[\d.]+/g)!.map(Number);
    r = m[0]; g = m[1]; b = m[2]; if (m.length > 3) al = m[3];
  }
  c = [r, g, b, Math.round(255 * al * a)];
  colCache.set(k, c);
  return c;
}

function flowRGB(n: number, maxN: number, pal: any, out: number[]) {
  const stops = pal.flowStops;
  if (!stops.length || maxN <= 0) { const c = rgba(pal.flow); out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return; }
  const t = Math.max(0, Math.min(1, Math.sqrt(n / maxN)));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const f = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      const a = stops[i - 1][1], c = stops[i][1];
      out[0] = Math.round(a[0] + (c[0] - a[0]) * f);
      out[1] = Math.round(a[1] + (c[1] - a[1]) * f);
      out[2] = Math.round(a[2] + (c[2] - a[2]) * f);
      return;
    }
  }
  const l = stops[stops.length - 1][1]; out[0] = l[0]; out[1] = l[1]; out[2] = l[2];
}

/* ---------------- static binary geometry ---------------- */
const binCache = new WeakMap<object, any>();
/** Whole DecodedSet as one binary PathLayer data object (geometry uploaded once). */
function binData(set: any, only?: (i: number) => boolean, closed = false): any {
  const key = only || closed ? null : set;
  if (key && binCache.has(key)) return binCache.get(key);
  const n = set.len.length;
  let data: any;
  let contiguous = !only && !closed;
  if (contiguous) {
    let exp = 0;
    for (let i = 0; i < n; i++) { if (set.off[i] !== exp) { contiguous = false; break; } exp += set.len[i] * 2; }
    if (exp !== set.pts.length) contiguous = false;
  }
  if (contiguous) {
    const si = new Uint32Array(n);
    for (let i = 0; i < n; i++) si[i] = set.off[i] / 2;
    data = { length: n, startIndices: si, attributes: { getPath: { value: set.pts, size: 2 } } };
  } else {
    const sel: number[] = [];
    for (let i = 0; i < n; i++) if (!only || only(i)) sel.push(i);
    let tot = 0;
    for (const i of sel) tot += set.len[i] + (closed ? 1 : 0);
    const pts = new Float32Array(tot * 2);
    const si = new Uint32Array(sel.length);
    let w = 0;
    sel.forEach((i, k) => {
      si[k] = w / 2;
      pts.set(set.pts.subarray(set.off[i], set.off[i] + set.len[i] * 2), w);
      w += set.len[i] * 2;
      if (closed) { pts[w] = set.pts[set.off[i]]; pts[w + 1] = set.pts[set.off[i] + 1]; w += 2; }
    });
    data = { length: sel.length, startIndices: si, attributes: { getPath: { value: pts, size: 2 } } };
  }
  if (key) binCache.set(key, data);
  return data;
}

const FRC = [0, 1e9];
const HALF = [0.5, 1e9];
const BUCKETS = [[80, 1e9], [30, 79.5], [10, 29.5], [3, 9.5], [0.5, 2.5]];
const dataFilter = new DataFilterExtension({ filterSize: 1 });
const dashExt = new PathStyleExtension({ dash: true });

/* ---------------- per-pass flow attribute arrays ---------------- */
const passArr = new Map<string, { key: string; n: Float32Array; col: Uint8Array }>();
function passLayer(id: string, set: any, items: { s: number; n: number }[], alpha: number, normMaxN: number, key: string, pal: any, fitScale: number, pickable = false) {
  const nSec = set.len.length;
  let e = passArr.get(id);
  if (!e || e.n.length !== nSec) { e = { key: "", n: new Float32Array(nSec), col: new Uint8Array(nSec * 4) }; passArr.set(id, e); }
  if (e.key !== key) {
    e.key = key;
    e.n.fill(0);
    const rgb = [0, 0, 0];
    const paper = rgba(pal.paper);
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      if (f.n <= 0) continue;
      e.n[f.s] = f.n;
      flowRGB(f.n, normMaxN, pal, rgb);
      const o = f.s * 4;
      if (alpha < 1) { // D3: opaque, pre-blended against paper
        e.col[o] = rgb[0] * alpha + paper[0] * (1 - alpha);
        e.col[o + 1] = rgb[1] * alpha + paper[1] * (1 - alpha);
        e.col[o + 2] = rgb[2] * alpha + paper[2] * (1 - alpha);
      } else { e.col[o] = rgb[0]; e.col[o + 1] = rgb[1]; e.col[o + 2] = rgb[2]; }
      e.col[o + 3] = 255;
    }
  }
  const nArr = e.n, col = e.col;
  // Canvas draws widest first so narrow flows sit on top; a binary PathLayer is in section order,
  // so emulate the order with width buckets (one layer each, widest first) via the filter range.
  return BUCKETS.map(([lo, hi], k) => new PathLayer({
    id: id + "-b" + k, data: binData(set), _pathType: "open", pickable,
    widthUnits: "common", widthMinPixels: 0.5, capRounded: true, jointRounded: true,
    getWidth: (_: any, { index }: any) => (nArr[index] * WIDTH_K) / fitScale,
    getColor: (_: any, { index, target }: any) => { const o = index * 4; target[0] = col[o]; target[1] = col[o + 1]; target[2] = col[o + 2]; target[3] = 255; return target; },
    extensions: [dataFilter],
    getFilterValue: (_: any, { index }: any) => nArr[index],
    filterRange: [lo, hi],
    updateTriggers: { getWidth: [key, fitScale], getColor: key, getFilterValue: key },
  }));
}

/* ---------------- flow pass decision tree (mirrors drawFlows) ---------------- */
function flowPasses(M: MapCtx, pal: any, destSecCounts: Map<number, number> | null) {
  const { S, P, flowsList, activeTimeline, isFilteredView } = M;
  const cur = P.current.cur!;
  const flows = flowsList();
  const baseCur = P.current.baseCur || cur;
  const baseFlows = P.current.direction === "out" ? baseCur.flows : baseCur.inFlows;
  const baseMaxN = P.current.direction === "out" ? baseCur.maxFlow : baseCur.maxInFlow;
  const maxN = P.current.direction === "out" ? cur.maxFlow : cur.maxInFlow;
  const filtered = isFilteredView();
  const timeline = activeTimeline();
  const isAnimated = S.current.animEnabled && !!timeline;
  const live = isAnimated && S.current.animTime < timeline!.totalMins;
  const step = isAnimated && timeline ? Math.min(timeline.numSteps - 1, Math.max(0, Math.floor(S.current.animTime / timeline.stepMins))) : 0;
  const curMaxN = filtered ? baseMaxN : isAnimated && timeline ? timeline.maxFlowSteps[step] || maxN : maxN;
  const effMax = Math.max(1, curMaxN);
  let active: { s: number; n: number }[];
  if (isAnimated && timeline) {
    if (!live) active = flows;
    else {
      active = [];
      for (const f of flows) { const n = timeline.secFlowSteps.get(f.s)?.[step] ?? 0; if (n > 0) active.push({ s: f.s, n }); }
    }
  } else active = flows;
  const base = `${idOf(cur)}|${P.current.direction}|${live ? step : -1}|${pal.paper}`;
  const dimA = P.current.dark ? 0.16 : 0.18;
  const passes: any[] = [];
  const iso = P.current.isolatedTrainCode;
  if (iso) {
    passes.push({ tag: "ctx", items: active, alpha: P.current.dark ? 0.06 : 0.08, max: effMax, key: base + "|iso" });
  } else if (destSecCounts) {
    passes.push({ tag: "ctx", items: filtered ? baseFlows : active, alpha: dimA, max: effMax, key: base + "|dest-ctx|" + filtered + idOf(baseCur) });
    if (destSecCounts.size > 0) {
      const sub: { s: number; n: number }[] = [];
      if (live) {
        const ac = getActiveDestSectionCounts(M, S.current.animTime);
        const an = new Map<number, number>();
        for (const a of active) an.set(a.s, a.n);
        for (const [s, d] of ac.entries()) { const sn = Math.min(an.get(s) ?? 0, d); if (sn > 0) sub.push({ s, n: sn }); }
      } else {
        for (const f of flows) { const sn = Math.min(f.n, destSecCounts.get(f.s) || 0); if (sn > 0) sub.push({ s: f.s, n: sn }); }
      }
      passes.push({ tag: "focus", items: sub, alpha: 1, max: effMax, key: base + "|dest-focus|" + (P.current.panelDest?.idx) + "|" + (live ? S.current.animTime : -1) });
    }
  } else if (filtered) {
    passes.push({ tag: "ctx", items: baseFlows, alpha: dimA, max: effMax, key: base + "|filt-ctx" + idOf(baseCur) });
    passes.push({ tag: "focus", items: active, alpha: 1, max: effMax, key: base + "|filt-focus" });
  } else {
    passes.push({ tag: "focus", items: active, alpha: 1, max: effMax, key: base + "|plain" });
  }
  return passes;
}

/* ---------------- chords ---------------- */
function chordItems(M: MapCtx, pal: any) {
  const { S, P, activeTimeline, isFilteredView } = M;
  const cur = P.current.cur!;
  const isIso = Boolean(P.current.isolatedTrainCode);
  const filtered = isFilteredView();
  const st = S.current;
  const hasSel = !!P.current.panelDest;
  let alpha = 1;
  if (isIso) alpha = P.current.dark ? 0.05 : 0.08;
  else if (hasSel || filtered) alpha = P.current.dark ? 0.16 : 0.18;
  const animated = st.animEnabled && !P.current.showInfra && !filtered;
  const tl = activeTimeline();
  const gated = animated && !!tl && st.animTime < tl.totalMins;
  const isoTrain = gated && isIso ? cur.deps?.find((t) => t.code === P.current.isolatedTrainCode) : undefined;
  let firstDep: Map<number, number> | null = null;
  if (gated && !isIso) {
    firstDep = new Map();
    for (const d of cur.deps || []) { const p = firstDep.get(d.tcIdx); if (p === undefined || d.depMins < p) firstDep.set(d.tcIdx, d.depMins); }
  }
  const hl = st.hover && st.hover.kind === "chord" ? st.hover.chord : null;
  const out: any[] = [];
  for (const ch of cur.chords) {
    if (hl === ch) continue;
    if (gated) {
      if (isIso) { if (!isoTrain || isoTrain.tcIdx !== ch.b || st.animTime < isoTrain.depMins) continue; }
      else { const dep = firstDep!.get(ch.b); if (dep === undefined || st.animTime < dep) continue; }
    }
    out.push(ch);
  }
  return { items: out, alpha, isIso, hl };
}

/* ---------------- stations ---------------- */
function stationItems(M: MapCtx, pal: any) {
  const { S, P, points, activeTimeline } = M;
  const cur = P.current.cur!;
  const pts = points();
  const sk = stationT(M);
  const timeline = activeTimeline();
  const isAnimated = S.current.animEnabled && !!timeline;
  const sel = getSelCache(M);
  const allowedCodes = getAllowedTrainCodes(M);
  const pd = P.current.panelDest;
  const hover = S.current.hover;
  const hoveredIdx = hover && hover.kind === "station" ? hover.station.idx : -1;
  const dark = P.current.dark;
  const items: any[] = [];
  const ripples: any[] = [];
  const edge = rgba(pal.dotEdge);
  const lw = dark ? 3.0 : 1.5;
  const mk = (c: any, alphaMul: number) => {
    const cityArr = allowedCodes ? sel?.cityTimes.get(c.idx) ?? null : c.arrTimes || null;
    const total = allowedCodes ? (cityArr ? cityArr.length : 0) : c.trains;
    let eff = total, recent = false, dt0 = 0;
    if (isAnimated && timeline) {
      const t = S.current.animTime;
      if (t >= timeline.totalMins) eff = total;
      else if (cityArr && cityArr.length > 0) {
        let count = 0;
        for (let k = 0; k < cityArr.length; k++) { if (cityArr[k] <= t) count++; else break; }
        eff = count;
        if (count > 0) { const dt = t - cityArr[count - 1]; if (dt >= 0 && dt <= 20) { recent = true; dt0 = dt; } }
      } else eff = 0;
    }
    const r0 = stationR(eff), kd = stationZoomK(r0, sk), r = r0 * kd;
    const fill = typeof c.fastest === "number" ? rgba(rampColor(c.fastest, pal)) : rgba(pal.dot);
    items.push({ c, pos: c.pt, r: r, fill: [fill[0], fill[1], fill[2], 255 * alphaMul], line: [edge[0], edge[1], edge[2], 255 * alphaMul], lw });
    if (recent && isAnimated && (!allowedCodes || total > 0)) {
      const frac = dt0 / 20;
      ripples.push({ pos: c.pt, r: r + frac * 7 * kd, col: rgba(dark ? "#F59E0B" : "#D97706", Math.max(0, 1 - frac)) });
    }
  };
  if (pd) {
    const a = dark ? 0.16 : 0.18;
    for (const c of pts) if (c.idx !== pd.idx && c.idx !== hoveredIdx) mk(c, a);
    let drawn = false;
    for (const c of pts) { if (c.idx === pd.idx) drawn = true; if (c.idx === pd.idx || c.idx === hoveredIdx) mk(c, 1); }
    if (!drawn) mk(pd, 1);
  } else for (const c of pts) mk(c, 1);
  // rings
  const rings: any[] = [];
  const ink = dark ? "#EDEDEA" : "#111111";
  if (pd) { const r = stationR(pd.trains) * stationZoomK(stationR(pd.trains), sk) + 3.8; rings.push({ pos: pd.pt, r: r, w: 3, col: rgba(ink) }); }
  if (hover && hover.kind === "station") { const hc = hover.station; const r = stationR(hc.trains) * stationZoomK(stationR(hc.trains), sk) + 3.5; rings.push({ pos: hc.pt, r: r, w: 2, col: rgba(ink) }); }
  else if (hover && hover.kind === "origin") rings.push({ pos: cur.o.pt, r: 14.5, w: 2, col: rgba(ink) });
  return { items, ripples, rings };
}

/* ---------------- trains ---------------- */
let cap = 4096;
let posBuf = new Float32Array(cap * 2);
let colBuf = new Uint8Array(cap * 4);
let tSrc = new Float32Array(cap * 2);
let tTgt = new Float32Array(cap * 2);
let tailCol = new Uint8Array(cap * 4);
const GLOW = [[245, 158, 11], [6, 182, 212], [226, 232, 240]];
const glowIdx = (cls: string) => (cls === "G" || cls === "D" || cls === "C" ? 0 : cls === "Z" || cls === "T" || cls === "K" || cls === "S" ? 1 : 2);

function growTo(n: number) {
  if (n <= cap) return;
  cap = Math.max(n, cap * 2);
  posBuf = new Float32Array(cap * 2); colBuf = new Uint8Array(cap * 4);
  tSrc = new Float32Array(cap * 2); tTgt = new Float32Array(cap * 2); tailCol = new Uint8Array(cap * 4);
}

function trainLayers(M: MapCtx, pal: any, R: any) {
  const { S, P, activeTimeline, activeTrainsAt } = M;
  const tl = activeTimeline();
  const layers: any[] = [];
  if (!tl) { R.trainList = []; return layers; }
  const act = activeTrainsAt(tl, S.current.animTime);
  const iso = P.current.isolatedTrainCode;
  const scale = S.current.view.scale;
  growTo(act.length + 1);
  let c = 0, tc = 0;
  const list: any[] = [];
  const dw: any[] = [];
  const hov: any[] = [];
  for (let i = 0; i < act.length; i++) {
    const tr = act[i];
    if (!isTrainShown(M, tr.code)) continue;
    const isIso = iso === tr.code;
    if (iso && !isIso) continue;
    const g = GLOW[glowIdx(tr.cls)];
    const a = tr.onChord ? 115 : 255;
    posBuf[c * 2] = tr.lon; posBuf[c * 2 + 1] = tr.lat;
    colBuf[c * 4] = g[0]; colBuf[c * 4 + 1] = g[1]; colBuf[c * 4 + 2] = g[2]; colBuf[c * 4 + 3] = a;
    list.push(tr);
    c++;
    const dwelling = Boolean(tr.isDwelling);
    const sf = tr.speedFrac !== undefined ? tr.speedFrac : dwelling ? 0 : 1;
    const L = dwelling || tr.onChord ? 0 : Math.round((isIso ? 22 : 12) * sf);
    if (L > 0) {
      const dx = Math.cos(tr.heading) * L / scale, dy = Math.sin(tr.heading) * L / scale;
      tSrc[tc * 2] = tr.lon - dx; tSrc[tc * 2 + 1] = tr.lat - dy; tTgt[tc * 2] = tr.lon; tTgt[tc * 2 + 1] = tr.lat;
      tailCol[tc * 4] = g[0]; tailCol[tc * 4 + 1] = g[1]; tailCol[tc * 4 + 2] = g[2]; tailCol[tc * 4 + 3] = 255;
      tc++;
    }
    if (dwelling) dw.push({ pos: [tr.lon, tr.lat], col: [g[0], g[1], g[2], 217], r: isIso ? 8.5 : 6.5 });
    const isHov = S.current.hover && S.current.hover.kind === "train" && S.current.hover.train.code === tr.code;
    if (isHov || P.current.selectedTrainCode === tr.code || isIso)
      hov.push({ pos: [tr.lon, tr.lat], col: isIso ? [g[0], g[1], g[2], 255] : [255, 255, 255, 255], r: isIso ? 9 : 7, w: isIso ? 2.5 : 2 });
  }
  R.trainList = list;
  R.trainCount = c;
  layers.push(new TailLayer({
    id: "tails", data: { length: tc, attributes: {
      getSourcePosition: { value: tSrc, size: 2 },
      getTargetPosition: { value: tTgt, size: 2 },
      getColor: { value: tailCol, size: 4, normalized: true } } },
    widthUnits: "pixels", getWidth: iso ? 3.5 : 2.5, pickable: false,
  }));
  layers.push(new ScatterplotLayer({
    id: "trains", data: { length: c, attributes: {
      getPosition: { value: posBuf, size: 2 },
      getLineColor: { value: colBuf, size: 4, normalized: true } } },
    radiusUnits: "pixels", lineWidthUnits: "pixels", stroked: true, filled: true,
    getRadius: iso ? 4.15 : 3, getLineWidth: iso ? 2.7 : 2, // outer edge = radius + lineWidth/2 (stroke is CENTRED on the radius in 9.4.0)
    getFillColor: [255, 255, 255, 255],
    pickable: !S.current.animPlaying, parameters: { depthCompare: "always" },
  }));
  layers.push(new ScatterplotLayer({
    id: "dwell", data: dw, radiusUnits: "pixels", lineWidthUnits: "pixels", stroked: true, filled: false,
    getPosition: (d: any) => d.pos, getRadius: (d: any) => d.r, getLineWidth: 1.3, getLineColor: (d: any) => d.col,
    pickable: false, updateTriggers: { all: S.current.animTime },
  }));
  layers.push(new ScatterplotLayer({
    id: "trainring", data: hov, radiusUnits: "pixels", lineWidthUnits: "pixels", stroked: true, filled: false,
    getPosition: (d: any) => d.pos, getRadius: (d: any) => d.r, getLineWidth: (d: any) => d.w, getLineColor: (d: any) => d.col,
    pickable: false, updateTriggers: { all: S.current.animTime },
  }));
  return layers;
}

/* ---------------- backdrop ---------------- */
const outCache = new WeakMap<object, any>();
function outlinePrep(outline: any) {
  let o = outCache.get(outline);
  if (o) return o;
  const { rings, lines } = outline;
  const polys: Float32Array[] = [];
  for (let i = 0; i < rings.len.length; i++) polys.push(rings.pts.subarray(rings.off[i], rings.off[i] + rings.len[i] * 2));
  o = {
    polys,
    ringStroke: binData(rings, undefined, true),
    solid: binData(lines, (i) => lines.len[i] > 4),
    dashed: binData(lines, (i) => lines.len[i] <= 4),
  };
  outCache.set(outline, o);
  return o;
}
const grat: any[] = [];
for (let lon = 30; lon <= 180; lon += 5) grat.push({ s: [lon, -10], t: [lon, 80] });
for (let lat = -10; lat <= 80; lat += 5) grat.push({ s: [30, lat], t: [180, lat] });

function backdropLayers(M: MapCtx, pal: any) {
  const { P, S } = M;
  const atlas = P.current.atlas!;
  const L: any[] = [];
  const outline = P.current.outline;
  if (P.current.showOutline && outline) {
    const o = outlinePrep(outline);
    L.push(new SolidPolygonLayer({ id: "outline-fill", data: o.polys, getPolygon: (d: any) => d, positionFormat: "XY", _normalize: false, getFillColor: rgba(pal.landFill), updateTriggers: { getFillColor: pal.paper } }));
    L.push(new PathLayer({ id: "outline-stroke", data: o.ringStroke, _pathType: "open", widthUnits: "common", getWidth: 0.015, widthMinPixels: 0.65, capRounded: true, jointRounded: true, getColor: rgba(pal.outline), updateTriggers: { getColor: pal.paper } }));
    L.push(new PathLayer({ id: "outline-lines", data: o.solid, _pathType: "open", widthUnits: "common", getWidth: 0.015, widthMinPixels: 0.65, capRounded: true, jointRounded: true, getColor: rgba(pal.outline), updateTriggers: { getColor: pal.paper } }));
    L.push(new PathLayer({ id: "outline-dash", data: o.dashed, _pathType: "open", widthUnits: "common", getWidth: 0.02, widthMinPixels: 1, getColor: rgba(pal.outline), extensions: [dashExt], getDashArray: [2.2, 1.8], updateTriggers: { getColor: pal.paper } }));
  }
  L.push(new LineLayer({ id: "graticule", data: grat, getSourcePosition: (d: any) => d.s, getTargetPosition: (d: any) => d.t, widthUnits: "pixels", getWidth: 0.5, getColor: rgba(pal.graticule), updateTriggers: { getColor: pal.paper } }));
  if (P.current.showNetwork)
    L.push(new PathLayer({ id: "network", data: binData(atlas.net), _pathType: "open", widthUnits: "common", getWidth: 0.008, widthMinPixels: 0.45, widthMaxPixels: 2.5, capRounded: true, jointRounded: true, getColor: rgba(pal.network), updateTriggers: { getColor: pal.paper } }));
  return L;
}

/* ---------------- full layer stack ---------------- */
function buildLayers(M: MapCtx, pal: any, R: any) {
  const { S, P, flowsSet, widthOf } = M;
  const st = S.current;
  const cur = P.current.cur!;
  const set = flowsSet()!;
  const L: any[] = backdropLayers(M, pal);
  const destSecCounts = getDestSectionCounts(M);
  if (P.current.direction === "out") {
    const ch = chordItems(M, pal);
    const col = rgba(pal.chord, ch.alpha);
    L.push(new PathLayer({
      id: "chords", data: ch.items, getPath: (d: any) => d.flat, positionFormat: "XY", widthUnits: "pixels", extensions: [dashExt],
      getWidth: ch.isIso ? 1.5 : (d: any) => widthOf(d.n),
      getDashArray: (d: any) => { const w = ch.isIso ? 1.5 : widthOf(d.n); return [Math.max(3, w * 1.1) / w, Math.max(2.5, w * 0.8) / w]; },
      getColor: col, pickable: false,
      updateTriggers: { getWidth: [st.view.scale, ch.isIso], getDashArray: [st.view.scale, ch.isIso], getPath: [ch.items.length, idOf(cur)] },
    }));
    if (ch.hl && !ch.isIso) {
      const hw = widthOf(ch.hl.n) + 1.6;
      L.push(new PathLayer({ id: "chord-hl", data: [ch.hl], getPath: (d: any) => d.flat, positionFormat: "XY", widthUnits: "pixels", getWidth: hw, extensions: [dashExt], getDashArray: [Math.max(3, hw * 1.1) / hw, Math.max(2.5, hw * 0.8) / hw], getColor: rgba(pal.flowHi) }));
    }
  }
  const passes = flowPasses(M, pal, destSecCounts);
  for (const p of passes) L.push(...passLayer("flows-" + p.tag, set, p.items, p.alpha, p.max, p.key, pal, st.fitScale));
  // isolated corridor (static full path only in the spike)
  const iso = P.current.isolatedTrainCode;
  if (iso) {
    const t = (P.current.direction === "out" ? cur.deps : cur.arrs).find((x: any) => x.code === iso);
    if (t && t.secs && t.secs.length) {
      const isHs = t.cls === "G" || t.cls === "D" || t.cls === "C";
      L.push(new PathLayer({ id: "iso", data: Array.from(t.secs), getPath: (s: number) => set.pts.subarray(set.off[s], set.off[s] + set.len[s] * 2), positionFormat: "XY", widthUnits: "pixels", getWidth: 2, capRounded: true, jointRounded: true, getColor: isHs ? [245, 158, 11, 255] : [6, 182, 212, 255], updateTriggers: { getPath: iso } }));
    }
  }
  if (P.current.showInfra) {
    const flows = M.flowsList();
    const mk = (tagId: string, hsr: number, alphaFn: (s: number) => number, col: string) => {
      const key = `${idOf(cur)}|${P.current.direction}|${P.current.panelDest?.idx}|${!!iso}|${P.current.dark}|${tagId}`;
      let e = passArr.get(tagId);
      if (!e || e.n.length !== set.len.length) { e = { key: "", n: new Float32Array(set.len.length), col: new Uint8Array(set.len.length * 4) }; passArr.set(tagId, e); }
      if (e.key !== key) {
        e.key = key; e.n.fill(0);
        const c = rgba(col);
        for (const f of flows) {
          if ((set.hsr[f.s] ? 1 : 0) !== hsr) continue;
          e.n[f.s] = 1;
          e.col[f.s * 4] = c[0]; e.col[f.s * 4 + 1] = c[1]; e.col[f.s * 4 + 2] = c[2]; e.col[f.s * 4 + 3] = 255 * alphaFn(f.s);
        }
      }
      const nA = e.n, cA = e.col;
      return new PathLayer({
        id: tagId, data: binData(set), _pathType: "open", widthUnits: "pixels", getWidth: 1.25, capRounded: true, jointRounded: true,
        getColor: (_: any, { index, target }: any) => { const o = index * 4; target[0] = cA[o]; target[1] = cA[o + 1]; target[2] = cA[o + 2]; target[3] = cA[o + 3]; return target; },
        extensions: [dataFilter], getFilterValue: (_: any, { index }: any) => nA[index], filterRange: HALF,
        updateTriggers: { getColor: key, getFilterValue: key },
      });
    };
    const dark = P.current.dark;
    const alphaFn = (s: number) => {
      if (iso) return dark ? 0.08 : 0.1;
      if (destSecCounts) return destSecCounts.has(s) ? 1 : dark ? 0.18 : 0.2;
      return 1;
    };
    L.push(mk("infra-conv", 0, alphaFn, pal.infraConv));
    L.push(mk("infra-hsr", 1, alphaFn, pal.infraHsr));
  }
  if (st.animEnabled) {
    if (NAT_MODE) L.push(...natLayers(M, pal, R));
    else L.push(...trainLayers(M, pal, R));
  }
  if (st.hover && st.hover.kind === "seg") {
    const h = st.hover;
    const n = h.subN !== undefined ? h.subN : h.n;
    const sub = destSecCounts ? destSecCounts.get(h.s) : undefined;
    const eff = sub !== undefined && sub > 0 ? sub : n;
    L.push(new PathLayer({ id: "seg-hl", data: [h.s], getPath: (s: number) => set.pts.subarray(set.off[s], set.off[s] + set.len[s] * 2), positionFormat: "XY", widthUnits: "pixels", getWidth: widthOf(eff) + 1.6, capRounded: true, jointRounded: true, getColor: rgba(pal.flowHi), updateTriggers: { getPath: h.s } }));
  }
  // stations
  const { items, ripples, rings } = stationItems(M, pal);
  R.stationList = items;
  const tkey = pal.paper + "|" + Math.round(stationT(M) * 1000) + "|" + st.animTime + "|" + (P.current.panelDest?.idx) + "|" + st.hover?.kind;
  L.push(new ScatterplotLayer({
    id: "stations", data: items, radiusUnits: "pixels", lineWidthUnits: "pixels", stroked: true, filled: true,
    getPosition: (d: any) => d.pos, getRadius: (d: any) => d.r, getFillColor: (d: any) => d.fill, getLineColor: (d: any) => d.line, getLineWidth: (d: any) => d.lw,
    pickable: true, updateTriggers: { getRadius: tkey, getFillColor: tkey, getLineColor: tkey, getLineWidth: tkey, getPosition: idOf(cur) + "|" + P.current.direction },
  }));
  L.push(new ScatterplotLayer({
    id: "ripples", data: ripples, radiusUnits: "pixels", lineWidthUnits: "pixels", stroked: true, filled: false,
    getPosition: (d: any) => d.pos, getRadius: (d: any) => d.r, getLineWidth: 1.5, getLineColor: (d: any) => d.col, pickable: false, updateTriggers: { all: tkey },
  }));
  L.push(new ScatterplotLayer({
    id: "rings", data: rings, radiusUnits: "pixels", lineWidthUnits: "pixels", stroked: true, filled: false,
    getPosition: (d: any) => d.pos, getRadius: (d: any) => d.r, getLineWidth: (d: any) => d.w, getLineColor: (d: any) => d.col, pickable: false, updateTriggers: { all: tkey },
  }));
  const dark = P.current.dark;
  L.push(new ScatterplotLayer({
    id: "origin", data: [cur.o], radiusUnits: "pixels", lineWidthUnits: "pixels", stroked: true, filled: true,
    getPosition: (d: any) => d.pt, getRadius: 9, getLineWidth: 1.5,
    getFillColor: dark ? [237, 237, 234, 255] : [17, 17, 17, 255], getLineColor: dark ? [26, 27, 30, 255] : [255, 255, 255, 255],
    pickable: true, updateTriggers: { getFillColor: dark, getLineColor: dark, getPosition: idOf(cur) },
  }));
  return L;
}

/* ---------------- deck lifecycle ---------------- */
interface Host { deck: any; canvas: HTMLCanvasElement; M: MapCtx; trainList: any[]; stationList: any[]; trainCount: number; afterRenders: number; errors: string[]; firstFrameAt: number; t0: number; ready: boolean }
let R: Host | null = null;
W.__deckStats = { afterRenders: 0, errors: [] as string[], createdAt: 0, firstFrameMs: -1, recreated: 0 };

function overlay(M: MapCtx) {
  const R_ = R!;
  const cv = M.canvasRef.current;
  if (!cv) return;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const st = M.S.current;
  const pal = makePalette(M.P.current.dark);
  ctx.setTransform(st.DPR, 0, 0, st.DPR, 0, 0);
  ctx.clearRect(0, 0, st.W, st.H);
  const vp = R_.deck.getViewports()[0];
  if (!vp) return;
  // project shim: everything the label code asks of the camera comes from the viewport deck just drew
  const M2: any = Object.create(M);
  M2.X = (lon: number) => vp.project([lon, 0])[0];
  M2.Y = (lat: number) => vp.project([0, lat])[1];
  M2.toLon = (px: number) => vp.unproject([px, 0])[0];
  M2.toLat = (py: number) => vp.unproject([0, py])[1];
  drawLabels(M2, ctx, pal);
  // origin diamond
  const cur = M.P.current.cur;
  if (cur) {
    const cx = M2.X(cur.o.pt[0]), cy = M2.Y(cur.o.pt[1]);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = M.P.current.dark ? "#1A1B1E" : "#ffffff";
    ctx.fillRect(-2.2, -2.2, 4.4, 4.4);
    ctx.restore();
  }
}

function ensure(M: MapCtx): Host | null {
  if (R) return R;
  const wrap = M.wrapRef.current;
  const map = M.canvasRef.current;
  if (!wrap || !map) return null;
  const cv = document.createElement("canvas");
  cv.id = "deckcv";
  cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none";
  wrap.insertBefore(cv, map);
  const st = M.S.current;
  const t0 = performance.now();
  W.__deckStats.createdAt = t0;
  const host: Host = { deck: null, canvas: cv, M, trainList: [], stationList: [], trainCount: 0, afterRenders: 0, errors: [], firstFrameAt: 0, t0, ready: false };
  R = host;
  host.deck = new Deck({
    canvas: cv,
    width: null, height: null,
    views: [new OrthographicView({ id: "map", flipY: false })],
    viewState: viewToViewState(st.view, st.W || 1, st.H || 1),
    controller: false,
    useDevicePixels: Math.min(3, window.devicePixelRatio || 1),
    deviceProps: GPU_TIME ? { debugGPUTime: true } : {},
    pickingRadius: 14,
    layers: [],
    onLoad: () => { host.ready = true; draw(M); },
    onError: (e: any) => { host.errors.push(String(e && e.message)); W.__deckStats.errors.push(String(e && e.message)); },
    onAfterRender: () => {
      host.afterRenders++;
      W.__deckStats.afterRenders = host.afterRenders;
      if (!host.firstFrameAt && host.deck.layerManager && host.deck.layerManager.getLayers().some((l: any) => l.id.startsWith("flows"))) {
        host.firstFrameAt = performance.now();
        W.__deckStats.firstFrameMs = host.firstFrameAt - (W.__deckStats.atlasReadyAt || host.t0);
        W.__deckStats.firstFrameSinceCreateMs = host.firstFrameAt - host.t0;
      }
      if (W.__nat && W.__nat.count > 0 && !W.__nat.firstFrameAt) W.__nat.firstFrameAt = performance.now();
      overlay(M);
    },
  });
  // Deck 9.4.0 never calls onError on context loss (_onContextLost is defined but unwired): own listeners.
  cv.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    W.__deckStats.lossEvents = (W.__deckStats.lossEvents || 0) + 1;
    W.__deckStats.errors.push("webglcontextlost (canvas event)");
  });
  cv.addEventListener("webglcontextrestored", () => { if (W.__deckRecreate) W.__deckRecreate(); });
  W.__deck = host.deck;
  W.__deckHost = host;
  W.__deckRecreate = () => {
    try { host.deck.finalize(); } catch (e) { /* lost context */ }
    host.canvas.remove();
    R = null;
    W.__deckStats.recreated++;
    draw(M);
  };
  return host;
}

function frameTail(M: MapCtx, pal: any) {
  const st = M.S.current;
  if (M.P.current.legendRef.current)
    M.P.current.legendRef.current.draw(pal, st.view.scale / st.fitScale, true, M.P.current.showInfra, st.animEnabled, stationT(M));
  updateScaleBar(M);
  const vk = st.view.scale + "|" + st.view.tx + "|" + st.view.ty;
  if (vk !== st.viewKey) { st.viewKey = vk; scheduleViewReport(M); }
}

export function draw(M: MapCtx) {
  const atlas = M.P.current.atlas;
  const cur = M.P.current.cur;
  if (!atlas || !cur) return;
  if (!W.__deckStats.atlasReadyAt) W.__deckStats.atlasReadyAt = performance.now();
  const h = ensure(M);
  if (!h) return;
  const st = M.S.current;
  const pal = makePalette(M.P.current.dark);
  h.canvas.style.background = pal.paper;
  if (!h.ready) return; // onLoad redraws
  const layers = buildLayers(M, pal, h);
  h.deck.setProps({ viewState: viewToViewState(st.view, st.W, st.H), layers });
  h.deck.redraw("spike"); // synchronous draw, like draw(M) on Canvas
  frameTail(M, pal);
}

/* ---------------- picking (deck GPU picking for dots/stations) ---------------- */
export function deckPick(M: MapCtx, px: number, py: number): any | null {
  if (!R || !R.ready) return null;
  const d = R.deck;
  const st = M.S.current;
  if (R.trainCount > 0 && !st.animPlaying) {
    const i = d.pickObject({ x: px, y: py, radius: 14, layerIds: ["trains"] });
    if (i && i.index >= 0 && R.trainList[i.index]) return { kind: "train", train: R.trainList[i.index] };
  }
  const o = d.pickObject({ x: px, y: py, radius: 15, layerIds: ["origin"] });
  const s = d.pickObject({ x: px, y: py, radius: 14, layerIds: ["stations"] });
  if (o && o.picked && (!s || !s.picked)) return { kind: "origin" };
  if (o && o.picked && s && s.picked) {
    // origin wins ties (the Canvas rule); keep the nearer
    const sx = M.X(s.object.pos[0]), sy = M.Y(s.object.pos[1]);
    const ox = M.X(M.P.current.cur!.o.pt[0]), oy = M.Y(M.P.current.cur!.o.pt[1]);
    return Math.hypot(px - ox, py - oy) <= Math.hypot(px - sx, py - sy) ? { kind: "origin" } : { kind: "station", station: s.object.c };
  }
  if (s && s.picked && s.object) return { kind: "station", station: s.object.c };
  return null;
}

/* ---------------- measurement probes (M4 / M13) ---------------- */
W.__tailProbe = async () => {
  const h = R!;
  const vp = h.deck.getViewports()[0];
  const a = vp.unproject([300, 300]), b = vp.unproject([420, 300]);
  h.deck.setProps({ layers: [new TailLayer({ id: "probe", data: [{ s: a, t: b }], getSourcePosition: (d: any) => d.s, getTargetPosition: (d: any) => d.t, getColor: [6, 182, 212, 255], getWidth: 6, widthUnits: "pixels" })] });
  for (let i = 0; i < 6; i++) { h.deck.redraw("probe"); await new Promise((r) => setTimeout(r, 100)); }
  h.deck.redraw("probe");
  const gl = h.deck.device.handle;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const dpr = h.canvas.width / M_W();
  const out: number[] = [];
  const px = new Uint8Array(4);
  for (const x of [300.5, 305, 330, 360, 390, 415, 419.5]) {
    gl.readPixels(Math.floor(x * dpr), Math.floor(h.canvas.height - 300 * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.push(px[3] / 255);
  }
  return out;
};
function M_W() { return R!.M.S.current.W; }
W.__bufBytes = () => {
  const h = R!;
  let tot = 0;
  const per: any = {};
  for (const l of h.deck.layerManager.getLayers()) {
    let b = 0;
    const am = l.getAttributeManager && l.getAttributeManager();
    if (am) for (const a of Object.values(am.getAttributes()) as any[]) if (a.buffer) b += a.buffer.byteLength || 0;
    per[l.id] = b; tot += b;
  }
  return { tot, per };
};
