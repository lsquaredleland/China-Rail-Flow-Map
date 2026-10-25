/* SPIKE (throwaway): national per-train timelines. Every train's FULL path
   as one flat polyline in the client's own distance scale (haversine km on
   the decoded section geometry, same as timeline.ts), its stops/dwells, and
   a wrap-around position(t) over the 24h loop. */
import type { DecodedAtlas, OutTablesPack, SchedulesData } from "../types";
import { haversineKm } from "./geo";
import { trainEase, trainSpeedFrac } from "./timeline";

export interface NationalTimeline {
  n: number; // trains kept
  tIdx: Int32Array; // train_table index
  cls: Uint8Array; // 0 high-speed (G/D/C), 1 conventional (Z/T/K/S), 2 other
  clsLetter: string[];
  start: Float32Array; // absolute minute of boarding (day-0 frame)
  end: Float32Array; // absolute arrival minute
  total: Float32Array; // total path distance (km, client scale)
  vOff: Int32Array; // n+1, vertex offsets
  vx: Float32Array;
  vy: Float32Array;
  vd: Float32Array; // cumulative distance at each vertex
  sOff: Int32Array; // n+1, stop offsets
  sDist: Float32Array;
  sArr: Float32Array;
  sDep: Float32Array; // -1 = no dwell (terminus)
  skipped: { emptyPath: number; noStops: number; schedMismatch: number; badTime: number; chord: number };
  chordKm: number;
}

export function buildNational(
  atlas: DecodedAtlas,
  out: OutTablesPack,
  sched: SchedulesData["schedules"],
  trainClass: string[],
): NationalTimeline {
  const secSet = atlas.sec;
  const thrSet = atlas.thr;
  const nSecAll = secSet.len.length;
  const chordMap = new Map(out.chords);
  const nT = out.paths.length;
  const skipped = { emptyPath: 0, noStops: 0, schedMismatch: 0, badTime: 0, chord: 0 };
  let chordKm = 0;

  // pass 1: size
  let nVert = 0;
  let nStop = 0;
  const keep: number[] = [];
  for (let t = 0; t < nT; t++) {
    const path = out.paths[t];
    const sp = out.stop_pos[t];
    const sd = sched[t];
    if (!path.length) { skipped.emptyPath++; continue; }
    if (!sp.length) { skipped.noStops++; continue; }
    if (!sd || sd.length <= sp.length) { skipped.schedMismatch++; continue; }
    keep.push(t);
    for (const v of path) {
      const id = v < 0 ? ~v : v;
      nVert += id < nSecAll ? secSet.len[id] : thrSet.len[id - nSecAll];
    }
    nStop += sp.length;
  }
  const n = keep.length;
  const tl: NationalTimeline = {
    n,
    tIdx: Int32Array.from(keep),
    cls: new Uint8Array(n),
    clsLetter: new Array(n),
    start: new Float32Array(n),
    end: new Float32Array(n),
    total: new Float32Array(n),
    vOff: new Int32Array(n + 1),
    vx: new Float32Array(nVert),
    vy: new Float32Array(nVert),
    vd: new Float32Array(nVert),
    sOff: new Int32Array(n + 1),
    sDist: new Float32Array(nStop),
    sArr: new Float32Array(nStop),
    sDep: new Float32Array(nStop),
    skipped,
    chordKm: 0,
  };
  let vi = 0;
  let si = 0;
  for (let q = 0; q < n; q++) {
    const t = keep[q];
    const path = out.paths[t];
    const sp = out.stop_pos[t];
    const sd = sched[t];
    const nPath = path.length;
    const letter = trainClass[t] || "?";
    tl.clsLetter[q] = letter;
    tl.cls[q] = "GDC".includes(letter) ? 0 : "ZTKS".includes(letter) ? 1 : 2;
    tl.vOff[q] = vi;
    tl.sOff[q] = si;

    const endPt = (i: number, atEnd: boolean): [number, number] => {
      const v = path[i];
      const id = v < 0 ? ~v : v;
      const set = id < nSecAll ? secSet : thrSet;
      const g = id < nSecAll ? id : id - nSecAll;
      const k = atEnd !== v < 0 ? set.len[g] - 1 : 0;
      return [set.pts[set.off[g] + k * 2], set.pts[set.off[g] + k * 2 + 1]];
    };
    // chord legs: one virtual gap per leg at its widest join
    const virt = new Map<number, number>();
    const virtStop = new Map<number, number>();
    for (const leg of chordMap.get(t) || []) {
      let bestJ = -1, bestGap = 0;
      for (let j = Math.max(1, leg[1]); j <= Math.min(nPath - 1, leg[2]); j++) {
        const gap = haversineKm(endPt(j - 1, true), endPt(j, false));
        if (gap > bestGap) { bestGap = gap; bestJ = j; }
      }
      if (bestJ > 0) { virt.set(bestJ, bestGap); virtStop.set(bestJ, leg[0]); }
    }
    if (virt.size) { skipped.chord++; for (const g of virt.values()) chordKm += g; }

    let cum = 0;
    const pathStarts = new Float64Array(nPath);
    for (let i = 0; i < nPath; i++) {
      const vg = virt.get(i);
      if (vg) cum += vg; // the dot crosses the gap on the first segment of this entry
      pathStarts[i] = cum;
      const v = path[i];
      const id = v < 0 ? ~v : v;
      const set = id < nSecAll ? secSet : thrSet;
      const g = id < nSecAll ? id : id - nSecAll;
      const cnt = set.len[g];
      const off = set.off[g];
      const rev = v < 0;
      let px = 0, py = 0;
      for (let k = 0; k < cnt; k++) {
        const kk = rev ? cnt - 1 - k : k;
        const x = set.pts[off + kk * 2], y = set.pts[off + kk * 2 + 1];
        if (k > 0) cum += haversineKm([px, py], [x, y]);
        tl.vx[vi] = x; tl.vy[vi] = y; tl.vd[vi] = cum; vi++;
        px = x; py = y;
      }
    }
    tl.total[q] = cum;

    // stops
    const nStops = sp.length;
    const b = sd.length - 1 - nStops;
    const rb = sd[b];
    const depB = rb[3] * 1440 + rb[2] + (rb[1] >= 0 && rb[2] < rb[1] ? 1440 : 0);
    tl.start[q] = depB;
    let prevDist = 0;
    let lastArr = depB;
    for (let i = 0; i < nStops; i++) {
      const j = b + 1 + i;
      const r = sd[j];
      const isTerm = i === nStops - 1;
      const k = sp[i];
      const dist = isTerm
        ? cum
        : Math.max(prevDist, k >= nPath ? cum : virt.get(k) && virtStop.get(k) === j ? pathStarts[k] - virt.get(k)! : pathStarts[k]);
      prevDist = dist;
      const arr = r[3] * 1440 + r[1];
      tl.sDist[si] = dist;
      tl.sArr[si] = arr;
      tl.sDep[si] = isTerm || r[2] < 0 ? -1 : (r[3] + (r[2] < r[1] ? 1 : 0)) * 1440 + r[2];
      lastArr = arr;
      si++;
    }
    tl.end[q] = lastArr;
    if (!(lastArr > depB)) skipped.badTime++;
  }
  tl.vOff[n] = vi;
  tl.sOff[n] = si;
  tl.chordKm = chordKm;
  return tl;
}

