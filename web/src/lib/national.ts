/* National per-train timelines on section refs: every train's whole run (the
   pipeline's atlas-v2-national-trains file) as references into the shared
   section geometry, with the same distance scale and motion model as the
   origin timeline (timeline.ts). A position is two binary searches per
   train, so no per-train vertices are kept. */
import type { DecodedAtlas, NationalTimeline, NationalTrainsPack, SchedulesData } from "../types";
import { decodeSet, requireFmt } from "./decode";
import { getSecGeometry, prepTrainPath } from "./timeline";

/** Throw a FmtError unless `d` is a national trains file for a shared pack
    with `nSec` sections, `nThr` throats and `nTrains` train_table rows: same
    `fmt`, same id bases, one path and stop list per train. */
export function requireNationalTrains(d: NationalTrainsPack, nSec: number, nThr: number, nTrains: number, url: string): void {
  requireFmt(d.fmt, url);
  const ok =
    d.n_sec === nSec &&
    d.n_thr === nThr &&
    Array.isArray(d.paths) &&
    d.paths.length === nTrains &&
    Array.isArray(d.stop_pos) &&
    d.stop_pos.length === nTrains &&
    Array.isArray(d.chords) &&
    Array.isArray(d.extra);
  if (ok) return;
  const msg = `${url}: national trains do not match the shared pack (${nSec} sections, ${nThr} throats, ${nTrains} trains); rebuild the data pack`;
  const err = new Error(msg);
  err.name = "FmtError";
  throw err;
}

/** `out` is the national trains file (or any per-train path table of the
    same shape: out-tables `paths` / `stop_pos` / `chords`, no `extra`). */
export function buildNational(
  atlas: DecodedAtlas,
  out: Pick<NationalTrainsPack, "paths" | "stop_pos" | "chords"> & { extra?: string[] },
  sched: SchedulesData["schedules"] | undefined = atlas.schedules,
): NationalTimeline {
  const trainTable = atlas.data.train_table;
  const chordMap = new Map(out.chords);
  // Ids past the shared throats are the file's extra pieces: one throat set.
  const thr = out.extra?.length ? decodeSet([...(atlas.data.throats || []), ...out.extra]) : atlas.thr;
  const geo = { sec: atlas.sec, thr };
  const nT = out.paths.length;
  const skipped = { emptyPath: 0, noStops: 0, schedMismatch: 0, badTime: 0 };

  const keep: number[] = [];
  let nPath = 0;
  let nStop = 0;
  for (let t = 0; t < nT; t++) {
    const path = out.paths[t];
    const sp = out.stop_pos[t];
    const sd = sched?.[t];
    if (!path.length) { skipped.emptyPath++; continue; }
    if (!sp.length) { skipped.noStops++; continue; }
    if (!sd || sd.length <= sp.length) { skipped.schedMismatch++; continue; }
    keep.push(t);
    nPath += path.length;
    nStop += sp.length;
  }
  const n = keep.length;
  const tl: NationalTimeline = {
    n,
    tIdx: Int32Array.from(keep),
    cls: new Uint8Array(n),
    start: new Float32Array(n),
    end: new Float32Array(n),
    total: new Float64Array(n),
    pOff: new Int32Array(n + 1),
    pId: new Int32Array(nPath),
    pStart: new Float64Array(nPath),
    sOff: new Int32Array(n + 1),
    sDist: new Float64Array(nStop),
    sArr: new Float32Array(nStop),
    sDep: new Float32Array(nStop),
    thr,
    skipped,
  };
  let pi = 0;
  let si = 0;
  for (let q = 0; q < n; q++) {
    const t = keep[q];
    const path = out.paths[t];
    const sp = out.stop_pos[t];
    const sd = sched![t];
    const nStops = sp.length;
    const b = sd.length - 1 - nStops;
    const letter = trainTable[t]?.class || "?";
    tl.cls[q] = "GDC".includes(letter) ? 0 : "ZTKS".includes(letter) ? 1 : 2;
    tl.pOff[q] = pi;
    tl.sOff[q] = si;

    const p = prepTrainPath(path, sp, chordMap.get(t) || [], geo, b + 1);
    tl.pId.set(path, pi);
    tl.pStart.set(p.pathStarts, pi);
    pi += path.length;
    tl.total[q] = p.totalDist;

    // schedule minutes run from the train's first day; keep them in the
    // boarding day's frame
    const rb = sd[b];
    const depB = rb[3] * 1440 + rb[2] + (rb[1] >= 0 && rb[2] < rb[1] ? 1440 : 0);
    tl.start[q] = depB;
    let lastArr = depB;
    for (let i = 0; i < nStops; i++) {
      const r = sd[b + 1 + i];
      const isTerm = i === nStops - 1;
      const arr = r[3] * 1440 + r[1];
      tl.sDist[si] = p.stopDist[i];
      tl.sArr[si] = arr;
      tl.sDep[si] = isTerm || r[2] < 0 ? -1 : (r[3] + (r[2] < r[1] ? 1 : 0)) * 1440 + r[2];
      lastArr = arr;
      si++;
    }
    tl.end[q] = lastArr;
    if (!(lastArr > depB)) skipped.badTime++;
  }
  tl.pOff[n] = pi;
  tl.sOff[n] = si;
  return tl;
}

