/* Flow layers: routed section flows, the infrastructure overlay, dashed
   chords, the hover highlight and the isolated-train corridor, as deck.gl
   layers. The decisions (which
   passes, items, alphas) come from lib/mapModel.

   Flow passes (C19): one binary PathLayer per pass whose geometry is uploaded
   in `pass.items` order (n > 0 only). Deck draws path instances in path order
   with depth-test less-equal, so path order is paint order, which reproduces
   Canvas's widest-first overdraw. The pass data is rebuilt when the items
   identity changes and cached in a WeakMap; `info.index` maps back to the
   section through `idxToSec`. No module state is shared with the entry bundle
   (C23): the caches below are private to this chunk. */
import type { Layer } from "@deck.gl/core";
import { PathStyleExtension } from "@deck.gl/extensions";
import { PathLayer } from "@deck.gl/layers";
import type { ActiveTrainVM, ChordVM, DayTimelineVM, DecodedSet, Hit, Palette } from "../../../../types";
import {
  WIDTH_K,
  flowUnits,
  flowWidth,
  zoomWidthScale,
  activeTimeline,
  animStep,
  chordPlan,
  chordVisible,
  flowColor,
  flowPasses,
  highlightSegN,
  infraPasses,
  isFerrySection,
  isolatedCorridor,
  palette,
  rgba,
  splitFerry,
} from "../../../../lib";
import type { FlowItem, FlowPass, InfraPass, ModelCaches, ModelState, RGBA } from "../../../../lib";

/** Infrastructure hairline width, CSS px (the former Canvas renderer's INFRA_WIDTH). */
const INFRA_WIDTH = 1.25;

const dashExt = new PathStyleExtension({ dash: true });

/* ---------- binary pass data (C19) ---------- */

type BinaryData = {
  length: number;
  startIndices: Uint32Array;
  attributes: { getPath: { value: Float32Array; size: 2 } };
};

interface DashPiece {
  path: number[];
  n: number;
  /** Section of a flow pass's ferry piece (not set on infra pieces). */
  s?: number;
}

export interface PassData {
  /** Unique per built object: the update-trigger key for its accessors. */
  id: number;
  set: DecodedSet;
  data: BinaryData;
  /** Train count per path. */
  n: Float32Array;
  /** RGBA per path (4 bytes each). */
  rgba: Uint8Array;
  /** Path index -> section index (ferry land pieces map to their section). */
  idxToSec: Int32Array;
  /** Water crossings of the ferry items, drawn dashed on top of the pass. */
  ferry: DashPiece[];
}

interface FerrySplit {
  land: Map<number, number[][]>;
  water: Map<number, number[][]>;
}
const ferryCache = new WeakMap<object, FerrySplit>();
function ferryOf(set: DecodedSet): FerrySplit {
  let f = ferryCache.get(set);
  if (f) return f;
  const { landPieces, waterPieces } = splitFerry(set);
  const group = (ps: { s: number; pts: number[] }[]) => {
    const m = new Map<number, number[][]>();
    for (const p of ps) {
      const a = m.get(p.s);
      if (a) a.push(p.pts);
      else m.set(p.s, [p.pts]);
    }
    return m;
  };
  f = { land: group(landPieces), water: group(waterPieces) };
  ferryCache.set(set, f);
  return f;
}

let nextId = 1;

/** Geometry of `secs` (section indices) in the given order. `ferry`: 'land'
    replaces a ferry section by its overland pieces (the water leg is dashed
    separately), 'whole' keeps the section as is. */
