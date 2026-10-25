// National timelines on section refs (P2.1), on the whole-run national trains
// file (P2.2). The oracle is the spike's expanded-vertex method (every train's
// path as its own flat polyline, binary-searched), ported here and run on the
// outbound tail of each sampled train: per the file's invariants that tail is
// the out-tables path verbatim, with its stop positions and chord legs.
import { describe, expect, test } from "bun:test";
import { buildNational, haversineKm, nat, natPositions, natState, natXY, requireNationalTrains } from "../src/lib";
import type { NationalTimeline, NationalTrainsPack } from "../src/types";
import { nationalTrains, pack } from "./fixture";

const { atlas, tablesRaw } = pack();
const NT = nationalTrains();
const nt: NationalTrainsPack = NT.data;
// Expected counts per source: the full file, or the committed sample.
const EXPECT = NT.source === "full" ? { trains: 7157, at1095: 2893, at30: 992 } : { trains: 783, at1095: 347, at30: 148 };

const heap = () => {
  Bun.gc(true);
  const m = process.memoryUsage();
  return (m.heapUsed + m.external) / 1048576;
};
const h0 = heap();
const t0 = performance.now();
const tl: NationalTimeline = buildNational(atlas, nt);
const buildMs = performance.now() - t0;
const heapMb = heap() - h0;
const out = new Float32Array(tl.n * 6 * 3);
const nSecAll = atlas.sec.len.length;
const extraBase = nSecAll + atlas.thr.len.length;

/** Spike oracle over an out-tables path: expanded to vertices with cumulative
    distance (chord gaps added at the widest join of each leg), then the
    position at each distance by binary search over those vertices. */
