// lib/pick: the priority order and tie rules of the Canvas hit-test
// (components/map/interaction.ts), applied to deck GPU candidates.
import { expect, test } from "bun:test";
import { distToLine, distToSeg, pickPriority } from "../src/lib";
import type { PickCandidate } from "../src/lib";

const d = (kind: PickCandidate["kind"], distance: number, extra: Partial<PickCandidate> = {}): PickCandidate => ({
  kind,
  distance,
  index: 0,
  ...extra,
});
const P = (c: PickCandidate[], opts = {}) => pickPriority(c, 0, 0, undefined, opts);

test("train beats station and segment", () => {
  const train = d("train", 13);
  expect(P([d("section", 1, { n: 9 }), d("station", 2), train])).toBe(train);
});

test("train only when paused, and only within 14 px", () => {
  const st = d("station", 5);
  expect(P([d("train", 3), st], { paused: false })).toBe(st);
  expect(P([d("train", 14), st])).toBe(st);
  const t = d("train", 13.9);
  expect(P([t, st])).toBe(t);
});

test("nearest train wins; the first of equals", () => {
  const a = d("train", 5, { index: 0 });
  const b = d("train", 5, { index: 1 });
  const c = d("train", 6, { index: 2 });
  expect(P([c, a, b])).toBe(a);
  expect(P([b, a, c])).toBe(a);
  expect(P([c, b])).toBe(b);
});

test("station d=10 and origin d=10: the origin wins the tie", () => {
  const s = d("station", 10);
  const o = d("origin", 10);
  expect(P([s, o])).toBe(o);
  expect(P([o, s])).toBe(o);
});

test("a closer station beats the origin", () => {
  const s = d("station", 9);
  expect(P([s, d("origin", 10)])).toBe(s);
});

test("origin radius 15, station radius per candidate", () => {
  const o = d("origin", 15);
  expect(P([o])).toBe(o);
  expect(P([d("origin", 15.01)])).toBeNull();
  const big = d("station", 20, { radius: 24 });
  expect(P([big])).toBe(big);
  expect(P([d("station", 20, { radius: 19 })])).toBeNull();
});

test("nearest station; the later one in point order wins an exact tie", () => {
  const a = d("station", 6, { index: 3 });
  const b = d("station", 4, { index: 9 });
  expect(P([a, b])).toBe(b);
  const c = d("station", 4, { index: 12 });
  expect(P([b, c])).toBe(c);
  expect(P([c, b])).toBe(c);
});

test("station beats segment and chord", () => {
  const s = d("station", 14);
  expect(P([d("section", 0, { n: 50 }), d("chord", 0), s])).toBe(s);
});

test("two segments within 0.75 px: the busier wins", () => {
  const near = d("section", 4, { n: 5, index: 0 });
  const busy = d("section", 4.7, { n: 20, index: 1 });
  expect(P([near, busy])).toBe(busy);
  expect(P([busy, near])).toBe(busy);
});

test("a segment more than 0.75 px closer wins over a busier one", () => {
  const near = d("section", 4, { n: 5, index: 0 });
  const busy = d("section", 4.8, { n: 20, index: 1 });
  expect(P([near, busy])).toBe(near);
  // visited the other way round, the nearer one still replaces the busier one
  const busy0 = { ...busy, index: 0 };
  const near1 = { ...near, index: 1 };
  expect(P([busy0, near1])).toBe(near1);
});

test("equally busy within the tie: the first in order keeps it", () => {
  const a = d("section", 4, { n: 7, index: 0 });
  const b = d("section", 4.5, { n: 7, index: 1 });
  expect(P([b, a])).toBe(a);
});

test("section radius: 10 px, and the first must be nearer than 9.25", () => {
  expect(P([d("section", 9.2, { n: 1 })])).not.toBeNull();
  expect(P([d("section", 9.3, { n: 1 })])).toBeNull();
  expect(P([d("section", 10.5, { n: 1 })])).toBeNull();
});