function assemble(set: DecodedSet, secs: ArrayLike<number>, ferry: "land" | "whole") {
  const { pts, off, len, bb } = set;
  const fs = ferry === "land" ? ferryOf(set) : null;
  const landOf = (s: number) => (fs && isFerrySection(bb, s) ? fs.land.get(s) : undefined);
  let paths = 0;
  let verts = 0;
  for (let k = 0; k < secs.length; k++) {
    const lp = landOf(secs[k]);
    if (lp) {
      for (const p of lp) {
        paths++;
        verts += p.length / 2;
      }
    } else {
      paths++;
      verts += len[secs[k]];
    }
  }
  const out = new Float32Array(verts * 2);
  const startIndices = new Uint32Array(paths);
  const idxToSec = new Int32Array(paths);
  const itemOfPath = new Int32Array(paths);
  let w = 0;
  let pi = 0;
  for (let k = 0; k < secs.length; k++) {
    const s = secs[k];
    const lp = landOf(s);
    if (lp) {
      for (const p of lp) {
        startIndices[pi] = w / 2;
        idxToSec[pi] = s;
        itemOfPath[pi++] = k;
        for (let j = 0; j < p.length; j++) out[w++] = p[j];
      }
    } else {
      startIndices[pi] = w / 2;
      idxToSec[pi] = s;
      itemOfPath[pi++] = k;
      out.set(pts.subarray(off[s], off[s] + len[s] * 2), w);
      w += len[s] * 2;
    }
  }
  const data: BinaryData = { length: paths, startIndices, attributes: { getPath: { value: out, size: 2 } } };
  return { data, idxToSec, itemOfPath };
}

/** Pre-blends a faded colour opaque against the paper (D3): the pass then
    draws like Canvas's single-alpha stroke, without overlap build-up. */
function blendOver(c: RGBA, paper: RGBA, alpha: number): RGBA {
  const a = alpha * (c[3] / 255);
  return [
    Math.round(c[0] * a + paper[0] * (1 - a)),
    Math.round(c[1] * a + paper[1] * (1 - a)),
    Math.round(c[2] * a + paper[2] * (1 - a)),
    255,
  ];
}

const passCache = new WeakMap<object, Map<string, PassData>>();

/** Binary PathLayer data for one flow pass, in `items` order, n > 0 only.
    Cached per items identity; an unchanged pass costs nothing. */
export function buildPassData(
  set: DecodedSet,
  items: readonly FlowItem[],
  pal: Palette,
  alpha: number,
  maxN: number,
): PassData {
  const key = `${alpha}|${maxN}|${pal.paper}|${pal.flow}`;
  let perItems = passCache.get(items);
  const hit = perItems?.get(key);
  if (hit && hit.set === set) return hit;
  const secs: number[] = [];
  const ns: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].n > 0) {
      secs.push(items[i].s);
      ns.push(items[i].n);
    }
  }
  const a = assemble(set, secs, "land");
  const n = new Float32Array(a.data.length);
  const col = new Uint8Array(a.data.length * 4);
  const paper = rgba(pal.paper);
  const colours = new Map<number, RGBA>();
  for (let p = 0; p < a.data.length; p++) {
    const v = ns[a.itemOfPath[p]];
    n[p] = v;
    let c = colours.get(v);
    if (!c) {
      c = rgba(flowColor(v, maxN, pal));
      if (alpha < 1) c = blendOver(c, paper, alpha);
      colours.set(v, c);
    }
    col.set(c, p * 4);
  }
  const fs = ferryOf(set);
  const ferry: DashPiece[] = [];
  for (let k = 0; k < secs.length; k++) {
    const w = isFerrySection(set.bb, secs[k]) ? fs.water.get(secs[k]) : undefined;
    if (w) for (const path of w) ferry.push({ path, n: ns[k], s: secs[k] });
  }
  const pd: PassData = { id: nextId++, set, data: a.data, n, rgba: col, idxToSec: a.idxToSec, ferry };
  if (!perItems) passCache.set(items, (perItems = new Map()));
  perItems.set(key, pd);
  return pd;
}

/** `pd` (an alpha-1 pass; `alpha` fades the recount like buildPassData) with new per-section counts (national A+B, P3.3):
    the same geometry object and path order, so deck only refills the width
    and colour attributes (no re-tessellation); n and colours from
    `counts[section]`, a section at 0 fully transparent; the colour ramp
    stays normalised to `maxN`; ferry dashes of the sections with n > 0. */
