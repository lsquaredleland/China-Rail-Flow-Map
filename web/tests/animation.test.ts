// Animation + filter invariants on real origins (O13): trainDistAt,
// dwell positions, final-step flows == static flows (with and without
// filters), animated trains subset of the filter, no teleporting dots.
import { describe, expect, test } from "bun:test";
import { filterOrigin, trainDistAt } from "../src/lib";
import { origin } from "./fixture";

const ORIGINS = ["成都", "北京", "广州"];
const lastStep = (tl: { numSteps: number }) => tl.numSteps - 1;

/** A spread of train codes: every k-th departure, so ~12 per origin. */
function sampleCodes(zh: string, n = 12): string[] {
  const deps = origin(zh).deps;
  const stride = Math.max(1, Math.floor(deps.length / n));
  return deps.filter((_, i) => i % stride === 0).map((d) => d.code);
}

describe("trainDistAt / dwell", () => {
  for (const zh of ORIGINS) {
    test(`${zh}: monotone and dwell == stop.dist`, () => {
      const tl = origin(zh).timeline;
      let dwells = 0;
      let trains = 0;
      for (const code of sampleCodes(zh)) {
        const pt = tl.getPrepTrain(code);
        if (!pt) continue;
        trains++;
        let prev = -1;
        for (let t = pt.depMins - 5; t <= pt.arrMins + 5; t += 0.5) {
          const d = trainDistAt(pt, t);
          expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = d;
        }
        expect(trainDistAt(pt, pt.depMins)).toBeCloseTo(0, 6);
        expect(trainDistAt(pt, pt.arrMins)).toBeCloseTo(pt.totalDist, 6);
        for (const st of pt.stops || []) {
          if (st.depMins !== null && st.depMins > st.arrMins) {
            dwells++;
            for (const t of [st.arrMins, (st.arrMins + st.depMins) / 2, st.depMins])
              expect(Math.abs(trainDistAt(pt, t) - st.dist)).toBeLessThan(1e-9);
          }
        }
        // stops are in route order
        const dists = (pt.stops || []).map((s) => s.dist);
        expect(dists).toEqual([...dists].sort((a, b) => a - b));
      }
      expect(trains).toBeGreaterThan(5);
      expect(dwells).toBeGreaterThan(0);
    });
  }

  test("no dot teleports: 1-minute steps stay below 20 km", () => {
    // Cruise is ~6 km/min; a dot only crosses more at a throat hand-off or
    // chord. Mirrors the K678 step check in check_client_decode.mjs.
    const km = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * 96, (a[1] - b[1]) * 111);
    let steps = 0;
    for (const zh of ORIGINS) {
      const tl = origin(zh).timeline;
      for (const code of sampleCodes(zh, 6)) {
        const pt = tl.getPrepTrain(code);
        if (!pt) continue;
        let prev: number[] | null = null;
        for (let t = pt.depMins; t <= pt.arrMins; t += 1) {
          const a = tl.getActiveTrains(t).find((x) => x.code === code);
          if (!a) {
            prev = null;
            continue;
          }
          if (prev) {
            expect(km([a.lon, a.lat], prev)).toBeLessThan(20);
            steps++;
          }
          prev = [a.lon, a.lat];
        }
      }
    }
    expect(steps).toBeGreaterThan(1000);
  });
});

describe("final-step flows == static flows", () => {
  for (const zh of ORIGINS) {
    test(`${zh}: unfiltered`, () => {
      const o = origin(zh);
      const tl = o.timeline;
      const mism = o.flows
        .map((f) => [f.s, f.n, tl.secFlowSteps.get(f.s)?.[lastStep(tl)] ?? 0])
        .filter(([, n, a]) => n !== a);
      // KNOWN: 成都 has 1 section where the static flow is below the animated
      // count ([section, static n, animated n]): one train covers it on two
      // overlapping legs (土溪→平昌→达州). Static flows count distinct trains
      // per edge by design (docs/PIPELINE.md). The 成都 out-and-back loop
      // (8362, [2, 4]) was fixed by O18's class-vector chain split. The count
      // must not grow.
      expect(mism).toEqual(zh === "成都" ? [[8250, 1, 2]] : []);
      // and nothing lights up that is not in the static flows
      const known = new Set(o.flows.map((f) => f.s));
      for (const [s, a] of tl.secFlowSteps) if (a[lastStep(tl)] > 0) expect(known.has(s)).toBe(true);
      // cumulative: never decreases
      for (const a of tl.secFlowSteps.values()) for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThanOrEqual(a[i - 1]);
      // no filter returns the origin itself
      expect(filterOrigin(o, { classes: [], hours: [], distBins: [], durBins: [], trainCodes: [] })).toBe(o);
    });
  }
});

const dist = (bins: number[]) => bins.map((bin) => ({ bin, nb: 40, size: 100, label: "" }));
const CASES: [string, Record<string, unknown>][] = [
  ["hours 08-09 + distance 500-1000 km", { hours: [8, 9], distBins: dist([5, 6, 7, 8, 9]), unit: "km" }],
  ["hours 08-09", { hours: [8, 9] }],
  ["class G", { classes: ["G"] }],
  ["class K + duration 0-6 h", { classes: ["K"], durBins: [{ bin: 0, nb: 10, size: 360, label: "" }] }],
];

describe("filtered views", () => {
  for (const zh of ORIGINS) {
    for (const [name, crit] of CASES) {
      test(`${zh}: ${name}`, () => {
        const o = origin(zh);
        const base = o.timeline;
        const view = filterOrigin(o, crit as never);
        const tl = view.timeline!;
        const codes = new Set(view.deps.map((d) => d.code));
        expect(tl).toBeDefined();
        expect(tl).not.toBe(base);
        expect(view.timeline).toBe(tl); // cached
        expect(tl.totalTrains).toBe(view.deps.length);

        // animated trains are a subset of the filter, and each filtered
        // drawable train is drawn at some point
        const seen = new Set<string>();
        for (let t = 0; t <= tl.totalMins; t += 3)
          for (const a of tl.getActiveTrains(t)) {
            expect(codes.has(a.code)).toBe(true);
            seen.add(a.code);
          }
        const stray = o.deps.filter((d) => !codes.has(d.code) && tl.getPrepTrain(d.code));
        expect(stray.length).toBe(0);

        // final-step flows == filtered static flows
        const last = lastStep(tl);
        const flowN = new Map(view.flows.map((f) => [f.s, f.n]));
        for (const f of view.flows) expect(tl.secFlowSteps.get(f.s)?.[last] ?? 0).toBe(f.n);
        for (const [s, a] of tl.secFlowSteps) if (a[last] > 0) expect(flowN.has(s)).toBe(true);

        // counters count only the filtered trains; the bar keeps its span
        expect(tl.getDepartedCount(tl.totalMins)).toBe(view.deps.length);
        expect(tl.getArrivedCount(tl.totalMins)).toBe(view.deps.length);
        expect([tl.totalMins, tl.totalDays, tl.numSteps]).toEqual([base.totalMins, base.totalDays, base.numSteps]);
        expect(view.deps.length).toBeLessThan(o.deps.length);
        expect(view.deps.length).toBeGreaterThan(0);
      });
    }
  }
});