test("chords only when there is no segment, outbound, and no destination", () => {
  const ch = d("chord", 3);
  const seg = d("section", 8, { n: 1 });
  expect(P([ch])).toBe(ch);
  expect(P([ch, seg])).toBe(seg);
  expect(P([ch], { direction: "in" })).toBeNull();
  expect(P([ch], { destSelected: true })).toBeNull();
  expect(P([ch, d("chord", 2)])).not.toBe(ch);
  expect(P([d("chord", 10)])).toBeNull();
});

test("empty and out-of-range candidates give null", () => {
  expect(P([])).toBeNull();
  expect(P([d("station", 30), d("section", 30, { n: 1 })])).toBeNull();
});

test("exact distance is recomputed from geometry, not taken from the GPU", () => {
  const view = { scale: 10, tx: 100, ty: 200 };
  // Station at lon 1, lat 2 -> px (110, 180).
  const s: PickCandidate = { kind: "station", index: 0, pos: [1, 2] };
  expect(pickPriority([s], 110, 180 + 14, view)).toBe(s);
  expect(pickPriority([s], 110, 180 + 14.01, view)).toBeNull();
  // Section: horizontal line at lat 0 from lon 0..5 -> y 200, x 100..150.
  const sec: PickCandidate = { kind: "section", index: 0, n: 1, line: { pts: [0, 0, 5, 0], off: 0, count: 2 } };
  expect(pickPriority([sec], 120, 205, view)).toBe(sec);
  expect(pickPriority([sec], 120, 215, view)).toBeNull();
  // Beyond the end the distance is to the endpoint.
  expect(pickPriority([sec], 160, 200, view)).toBeNull();
  expect(distToLine(160, 200, sec.line!, view)).toBeCloseTo(10, 9);
});

test("section tie rule on recomputed distances", () => {
  const view = { scale: 1, tx: 0, ty: 0 };
  // Two horizontal lines (lat -4 -> y 4 and lat -4.5 -> y 4.5), cursor at y 0.
  const a: PickCandidate = { kind: "section", index: 0, n: 3, line: { pts: [-50, -4, 50, -4], off: 0, count: 2 } };
  const b: PickCandidate = { kind: "section", index: 1, n: 30, line: { pts: [-50, -4.5, 50, -4.5], off: 0, count: 2 } };
  expect(pickPriority([a, b], 0, 0, view)).toBe(b);
  const c: PickCandidate = { ...b, line: { pts: [-50, -4.9, 50, -4.9], off: 0, count: 2 } };
  expect(pickPriority([a, c], 0, 0, view)).toBe(a);
});

test("section walk is per segment, as Canvas: the best is sticky inside a polyline", () => {
  const view = { scale: 1, tx: 0, ty: 0 };
  // Busy A: its first segment is 4.26 px away, a later one 3.55 px. The later one is not 0.75 px
  // nearer, so A's running best stays 4.26 and B (less busy, 3.33 px) is more than 0.75 px nearer:
  // B wins although A's minimum is only 0.22 px farther.
  const A: PickCandidate = { kind: "section", index: 0, n: 127, line: { pts: [-20, -4.26, 20, -4.26, 20, -3.55, -20, -3.55], off: 0, count: 4 } };
  const B: PickCandidate = { kind: "section", index: 1, n: 27, line: { pts: [-50, -3.33, 50, -3.33], off: 0, count: 2 } };
  expect(pickPriority([A, B], 0, 0, view)).toBe(B);
  // With the nearer segment first the minimum is kept and the busier A wins the tie.
  const A2: PickCandidate = { ...A, line: { pts: [-20, -3.55, 20, -3.55, 20, -4.26, -20, -4.26], off: 0, count: 4 } };
  expect(pickPriority([A2, B], 0, 0, view)).toBe(A2);
});

test("distToSeg", () => {
  expect(distToSeg(0, 1, -1, 0, 1, 0)).toBe(1);
  expect(distToSeg(3, 0, -1, 0, 1, 0)).toBe(2);
  expect(distToSeg(3, 4, 0, 0, 0, 0)).toBe(5);
});