export function recountPassData(pd: PassData, counts: ArrayLike<number>, pal: Palette, maxN: number, alpha = 1): PassData {
  const len = pd.data.length;
  const n = new Float32Array(len);
  const col = new Uint8Array(len * 4);
  const colours = new Map<number, RGBA>();
  const paper = rgba(pal.paper);
  for (let p = 0; p < len; p++) {
    const v = counts[pd.idxToSec[p]];
    n[p] = v;
    if (v <= 0) continue; // rgba 0: transparent
    let c = colours.get(v);
    if (!c) {
      c = rgba(flowColor(v, maxN, pal));
      colours.set(v, (c = alpha < 1 ? blendOver(c, paper, alpha) : c));
    }
    col.set(c, p * 4);
  }
  const ferry: DashPiece[] = [];
  for (const f of pd.ferry) {
    const v = counts[f.s ?? -1] ?? 0;
    if (v > 0) ferry.push({ path: f.path, n: v, s: f.s });
  }
  return { id: nextId++, set: pd.set, data: pd.data, n, rgba: col, idxToSec: pd.idxToSec, ferry };
}

/* ---------- memoised model output ---------- */

/* flowPasses allocates new item arrays on every call while animating; the
   rebuild is wanted once per animation step, not once per frame, so the model
   output is memoised on everything it reads that changes less often. */
let passMemo: { key: unknown[]; passes: FlowPass[] } | null = null;
let infraMemo: { key: unknown[]; passes: InfraPass[] } | null = null;
const sameKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function animKey(ms: ModelState): unknown[] {
  const tl = activeTimeline(ms);
  const running = ms.animEnabled && !!tl && ms.animTime < tl.totalMins;
  const done = !!tl && ms.animTime >= tl.totalMins;
  // A selected destination while running depends on the continuous clock
  // (getActiveDestSectionCounts); otherwise only on the 5-minute step.
  const t = !ms.animEnabled || !tl ? 0 : ms.panelDest && running ? ms.animTime : animStep(tl, ms.animTime);
  return [tl, t, done, ms.animEnabled];
}

function memoFlowPasses(ms: ModelState, caches: ModelCaches): FlowPass[] {
  const key = [ms.cur, ms.baseCur, ms.dir, ms.panelDest, ms.iso, ms.dark, ...animKey(ms)];
  if (passMemo && sameKey(passMemo.key, key)) return passMemo.passes;
  const passes = flowPasses(ms, caches);
  passMemo = { key, passes };
  return passes;
}

function memoInfraPasses(ms: ModelState, caches: ModelCaches): InfraPass[] {
  const key = [ms.cur, ms.baseCur, ms.dir, ms.panelDest, ms.iso, ms.dark];
  if (infraMemo && sameKey(infraMemo.key, key)) return infraMemo.passes;
  const passes = infraPasses(ms, caches);
  infraMemo = { key, passes };
  return passes;
}

/* ---------- layer builders ---------- */

interface FlowLayersInput {
  set: DecodedSet;
  ms: ModelState;
  caches: ModelCaches;
  dark: boolean;
  /** View scale (px per degree) and the fit scale of the national view. */
  scale: number;
  fitScale: number;
  /** Zoom clarity: flow widths grow with the square root of the zoom past the knee. */
  damped: boolean;
  hover: Hit | null;
  activeTrainsAt: (tl: DayTimelineVM, t: number) => ActiveTrainVM[];
  chords: ChordVM[];
}

const ferryBlue = (dark: boolean) => rgba(dark ? "#38BDF8" : "#0284C7");
/** Canvas flowWidth in CSS px. */
const widthPx = (n: number, scale: number, fitScale: number, damped: boolean) => flowWidth(n, scale, fitScale, damped);

