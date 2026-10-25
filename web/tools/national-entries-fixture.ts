// Writes web/tests/fixtures/national-entries-sample.json: the expected entry
// ticks (0.1 min of the day, rounded up, as atlas-v2-national-entries ships
// them) of a few national trains, for tests/motionContract.test.ts. The
// expected values come from a closed-form LINEAR motion model written here
// (leg start + fraction x leg duration, legs < 1 min stretched to 1 min,
// dwell between arrival and departure), not from natState, so the test
// compares two independent implementations. Trains, from the committed
// national trains sample: chord legs, extra pieces, overnight runs, and
// some plain long ones.
// usage: CRFM_NATIONAL_SAMPLE=1 bun tools/national-entries-fixture.ts
import fs from "node:fs";
import { buildNational } from "../src/lib";
import { nationalTrains, pack } from "../tests/fixture";

const { atlas } = pack();
const nt = nationalTrains().data;
const tl = buildNational(atlas, nt);
const base = nt.n_sec + nt.n_thr;
const chordT = new Set<number>(nt.chords.map((c: number[]) => c[0]));

function expectedMin(q: number, d: number): number {
  // first minute the dot has reached route distance d
  let d0 = 0, t0 = tl.start[q];
  const s0 = tl.sOff[q], s1 = tl.sOff[q + 1];
  for (let s = s0; s <= s1; s++) {
    const d1 = s < s1 ? tl.sDist[s] : tl.total[q];
    const a1 = s < s1 ? tl.sArr[s] : tl.end[q];
    if (d <= d1) {
      const dur = Math.max(1, a1 - t0);
      return d1 > d0 ? t0 + ((d - d0) / (d1 - d0)) * dur : a1;
    }
    d0 = d1;
    t0 = s < s1 && tl.sDep[s] >= 0 ? tl.sDep[s] : a1;
  }
  return tl.end[q];
}

const pick = new Set<number>();
const add = (pred: (q: number) => boolean, k: number) => {
  let n = 0;
  for (let q = 0; q < tl.n && n < k; q++) if (!pick.has(q) && pred(q)) { pick.add(q); n++; }
};
add((q) => chordT.has(tl.tIdx[q]), 2);
add((q) => nt.paths[tl.tIdx[q]].some((v: number) => (v < 0 ? ~v : v) >= base), 2);
add((q) => tl.end[q] > 1440 && tl.end[q] - tl.start[q] > 600, 2); // runs past midnight of the boarding day
add((q) => tl.sOff[q + 1] - tl.sOff[q] >= 8, 3);

const trains = [...pick].sort((a, b) => a - b).map((q) => {
  const entries: [number, number][] = [];
  for (let j = tl.pOff[q]; j < tl.pOff[q + 1]; j++) {
    const m = expectedMin(q, tl.pStart[j]);
    entries.push([j - tl.pOff[q], Math.ceil((((m % 1440) + 1440) % 1440) * 10 - 1e-6)]);
  }
  return { t: tl.tIdx[q], entries };
});
const dst = new URL("../tests/fixtures/national-entries-sample.json", import.meta.url);
fs.writeFileSync(dst, JSON.stringify({ ticks_per_min: 10, trains }) + "\n");
console.log(`${trains.length} trains, ${trains.reduce((n, t) => n + t.entries.length, 0)} entries`);