/** Scratch result of natState. */
export const nat = { dist: 0, speed: 1, dwell: false };

/** State of train q at ABSOLUTE minute `a` (start <= a <= end): distance
    along the path, speed fraction, dwelling. Same model as timeline.ts
    trainState (dwell at stops, linear legs). */
export function natState(tl: NationalTimeline, q: number, a: number): void {
  const s0 = tl.sOff[q], s1 = tl.sOff[q + 1];
  let legStartDist = 0;
  let legStartTime = tl.start[q];
  let legEndDist = tl.total[q];
  let legEndTime = tl.end[q];
  for (let s = s0; s < s1; s++) {
    const dep = tl.sDep[s];
    if (dep >= 0 && dep > tl.sArr[s] && a >= tl.sArr[s] && a <= dep) {
      nat.dist = tl.sDist[s]; nat.speed = 0; nat.dwell = true; return;
    }
  }
  for (let s = s0; s < s1; s++) {
    if (a < tl.sArr[s]) { legEndDist = tl.sDist[s]; legEndTime = tl.sArr[s]; break; }
    legStartDist = tl.sDist[s];
    legStartTime = tl.sDep[s] >= 0 ? tl.sDep[s] : tl.sArr[s];
  }
  const legDur = Math.max(1, legEndTime - legStartTime);
  const tau = Math.max(0, Math.min(1, (a - legStartTime) / legDur));
  nat.speed = 1;
  nat.dwell = false;
  nat.dist = legStartDist + tau * (legEndDist - legStartDist);
}

/** Writes lon, lat and the unit direction at route distance d of train q to
    o[oi..oi+3]: binary search the path entry, then the vertex segment in
    that section's shared cumulative lengths. The stretch between two
    entries (a chord gap) is crossed on a straight line. */