function flowPassLayer(role: string, pd: PassData, scale: number, fitScale: number, dark: boolean, damped: boolean) {
  return new PathLayer({
    id: "flows-" + role,
    data: pd.data,
    _pathType: "open",
    widthUnits: "common",
    widthScale: zoomWidthScale(scale / fitScale, damped),
    widthMinPixels: 0.5,
    capRounded: true,
    jointRounded: true,
    getWidth: (_: unknown, { index }: { index: number }) => (flowUnits(pd.n[index]) * WIDTH_K) / fitScale,
    getColor: (_: unknown, { index, target }: { index: number; target?: number[] }) => {
      const t = target ?? [0, 0, 0, 0];
      t[0] = pd.rgba[index * 4];
      t[1] = pd.rgba[index * 4 + 1];
      t[2] = pd.rgba[index * 4 + 2];
      t[3] = pd.rgba[index * 4 + 3];
      return t as unknown as RGBA;
    },
    updateTriggers: { getWidth: [pd.id, fitScale], getColor: [pd.id, dark] },
  } as object);
}

/* Picking proxies (P1b.4). A drawn flow is as wide as its train count, so GPU
   picking on it would rank every band under the cursor "distance 0" and hide thin
   sections under wide ones. These hairline copies of the same geometry are
   pickable but never drawn (DeckHost layerFilter), so one rectangle query returns
   the sections whose centreline passes near the cursor. Costs one extra GPU copy
   of each pickable pass's geometry. Draw order is widest first and the depth test
   is strict (`less`), so where sections coincide the busiest keeps the pixel,
   which is what the Canvas picker's "busier wins" rule would choose. */
export const PICK_PREFIX = "pick-";
const PICK_WIDTH = 1.5;

function flowPickLayer(role: string, pd: PassData) {
  return new PathLayer({
    id: PICK_PREFIX + "flows-" + role,
    data: pd.data,
    _pathType: "open",
    widthUnits: "pixels",
    getWidth: PICK_WIDTH,
    getColor: [0, 0, 0, 0],
    pickable: true,
    // Read back by interaction.ts pick(): path index -> section (C19).
    idxToSec: pd.idxToSec,
    // Paths are in widest-first order; where sections coincide the first (busiest) keeps the pixel.
    parameters: { depthCompare: "less" },
  } as object);
}

/** Dashed open-water crossings of a pass's ferry items (the former Canvas renderer's strokeFlowList). */
function ferryDashLayer(id: string, pd: PassData, scale: number, fitScale: number, colour: RGBA, damped: boolean) {
  return new PathLayer<DashPiece>({
    id,
    data: pd.ferry,
    getPath: (d: DashPiece) => d.path,
    positionFormat: "XY",
    widthUnits: "common",
    widthScale: zoomWidthScale(scale / fitScale, damped),
    widthMinPixels: 0.5,
    getWidth: (d: DashPiece) => (flowUnits(d.n) * WIDTH_K) / fitScale,
    getColor: colour,
    capRounded: false,
    jointRounded: true,
    extensions: [dashExt],
    dashUnits: "pixels",
    getDashArray: (d: DashPiece) => {
      const w = widthPx(d.n, scale, fitScale, damped);
      return [Math.max(12, w * 2.5), Math.max(9, w * 1.8)];
    },
    updateTriggers: { getWidth: [fitScale, pd.id], getColor: colour.join(), getDashArray: [scale, fitScale, pd.id] },
  } as object);
}

/** One pass's layers: the flows, the pick proxy when pickable, the ferry dashes. */
export function passDataLayers(
  role: string,
  pd: PassData,
  alpha: number,
  pickable: boolean,
  pal: Palette,
  dark: boolean,
  scale: number,
  fitScale: number,
  damped = false,
): Layer[] {
  const L: Layer[] = [flowPassLayer(role, pd, scale, fitScale, dark, damped)];
  if (pickable) L.push(flowPickLayer(role, pd));
  if (pd.ferry.length) {
    const blue = ferryBlue(dark);
    const col = alpha >= 1 ? blue : blendOver(blue, rgba(pal.paper), alpha);
    L.push(ferryDashLayer(`flows-${role}-ferry`, pd, scale, fitScale, col, damped));
  }
  return L;
}

