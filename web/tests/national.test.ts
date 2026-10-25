// National timelines on section refs (P2.1). The oracle is the spike's
// expanded-vertex method (every train's path as its own flat polyline,
// binary-searched), ported here for a sample of trains.
import { describe, expect, test } from "bun:test";
import { buildNational, haversineKm, nat, natPositions, natState, natXY } from "../src/lib";
import type { NationalTimeline } from "../src/types";
import { pack } from "./fixture";

const { atlas, tablesRaw } = pack();

const heap = () => {
  Bun.gc(true);
  const m = process.memoryUsage();
  return (m.heapUsed + m.external) / 1048576;
};
const h0 = heap();
const t0 = performance.now();
const tl: NationalTimeline = buildNational(atlas, tablesRaw);
const buildMs = performance.now() - t0;
const heapMb = heap() - h0;
const out = new Float32Array(tl.n * 6 * 2);

/** Spike oracle: the train's path expanded to vertices with cumulative
    distance (chord gaps added at the widest join of each leg), then the
    position at each distance by binary search over those vertices. */
function oracleXY(q: number, dists: number[]) {
  const t = tl.tIdx[q];
  const path = tablesRaw.paths[t];
  const nSecAll = atlas.sec.len.length;
  const chordLegs = new Map(tablesRaw.chords).get(t) || [];
  const loc = (v: number) => {
    const id = v < 0 ? ~v : v;
    const set = id < nSecAll ? atlas.sec : atlas.thr;
    return { set, g: id < nSecAll ? id : id - nSecAll, rev: v < 0 };
  };
  const endPt = (i: number, atEnd: boolean): [number, number] => {
    const { set, g, rev } = loc(path[i]);
    const k = atEnd !== rev ? set.len[g] - 1 : 0;
    return [set.pts[set.off[g] + k * 2], set.pts[set.off[g] + k * 2 + 1]];
  };
  const virt = new Map<number, number>();
  for (const leg of chordLegs) {
    let bestJ = -1, bestGap = 0;
    for (let j = Math.max(1, leg[1]); j <= Math.min(path.length - 1, leg[2]); j++) {
      const gap = haversineKm(endPt(j - 1, true), endPt(j, false));
      if (gap > bestGap) { bestGap = gap; bestJ = j; }
    }
    if (bestJ > 0) virt.set(bestJ, bestGap);
  }
  const vx: number[] = [], vy: number[] = [], vd: number[] = [];
  let cum = 0;
  for (let i = 0; i < path.length; i++) {
    const vg = virt.get(i);
    if (vg) cum += vg;
    const { set, g, rev } = loc(path[i]);
    const cnt = set.len[g], off = set.off[g];
    let px = 0, py = 0;
    for (let k = 0; k < cnt; k++) {
      const kk = rev ? cnt - 1 - k : k;
      const x = set.pts[off + kk * 2], y = set.pts[off + kk * 2 + 1];
      if (k > 0) cum += haversineKm([px, py], [x, y]);
      vx.push(x); vy.push(y); vd.push(cum);
      px = x; py = y;
    }
  }
  const res = dists.map((d) => {
    let lo = 0, hi = vd.length - 1;
    const last = hi;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (vd[mid] <= d) lo = mid; else hi = mid - 1;
    }
    const i = Math.min(lo, last - 1), j = i + 1;
    const seg = vd[j] - vd[i];
    const al = seg > 0 ? Math.max(0, Math.min(1, (d - vd[i]) / seg)) : 0;
    return [vx[i] + al * (vx[j] - vx[i]), vy[i] + al * (vy[j] - vy[i])];
  });
  return { total: cum, res };
}

describe("national timelines", () => {
  test("(a) 2,668 dots at 18:15", () => {
    expect(natPositions(tl, atlas, 1095, out)).toBe(2668);
  });

  test("(b) wrap-around: overnight trains show after midnight", () => {
    const m = 30;
    const c = natPositions(tl, atlas, m, out);
    // every dot is some (train, k) with start <= m + 1440k <= end; count them
    // independently, and check some of them left the previous evening
    let expected = 0, evening = 0;
    for (let q = 0; q < tl.n; q++) {
      for (let k = -3; k <= 3; k++) {
        const a = m + 1440 * k;
        if (tl.start[q] <= a && a <= tl.end[q]) {
          expected++;
          if (tl.start[q] > m) evening++;
        }
      }
    }
    expect(c).toBe(expected);
    expect(evening).toBeGreaterThan(0);
  });

  test("(c) positions equal the expanded-vertex oracle within 1e-6 deg", () => {
    const step = Math.floor(tl.n / 200);
    let checked = 0, worst = 0;
    const o = [0, 0, 0, 0];
    for (let q = 0; q < tl.n && checked < 200; q += step, checked++) {
      const fr = [0, 0.001, 0.07, 0.25, 0.5, 0.63, 0.9, 0.999, 1];
      const ds = fr.map((f) => f * tl.total[q]);
      // stops sit exactly on entry boundaries, where float summation order
      // decides which side of a join wins; sample just past them
      for (let s = tl.sOff[q]; s < tl.sOff[q + 1]; s++) ds.push(tl.sDist[s] + 1e-6);
      const { total, res } = oracleXY(q, ds);
      expect(Math.abs(total - tl.total[q])).toBeLessThan(1e-6);
      ds.forEach((d, i) => {
        natXY(tl, atlas, q, d, o, 0);
        const e = Math.max(Math.abs(o[0] - res[i][0]), Math.abs(o[1] - res[i][1]));
        worst = Math.max(worst, e);
      });
    }
    expect(checked).toBe(200);
    expect(worst).toBeLessThan(1e-6);
  });

  test("natState dwells at a stop", () => {
    let q = 0;
    while (tl.sDep[tl.sOff[q]] <= tl.sArr[tl.sOff[q]]) q++;
    const s = tl.sOff[q];
    natState(tl, q, (tl.sArr[s] + tl.sDep[s]) / 2);
    expect(nat.dwell).toBe(true);
    expect(nat.dist).toBe(tl.sDist[s]);
  });

  test("cost: heap, build time, per-call time at peak", () => {
    for (let i = 0; i < 50; i++) natPositions(tl, atlas, 1095 + i * 0.2, out);
    const t1 = performance.now();
    for (let i = 0; i < 300; i++) natPositions(tl, atlas, 1095 + i * 0.2, out);
    const ms = (performance.now() - t1) / 300;
    console.log(
      `national: ${tl.n} trains, ${tl.pId.length} path refs, skipped ${JSON.stringify(tl.skipped)}; ` +
        `heap delta ${heapMb.toFixed(1)} MB; build ${buildMs.toFixed(0)} ms; natPositions ${ms.toFixed(2)} ms/call at peak`,
    );
    expect(heapMb).toBeLessThanOrEqual(30);
  });
});