/** Scratch result of natState. */
export const nat = { dist: 0, speed: 1, dwell: false };

/** State of train q at ABSOLUTE minute `a` (start <= a <= end): distance
    along the path, speed fraction, dwelling. Same model as timeline.ts
    trainState (dwell at stops, eased legs). */
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
  nat.speed = trainSpeedFrac(tau, legDur);
  nat.dwell = false;
  nat.dist = legStartDist + trainEase(tau, legDur) * (legEndDist - legStartDist);
}

/** lon/lat + unit direction at distance d on train q's polyline. */
export function natXY(tl: NationalTimeline, q: number, d: number, o: Float32Array | number[], oi: number): void {
  let lo = tl.vOff[q], hi = tl.vOff[q + 1] - 1;
  const last = hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl.vd[mid] <= d) lo = mid; else hi = mid - 1;
  }
  const i = Math.min(lo, last - 1);
  const j = i + 1;
  const seg = tl.vd[j] - tl.vd[i];
  const al = seg > 0 ? Math.max(0, Math.min(1, (d - tl.vd[i]) / seg)) : 0;
  const dx = tl.vx[j] - tl.vx[i], dy = tl.vy[j] - tl.vy[i];
  o[oi] = tl.vx[i] + al * dx;
  o[oi + 1] = tl.vy[i] + al * dy;
  const L = Math.hypot(dx, dy) || 1;
  o[oi + 2] = dx / L;
  o[oi + 3] = dy / L;
}

/** All trains on the line at display minute m (0..1440), wrap-around:
    a train is shown if any m + 1440k lies in [start, end]. Writes 6 floats
    per dot (lon, lat, ux, uy, speed, cls | dwell<<4) and returns the count. */
export function natPositions(tl: NationalTimeline, m: number, out: Float32Array): number {
  let c = 0;
  for (let q = 0; q < tl.n; q++) {
    const s = tl.start[q], e = tl.end[q];
    let k = Math.ceil((s - m) / 1440);
    for (; m + 1440 * k <= e; k++) {
      const a = m + 1440 * k;
      natState(tl, q, a);
      natXY(tl, q, nat.dist, out, c * 6);
      out[c * 6 + 4] = nat.speed;
      out[c * 6 + 5] = tl.cls[q] | (nat.dwell ? 16 : 0);
      c++;
    }
  }
  return c;
}