/** The flow passes in paint order, each followed by its ferry dashes (Canvas order). */
export function flowPassLayers(
  set: DecodedSet,
  passes: FlowPass[],
  pal: Palette,
  dark: boolean,
  scale: number,
  fitScale: number,
  damped: boolean,
): Layer[] {
  const L: Layer[] = [];
  for (const pass of passes) {
    const pd = buildPassData(set, pass.items, pal, pass.alpha, pass.maxN);
    L.push(...passDataLayers(pass.role, pd, pass.alpha, pass.pickable, pal, dark, scale, fitScale, damped));
  }
  return L;
}

/* ---------- infra ---------- */

interface InfraGeom {
  conv: BinaryData;
  hsr: BinaryData;
  ferry: DashPiece[];
}
const infraCache = new WeakMap<InfraPass, { set: DecodedSet; g: InfraGeom }>();
function infraGeom(set: DecodedSet, pass: InfraPass): InfraGeom {
  const hit = infraCache.get(pass);
  if (hit && hit.set === set) return hit.g;
  const conv: number[] = [];
  const hsr: number[] = [];
  const fs = ferryOf(set);
  const ferry: DashPiece[] = [];
  for (const f of pass.sections) {
    (set.hsr[f.s] ? hsr : conv).push(f.s);
    const w = isFerrySection(set.bb, f.s) ? fs.water.get(f.s) : undefined;
    if (w) for (const path of w) ferry.push({ path, n: 1 });
  }
  const g = {
    // Conventional rail: the ferry section's overland pieces; high-speed: traced whole (as Canvas).
    conv: assemble(set, conv, "land").data,
    hsr: assemble(set, hsr, "whole").data,
    ferry,
  };
  infraCache.set(pass, { set, g });
  return g;
}

export function infraLayers(set: DecodedSet, passes: InfraPass[], pal: Palette, dark: boolean): Layer[] {
  const L: Layer[] = [];
  const blue = ferryBlue(dark);
  passes.forEach((pass, i) => {
    const g = infraGeom(set, pass);
    const line = (id: string, data: BinaryData, css: string) =>
      new PathLayer({
        id: `infra-${i}-${id}`,
        data,
        _pathType: "open",
        widthUnits: "pixels",
        getWidth: INFRA_WIDTH,
        capRounded: true,
        jointRounded: true,
        getColor: rgba(css, pass.alpha),
        updateTriggers: { getColor: [dark, pass.alpha] },
      } as object);
    L.push(line("conv", g.conv, pal.infraConv));
    if (g.ferry.length) {
      L.push(
        new PathLayer<DashPiece>({
          id: `infra-${i}-ferry`,
          data: g.ferry,
          getPath: (d: DashPiece) => d.path,
          positionFormat: "XY",
          widthUnits: "pixels",
          getWidth: INFRA_WIDTH,
          getColor: [blue[0], blue[1], blue[2], Math.round(blue[3] * pass.alpha)],
          capRounded: false,
          extensions: [dashExt],
          dashUnits: "pixels",
          getDashArray: [7, 6],
          updateTriggers: { getColor: [dark, pass.alpha] },
        } as object),
      );
    }
    L.push(line("hsr", g.hsr, pal.infraHsr));
  });
  return L;
}

/* ---------- chords ---------- */

interface ChordItem {
  ch: ChordVM;
  path: number[];
}
const chordItemCache = new WeakMap<ChordVM, ChordItem>();
function chordItem(ch: ChordVM): ChordItem {
  let it = chordItemCache.get(ch);
  if (!it) chordItemCache.set(ch, (it = { ch, path: Array.prototype.slice.call(ch.flat, 0, ch.count * 2) as number[] }));
  return it;
}
let chordMemo: ChordItem[] = [];

const chordDash = (w: number): [number, number] => [Math.max(3, w * 1.1), Math.max(2.5, w * 0.8)];

