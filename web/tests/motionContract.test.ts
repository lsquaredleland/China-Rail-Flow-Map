// Motion contract (P3.3): the client's national motion (buildNational +
// natState: linear legs, dwell, 1-min minimum leg, boarding-day frame) and the
// pipeline's atlas-v2-national-entries file must agree on the minute each
// train's dot reaches each section start, within 0.1 min (the file's tick).
// Two inputs, as in national.test.ts:
//   - the committed sample (fixtures/national-entries-sample.json, written by
//     tools/national-entries-fixture.ts from an independent closed-form
//     linear model): always checked;
//   - the full entries file when it can be found (public/assets after the
//     swap, or staging/national-entries/run3): every section entry of a spread
//     of trains must appear in the file's tick list for that section.
// Changing the motion model (ease, dwell, frame) breaks this until the
// pipeline's entries.rs and the file are rebuilt to match.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildNational, nat, natState } from "../src/lib";
import type { NationalTimeline } from "../src/types";
import { nationalEntries, nationalTrains, pack } from "./fixture";

const TOL = 0.1 + 1e-6; // minutes: one tick
const { atlas } = pack();

/** First absolute minute at which the client dot has reached route distance d. */
function clientReach(tl: NationalTimeline, q: number, d: number): number {
  let lo = tl.start[q], hi = tl.end[q];
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    natState(tl, q, mid);
    if (nat.dist >= d - 1e-9) hi = mid; else lo = mid;
  }
  return hi;
}
const tod = (m: number) => ((m % 1440) + 1440) % 1440;
/** Circular distance between two minutes of the day. */
const cdist = (a: number, b: number) => Math.min(Math.abs(a - b), 1440 - Math.abs(a - b));

describe("motion contract: client reaches section starts at the shipped entry minute", () => {
  test("committed sample (closed-form linear model)", () => {
    const sample = JSON.parse(readFileSync(new URL("./fixtures/national-entries-sample.json", import.meta.url), "utf8"));
    const tl = buildNational(atlas, nationalTrains().data);
    const qOf = new Map<number, number>();
    for (let q = 0; q < tl.n; q++) qOf.set(tl.tIdx[q], q);
    let n = 0, worst = 0;
    for (const tr of sample.trains) {
      const q = qOf.get(tr.t);
      expect(q).toBeDefined();
      for (const [j, tick] of tr.entries) {
        const m = tod(clientReach(tl, q!, tl.pStart[tl.pOff[q!] + j]));
        const diff = cdist(m, tick / sample.ticks_per_min);
        worst = Math.max(worst, diff);
        expect(diff).toBeLessThanOrEqual(TOL);
        n++;
      }
    }
    expect(n).toBeGreaterThan(500);
    expect(worst).toBeLessThanOrEqual(TOL);
  });

  const ne = nationalEntries();
  if (ne) {
    test(`full entries file (${ne.path})`, () => {
      const d = ne.data;
      const tl = buildNational(atlas, ne.trains);
      const nSec = d.n_sec;
      const merged = new Map<number, number[]>();
      const ticksOf = (s: number) => {
        let a = merged.get(s);
        if (!a) {
          a = [];
          for (const c of d.by_class) for (const x of c[s]) a.push(x);
          a.sort((x, y) => x - y);
          merged.set(s, a);
        }
        return a;
      };
      const has = (a: number[], tick: number) => {
        const W = d.ticks_per_min * 1440;
        let lo = 0, hi = a.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (a[mid] < tick - 1) lo = mid + 1; else hi = mid;
        }
        if (lo < a.length && a[lo] <= tick + 1) return true;
        // wrap around midnight
        return (tick <= 1 && a.length > 0 && a[a.length - 1] >= W - 1) || (tick >= W - 1 && a.length > 0 && a[0] <= 1);
      };
      let n = 0, bad = 0;
      const firstSeen = new Set<number>();
      for (let q = 0; q < tl.n; q += 7) {
        firstSeen.clear();
        for (let j = tl.pOff[q]; j < tl.pOff[q + 1]; j++) {
          const v = tl.pId[j];
          const id = v < 0 ? ~v : v;
          if (id >= nSec || firstSeen.has(id)) continue;
          firstSeen.add(id);
          const m = clientReach(tl, q, tl.pStart[j]);
          // the file holds ceil(10 * minute of day - eps): the client minute lies in [tick/10 - 0.1, tick/10]
          const tick = Math.ceil(tod(m) * d.ticks_per_min - 1e-6);
          n++;
          if (!has(ticksOf(id), tick)) bad++;
        }
      }
      expect(n).toBeGreaterThan(10000);
      expect(bad).toBe(0);
    });
  }
});
