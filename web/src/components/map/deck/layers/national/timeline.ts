/* National timeline and selection: the timeline built once per (atlas, national
   trains file), the filters resolved into a train selection, the keep masks and
   the one isolated train. `?natSynth=N` (perf runs only) repeats the trains with
   a +37 min shift until there are about N. Memo keys: see ./index.ts. */
import type { DecodedAtlas, NationalFlowsPack, NationalIndexPack, NationalTimeline, NationalTrainsData } from "../../../../../types";
import { buildNational, natCityCounts, natFilterKey, natFlowCounts, natIndexActive, natSelect } from "../../../../../lib";
import type { NatFilter } from "../../../../../lib";

/** Copies of every train, each shifted by +37 min from the last, until n is
    `target` (perf load only). Each copy repeats its path refs and stops, since
    natXY reads a train's refs as pOff[q] .. pOff[q + 1]. */
export function synthNational(tl: NationalTimeline, target: number): NationalTimeline {
  if (tl.n === 0 || target <= tl.n) return tl;
  const n = target;
  const reps = Math.ceil(n / tl.n);
  const nP = tl.pId.length * reps, nS = tl.sDist.length * reps;
  const out: NationalTimeline = {
    ...tl,
    n,
    tIdx: new Int32Array(n),
    cls: new Uint8Array(n),
    start: new Float32Array(n),
    end: new Float32Array(n),
    total: new Float64Array(n),
    pOff: new Int32Array(n + 1),
    pId: new Int32Array(nP),
    pStart: new Float64Array(nP),
    sOff: new Int32Array(n + 1),
    sDist: new Float64Array(nS),
    sArr: new Float32Array(nS),
    sDep: new Float32Array(nS),
  };
  let pi = 0, si = 0;
  for (let i = 0; i < n; i++) {
    const q = i % tl.n;
    const sh = Math.floor(i / tl.n) * 37;
    out.tIdx[i] = tl.tIdx[q];
    out.cls[i] = tl.cls[q];
    out.start[i] = tl.start[q] + sh;
    out.end[i] = tl.end[q] + sh;
    out.total[i] = tl.total[q];
    const a = tl.pOff[q], b = tl.pOff[q + 1];
    out.pOff[i] = pi;
    out.pId.set(tl.pId.subarray(a, b), pi);
    out.pStart.set(tl.pStart.subarray(a, b), pi);
    pi += b - a;
    out.sOff[i] = si;
    for (let s = tl.sOff[q]; s < tl.sOff[q + 1]; s++, si++) {
      out.sDist[si] = tl.sDist[s];
      out.sArr[si] = tl.sArr[s] + sh;
      out.sDep[si] = tl.sDep[s] < 0 ? -1 : tl.sDep[s] + sh;
    }
  }
  out.pOff[n] = pi;
  out.sOff[n] = si;
  return out;
}

const SYNTH = typeof location !== "undefined" ? +(new URLSearchParams(location.search).get("natSynth") || 0) : 0;

let built: { atlas: DecodedAtlas; data: NationalTrainsData; tl: NationalTimeline; ms: number } | null = null;

/** The national timeline for this atlas and trains file, built on first use. */
export function nationalTimeline(atlas: DecodedAtlas, data: NationalTrainsData | null | undefined): { tl: NationalTimeline; ms: number } | null {
  if (!data) return null;
  if (!built || built.atlas !== atlas || built.data !== data) {
    const t0 = performance.now();
    let tl = buildNational(atlas, data.trains, data.schedules);
    if (SYNTH > tl.n) tl = synthNational(tl, SYNTH);
    built = { atlas, data, tl, ms: performance.now() - t0 };
  }
  return built;
}

/** Most dots the timeline can show at once: a run of L minutes covers at
    most floor(L / 1440) + 1 instants m + 1440k. */
export function maxDots(tl: NationalTimeline): number {
  let c = 0;
  for (let q = 0; q < tl.n; q++) c += Math.floor(Math.max(0, tl.end[q] - tl.start[q]) / 1440) + 1;
  return c;
}

/** The national filters resolved once per (atlas, index, filter): the selected
    `train_table` rows (null = every train), the flow counts and, with the
    pack's `cities`, the city counts. */
export interface NatView {
  key: string;
  sel: Uint8Array | null;
  counts: Uint32Array;
  cities: { idx: number[]; dep: Uint32Array; arr: Uint32Array };
  /** An index filter (hour / distance / duration / code) is applied. */
  indexed: boolean;
}
let viewMemo: { atlas: DecodedAtlas; nf: NationalFlowsPack | null; ix: NationalIndexPack | null; key: string; v: NatView } | null = null;
export function natView(atlas: DecodedAtlas, nf: NationalFlowsPack | null, ix: NationalIndexPack | null, f: NatFilter): NatView {
  const key = natFilterKey(f) + (ix ? "|i" : "");
  if (viewMemo && viewMemo.atlas === atlas && viewMemo.nf === nf && viewMemo.ix === ix && viewMemo.key === key) return viewMemo.v;
  const sel = natSelect(atlas.data.train_table, ix, f);
  const v: NatView = {
    key,
    sel,
    counts: nf ? natFlowCounts(nf, ix, f, sel) : new Uint32Array(0),
    cities: nf ? natCityCounts(nf, ix, f, sel) : { idx: [], dep: new Uint32Array(0), arr: new Uint32Array(0) },
    indexed: !!ix && natIndexActive(f),
  };
  viewMemo = { atlas, nf, ix, key, v };
  return v;
}

/** Per-timeline-train 0/1 flag from the selected `train_table` rows (null =
    all). Memoised per (timeline, selection). */
let keepMemo: { tl: NationalTimeline; sel: Uint8Array; keep: Uint8Array } | null = null;
export function nationalKeep(tl: NationalTimeline, sel: Uint8Array | null): Uint8Array | null {
  if (!sel) return null;
  if (keepMemo && keepMemo.tl === tl && keepMemo.sel === sel) return keepMemo.keep;
  const keep = new Uint8Array(tl.n);
  for (let q = 0; q < tl.n; q++) keep[q] = sel[tl.tIdx[q]];
  keepMemo = { tl, sel, keep };
  return keep;
}

/** The timeline row of the train with this code (null if it has no run) and a
    keep mask holding only it. Memoised per (timeline, code). */
let isoMemo: { tl: NationalTimeline; code: string; v: { q: number; keep: Uint8Array } | null } | null = null;
export function nationalIsolated(atlas: DecodedAtlas, tl: NationalTimeline, code: string): { q: number; keep: Uint8Array } | null {
  if (isoMemo && isoMemo.tl === tl && isoMemo.code === code) return isoMemo.v;
  const t = atlas.data.train_table.findIndex((r) => r.code === code);
  let v: { q: number; keep: Uint8Array } | null = null;
  for (let q = 0; t >= 0 && q < tl.n; q++) {
    if (tl.tIdx[q] !== t) continue;
    const keep = new Uint8Array(tl.n);
    keep[q] = 1;
    v = { q, keep };
    break;
  }
  isoMemo = { tl, code, v };
  return v;
}