function chordLayers(inp: FlowLayersInput, pal: Palette): Layer[] {
  const { ms, caches, scale, fitScale, hover, chords, damped } = inp;
  if (ms.dir !== "out") return [];
  const plan = chordPlan(ms, caches);
  if (!plan) return [];
  const highlight = hover && hover.kind === "chord" ? hover.chord : null;
  const vis: ChordItem[] = [];
  let pickable: ChordItem[] | null = null; // visible chords incl. the highlighted one, when it is not in `vis`
  for (const ch of chords) {
    if (!chordVisible(plan, ch, ms.animTime)) continue;
    if (highlight === ch) {
      pickable = [];
      continue;
    }
    vis.push(chordItem(ch));
  }
  if (pickable && highlight) pickable = [...vis, chordItem(highlight)];
  // Keep the data identity while the visible set is unchanged (gated by first departure).
  if (vis.length !== chordMemo.length || vis.some((v, i) => v !== chordMemo[i])) chordMemo = vis;
  const colour = rgba(pal.chord, plan.alpha);
  const L: Layer[] = [
    new PathLayer<ChordItem>({
      id: "chords",
      data: chordMemo,
      getPath: (d: ChordItem) => d.path,
      positionFormat: "XY",
      widthUnits: plan.isolated ? "pixels" : "common",
      widthScale: plan.isolated ? 1 : zoomWidthScale(scale / fitScale, damped),
      widthMinPixels: plan.isolated ? 0 : 0.5,
      getWidth: plan.isolated ? 1.5 : (d: ChordItem) => (flowUnits(d.ch.n) * WIDTH_K) / fitScale,
      getColor: colour,
      capRounded: false,
      jointRounded: true,
      extensions: [dashExt],
      dashUnits: "pixels",
      getDashArray: (d: ChordItem) => chordDash(plan.isolated ? 1.5 : widthPx(d.ch.n, scale, fitScale, damped)),
      updateTriggers: {
        getWidth: [plan.isolated, fitScale],
        getColor: colour.join(),
        getDashArray: [plan.isolated, scale, fitScale],
      },
    } as object),
  ];
  L.push(
    new PathLayer<ChordItem>({
      id: PICK_PREFIX + "chords",
      data: pickable ?? chordMemo,
      getPath: (d: ChordItem) => d.path,
      positionFormat: "XY",
      widthUnits: "pixels",
      getWidth: PICK_WIDTH,
      getColor: [0, 0, 0, 0],
      pickable: true,
      parameters: { depthCompare: "less" },
    } as object),
  );
  if (highlight && !plan.isolated) {
    const hw = widthPx(highlight.n, scale, fitScale, damped) + 1.6;
    L.push(
      new PathLayer<ChordItem>({
        id: "chord-highlight",
        data: [chordItem(highlight)],
        getPath: (d: ChordItem) => d.path,
        positionFormat: "XY",
        widthUnits: "pixels",
        getWidth: hw,
        getColor: rgba(pal.flowHi),
        capRounded: false,
        extensions: [dashExt],
        dashUnits: "pixels",
        getDashArray: chordDash(hw),
        updateTriggers: { getWidth: hw, getDashArray: hw },
      } as object),
    );
  }
  return L;
}

/* ---------- isolated corridor ---------- */

/** The former Canvas renderer's tracePartialSec: the section up to the vertex nearest `end`, then `end`. */
function partialPath(set: DecodedSet, s: number, endLon: number, endLat: number, rev: boolean): number[] {
  const { pts, off, len } = set;
  const o = off[s];
  const count = len[s];
  if (count <= 0) return [];
  let bestK = 0;
  let bestD2 = 1e9;
  for (let k = 0; k < count; k++) {
    const d2 = (pts[o + k * 2] - endLon) ** 2 + (pts[o + k * 2 + 1] - endLat) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestK = k;
    }
  }
  const out: number[] = [];
  if (!rev) for (let i = 0; i <= bestK; i++) out.push(pts[o + i * 2], pts[o + i * 2 + 1]);
  else for (let i = count - 1; i >= bestK; i--) out.push(pts[o + i * 2], pts[o + i * 2 + 1]);
  out.push(endLon, endLat);
  return out;
}

export function wholePath(set: DecodedSet, s: number, rev: boolean): number[] {
  const { pts, off, len } = set;
  const o = off[s];
  const out: number[] = [];
  if (!rev) for (let i = 0; i < len[s]; i++) out.push(pts[o + i * 2], pts[o + i * 2 + 1]);
  else for (let i = len[s] - 1; i >= 0; i--) out.push(pts[o + i * 2], pts[o + i * 2 + 1]);
  return out;
}