function oracleXY(t: number, dists: number[]) {
  const path = tablesRaw.paths[t];
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

describe(`national timelines (${NT.source}: ${NT.path})`, () => {
  test("the file matches the shared pack; a mismatch is a FmtError", () => {
    const nTrains = atlas.data.train_table.length;
    expect(() => requireNationalTrains(nt, nSecAll, atlas.thr.len.length, nTrains, "nt")).not.toThrow();
    for (const bad of [{ ...nt, fmt: 5 }, { ...nt, n_sec: nt.n_sec + 1 }, { ...nt, n_thr: 0 }, { ...nt, paths: nt.paths.slice(1) }]) {
      let name = "";
      try {
        requireNationalTrains(bad, nSecAll, atlas.thr.len.length, nTrains, "nt");
      } catch (e) {
        name = (e as Error).name;
      }
      expect(name).toBe("FmtError");
    }
  });

  test(`(a) ${EXPECT.trains} trains, ${EXPECT.at1095} dots at 18:15`, () => {
    expect(tl.n).toBe(EXPECT.trains);
    expect(tl.skipped).toEqual({ emptyPath: nt.paths.length - EXPECT.trains, noStops: 0, schedMismatch: 0, badTime: 0 });
    expect(natPositions(tl, atlas, 1095, out)).toBe(EXPECT.at1095);
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
    expect(c).toBe(EXPECT.at30);
    expect(evening).toBeGreaterThan(0);
  });

  test("(c) outbound tails equal the expanded-vertex oracle within 1e-6 deg", () => {
    // trains with an out-tables row: the national path ends with it verbatim
    const qs: number[] = [];
    for (let q = 0; q < tl.n; q++) if (tablesRaw.paths[tl.tIdx[q]].length) qs.push(q);
    const step = Math.max(1, Math.floor(qs.length / 200));
    let checked = 0, heads = 0, worst = 0;
    const o = [0, 0, 0, 0];
    for (let i = 0; i < qs.length && checked < 200; i += step, checked++) {
      const q = qs[i], t = tl.tIdx[q];
      const tail = tablesRaw.paths[t];
      const whole = nt.paths[t];
      const j0 = whole.length - tail.length;
      expect(whole.slice(j0)).toEqual(tail);
      if (j0 > 0) heads++;
      const D = tl.pStart[tl.pOff[q] + j0]; // route distance where the tail starts
      const len = tl.total[q] - D;
      const fr = [0, 0.001, 0.07, 0.25, 0.5, 0.63, 0.9, 0.999, 1];
      const ds = fr.map((f) => f * len);
      // stops sit exactly on entry boundaries, where float summation order
      // decides which side of a join wins; sample just past them
      for (let s = tl.sOff[q]; s < tl.sOff[q + 1]; s++) if (tl.sDist[s] >= D) ds.push(tl.sDist[s] - D + 1e-6);
      const { total, res } = oracleXY(t, ds);
      expect(Math.abs(total - len)).toBeLessThan(1e-6);
      ds.forEach((d, k) => {
        natXY(tl, atlas, q, D + d, o, 0);
        const e = Math.max(Math.abs(o[0] - res[k][0]), Math.abs(o[1] - res[k][1]));
        worst = Math.max(worst, e);
      });
    }
    expect(checked).toBe(Math.min(200, qs.length));
    expect(checked).toBeGreaterThan(50);
    expect(heads).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1e-6);
  });

  test("heads and extra pieces: whole runs start before the first featured city", () => {
    // 185 trains have no out-tables row (all head); extra ids decode into the throat set
    let allHead = 0, withExtra = 0;
    const o = [0, 0, 0, 0];
    for (let q = 0; q < tl.n; q++) {
      const t = tl.tIdx[q];
      if (!tablesRaw.paths[t].length) allHead++;
      const ids = tl.pId.subarray(tl.pOff[q], tl.pOff[q + 1]);
      if (!ids.some((v) => (v < 0 ? ~v : v) >= extraBase)) continue;
      withExtra++;
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        natXY(tl, atlas, q, f * tl.total[q], o, 0);
        // on the map's extent (China), never the 0,0 of a missing piece
        expect(o[0]).toBeGreaterThan(70);
        expect(o[0]).toBeLessThan(140);
        expect(o[1]).toBeGreaterThan(15);
        expect(o[1]).toBeLessThan(55);
      }
    }
    expect(tl.thr.len.length).toBe(atlas.thr.len.length + nt.extra.length);
    expect(allHead).toBeGreaterThan(0);
    expect(withExtra).toBeGreaterThan(0);
  });

  test("natState dwells at a stop", () => {
    let q = 0;
    while (tl.sDep[tl.sOff[q]] <= tl.sArr[tl.sOff[q]]) q++;
    const s = tl.sOff[q];
    natState(tl, q, (tl.sArr[s] + tl.sDep[s]) / 2);
    expect(nat.dwell).toBe(true);
    expect(nat.dist).toBe(tl.sDist[s]);
  });

  test("natState is linear in time along a leg (midpoint = half the leg distance)", () => {
    let checked = 0;
    for (let q = 0; q < tl.n && checked < 200; q += 7) {
      const s0 = tl.sOff[q], s1 = tl.sOff[q + 1];
      let d0 = 0, t0 = tl.start[q];
      for (let s = s0; s <= s1; s++) {
        const d1 = s < s1 ? tl.sDist[s] : tl.total[q];
        const a1 = s < s1 ? tl.sArr[s] : tl.end[q];
        if (d1 > d0 && a1 - t0 >= 1) {
          natState(tl, q, t0 + (a1 - t0) / 2);
          expect(nat.dist).toBeCloseTo(d0 + (d1 - d0) / 2, 4);
          natState(tl, q, t0 + (a1 - t0) * 0.25);
          expect(nat.dist).toBeCloseTo(d0 + (d1 - d0) / 4, 4);
          checked++;
        }
        d0 = d1;
        if (s < s1) t0 = tl.sDep[s] >= 0 ? tl.sDep[s] : tl.sArr[s];
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  test("cost: heap, build time, per-call time at peak", () => {
    for (let i = 0; i < 50; i++) natPositions(tl, atlas, 1095 + i * 0.2, out);
    const t1 = performance.now();
    for (let i = 0; i < 300; i++) natPositions(tl, atlas, 1095 + i * 0.2, out);
    const ms = (performance.now() - t1) / 300;
    console.log(
      `national (${NT.source}): ${tl.n} trains, ${tl.pId.length} path refs, skipped ${JSON.stringify(tl.skipped)}; ` +
        `heap delta ${heapMb.toFixed(1)} MB; build ${buildMs.toFixed(0)} ms; natPositions ${ms.toFixed(2)} ms/call at peak`,
    );
    expect(heapMb).toBeLessThanOrEqual(30);
  });
});
