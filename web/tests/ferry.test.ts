// lib/ferry: the Qiongzhou Strait ferry corridor on the committed pack.
import { expect, test } from "bun:test";
import { isFerrySection, splitFerry } from "../src/lib";
import { pack } from "./fixture";

for (const key of ["sec", "inSec", "net"] as const) {
  test(`${key}: ferry sections split into exactly one water piece each; others untouched`, () => {
    const set = pack().atlas[key];
    const ferry: number[] = [];
    for (let s = 0; s < set.len.length; s++) if (isFerrySection(set.bb, s)) ferry.push(s);
    const { landPieces, waterPieces } = splitFerry(set);
    // every ferry section has exactly one water piece, and no other section has pieces
    expect(waterPieces.map((p) => p.s).sort((a, b) => a - b)).toEqual(ferry);
    for (const p of landPieces) expect(ferry).toContain(p.s);
    for (const p of waterPieces) expect(p.pts.length).toBe(4);
    // land pieces keep every point of the section
    for (const s of ferry) {
      const land = landPieces.filter((p) => p.s === s);
      expect(land.length).toBe(2);
      expect(land.reduce((a, p) => a + p.pts.length / 2, 0)).toBe(set.len[s]);
    }
  });
}

test("the pack has at least one ferry section", () => {
  const set = pack().atlas.net;
  let n = 0;
  for (let s = 0; s < set.len.length; s++) if (isFerrySection(set.bb, s)) n++;
  expect(n).toBeGreaterThan(0);
});

test("isFerrySection needs the bbox to span the strait", () => {
  const bb = new Float32Array([
    110.1, 20.0, 110.2, 20.4, // spans
    110.1, 20.0, 110.2, 20.1, // north end too far south
    109.0, 20.0, 110.2, 20.4, // west end beyond 110.0
  ]);
  expect([0, 1, 2].map((s) => isFerrySection(bb, s))).toEqual([true, false, false]);
});