function corridorLayers(inp: FlowLayersInput): Layer[] {
  const { set, ms, activeTrainsAt } = inp;
  const corridor = isolatedCorridor(ms, activeTrainsAt);
  if (!corridor) return [];
  const paths: number[][] = [];
  if (corridor.secs.length > 0) {
    for (const sc of corridor.secs) {
      paths.push(sc.end ? partialPath(set, sc.s, sc.end.lon, sc.end.lat, sc.rev) : wholePath(set, sc.s, sc.rev));
    }
  } else if (corridor.chord) {
    const { chord: ch, to } = corridor.chord;
    paths.push(to ? [ch.flat[0], ch.flat[1], to.lon, to.lat] : chordItem(ch).path);
  }
  const live = paths.filter((p) => p.length >= 4);
  if (live.length === 0) return [];
  return [
    new PathLayer<number[]>({
      id: "corridor",
      data: live,
      getPath: (d: number[]) => d,
      positionFormat: "XY",
      widthUnits: "pixels",
      getWidth: 2,
      getColor: rgba(corridor.color),
      capRounded: true,
      jointRounded: true,
    } as object),
  ];
}

/* ---------- hover highlight ---------- */

function highlightLayers(inp: FlowLayersInput, pal: Palette): Layer[] {
  const { set, ms, caches, scale, fitScale, hover, dark, damped } = inp;
  if (!hover || hover.kind !== "seg") return [];
  const n = hover.subN !== undefined ? hover.subN : hover.n;
  const effectiveN = highlightSegN(ms, caches, hover.s, n);
  if (effectiveN === null) return [];
  const hw = widthPx(effectiveN, scale, fitScale, damped) + 1.6;
  const solid = (paths: number[][]) =>
    new PathLayer<number[]>({
      id: "seg-highlight",
      data: paths,
      getPath: (d: number[]) => d,
      positionFormat: "XY",
      widthUnits: "pixels",
      getWidth: hw,
      getColor: rgba(pal.flowHi),
      capRounded: true,
      jointRounded: true,
      updateTriggers: { getWidth: hw },
    } as object);
  if (!isFerrySection(set.bb, hover.s)) return [solid([wholePath(set, hover.s, false)])];
  // Overland part in flowHi, the open-water crossing in luminous water blue.
  const fs = ferryOf(set);
  const land = fs.land.get(hover.s) ?? [];
  const water = fs.water.get(hover.s) ?? [];
  const L: Layer[] = [];
  if (land.length) L.push(solid(land));
  if (water.length) {
    L.push(
      new PathLayer<number[]>({
        id: "seg-highlight-water",
        data: water,
        getPath: (d: number[]) => d,
        positionFormat: "XY",
        widthUnits: "pixels",
        getWidth: hw,
        getColor: rgba(dark ? "#7DD3FC" : "#0284C7"),
        capRounded: false,
        extensions: [dashExt],
        dashUnits: "pixels",
        getDashArray: [Math.max(12, hw * 2.5), Math.max(9, hw * 1.8)],
        updateTriggers: { getWidth: hw, getDashArray: hw },
      } as object),
    );
  }
  return L;
}

/* ---------- composition, in Canvas paint order ---------- */

/** `under`: chords, flow passes, corridor, infra (Canvas order; trains follow in P1b.3).
    `over`: the hover highlight (stations follow in P1b.3). */
export function flowLayers(inp: FlowLayersInput): { under: Layer[]; over: Layer[] } {
  const { set, ms, caches, scale, fitScale, dark, damped } = inp;
  const pal = palette(dark);
  const under: Layer[] = [
    ...chordLayers(inp, pal),
    ...flowPassLayers(set, memoFlowPasses(ms, caches), pal, dark, scale, fitScale, damped),
    ...corridorLayers(inp),
    ...(ms.showInfra ? infraLayers(set, memoInfraPasses(ms, caches), pal, dark) : []),
  ];
  return { under, over: highlightLayers(inp, pal) };
}