export function natXY(
  tl: NationalTimeline,
  atlas: DecodedAtlas,
  q: number,
  d: number,
  o: Float32Array | number[],
  oi: number,
): void {
  const nSecAll = atlas.sec.len.length;
  const first = tl.pOff[q];
  const last = tl.pOff[q + 1] - 1;
  let lo = first, hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl.pStart[mid] <= d) lo = mid; else hi = mid - 1;
  }
  const v = tl.pId[lo];
  const rev = v < 0;
  const id = rev ? ~v : v;
  const isSec = id < nSecAll;
  const set = isSec ? atlas.sec : tl.thr;
  const g = isSec ? id : id - nSecAll;
  const cnt = set.len[g];
  const off = set.off[g];
  const cum = getSecGeometry(set).secCumLens[g];
  const L = cnt > 0 ? cum[cnt - 1] : 0;
  const local = d - tl.pStart[lo];
  // point k of the entry in travel order
  const px = (k: number) => set.pts[off + (rev ? cnt - 1 - k : k) * 2];
  const py = (k: number) => set.pts[off + (rev ? cnt - 1 - k : k) * 2 + 1];

  if (local > L && lo < last) {
    // chord gap after this entry: to the first point of the next one
    const v2 = tl.pId[lo + 1];
    const id2 = v2 < 0 ? ~v2 : v2;
    const sec2 = id2 < nSecAll;
    const set2 = sec2 ? atlas.sec : tl.thr;
    const g2 = sec2 ? id2 : id2 - nSecAll;
    const k2 = v2 < 0 ? set2.len[g2] - 1 : 0;
    const x1 = set2.pts[set2.off[g2] + k2 * 2], y1 = set2.pts[set2.off[g2] + k2 * 2 + 1];
    const x0 = px(cnt - 1), y0 = py(cnt - 1);
    const span = tl.pStart[lo + 1] - tl.pStart[lo] - L;
    const al = span > 0 ? Math.max(0, Math.min(1, (local - L) / span)) : 0;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    o[oi] = x0 + al * dx;
    o[oi + 1] = y0 + al * dy;
    o[oi + 2] = dx / len;
    o[oi + 3] = dy / len;
    return;
  }
  if (cnt < 2) {
    o[oi] = cnt ? px(0) : 0;
    o[oi + 1] = cnt ? py(0) : 0;
    o[oi + 2] = 0;
    o[oi + 3] = 0;
    return;
  }
  // cum is in storage order; a reversed entry is walked from its far end
  const ld = Math.max(0, Math.min(L, local));
  const key = rev ? L - ld : ld;
  let a = 0, b = cnt - 2;
  while (a < b) {
    const mid = (a + b + 1) >> 1;
    if (cum[mid] <= key) a = mid; else b = mid - 1;
  }
  const i = rev ? cnt - 2 - a : a; // the same segment in travel order
  const seg = cum[a + 1] - cum[a];
  const sa = seg > 0 ? Math.max(0, Math.min(1, (key - cum[a]) / seg)) : 0;
  const al = rev ? 1 - sa : sa;
  const dx = px(i + 1) - px(i), dy = py(i + 1) - py(i);
  const len = Math.hypot(dx, dy) || 1;
  o[oi] = px(i) + al * dx;
  o[oi + 1] = py(i) + al * dy;
  o[oi + 2] = dx / len;
  o[oi + 3] = dy / len;
}

/** All trains on the line at display minute m (0..1440), wrap-around:
    a train is shown if any m + 1440k lies in [start, end]. Writes 6 floats
    per dot (lon, lat, ux, uy, speed, cls | dwell<<4) and returns the count.
    `qOut`, if given, receives each dot's train index (non-decreasing).
    `keep`, if given, is a per-train flag: trains with 0 are skipped. */
export function natPositions(tl: NationalTimeline, atlas: DecodedAtlas, m: number, out: Float32Array, qOut?: Int32Array, keep?: Uint8Array | null): number {
  let c = 0;
  for (let q = 0; q < tl.n; q++) {
    if (keep && !keep[q]) continue;
    const s = tl.start[q], e = tl.end[q];
    let k = Math.ceil((s - m) / 1440);
    for (; m + 1440 * k <= e; k++) {
      natState(tl, q, m + 1440 * k);
      natXY(tl, atlas, q, nat.dist, out, c * 6);
      out[c * 6 + 4] = nat.speed;
      out[c * 6 + 5] = tl.cls[q] | (nat.dwell ? 16 : 0);
      if (qOut) qOut[c] = q;
      c++;
    }
  }
  return c;
}
