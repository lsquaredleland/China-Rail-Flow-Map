// mapModel (flows / chords / infra / isolation): the pure decisions both
// renderers consume, on real origins.
import { describe, expect, test } from "bun:test";
import {
  chordPlan,
  chordVisible,
  filterOriginByClasses,
  flowPasses,
  getDestSectionCounts,
  infraPasses,
  isolatedCorridor,
  newModelCaches,
  pickableFlows,
} from "../src/lib";
import type { ModelState } from "../src/lib";
import type { DestVM } from "../src/types";
import { origin } from "./fixture";

const cur = origin("广州");
const dest = cur.dests.find((d) => d.zh === "长沙") as DestVM;
const tl = cur.timeline!;

const st = (over: Partial<ModelState> = {}): ModelState => ({
  cur,
  baseCur: cur,
  dir: "out",
  animTime: 360,
  animEnabled: false,
  showInfra: false,
  panelDest: null,
  iso: null,
  dark: false,
  ...over,
});
const trainsAt = (t: any, m: number) => t.getActiveTrains(m);

describe("flowPasses", () => {
  test("(a) no selection, not animated: one pass at alpha 1", () => {
    const p = flowPasses(st(), newModelCaches());
    expect(p.length).toBe(1);
    expect(p[0].alpha).toBe(1);
    expect(p[0].items).toBe(cur.flows);
    expect(p[0].maxN).toBe(Math.max(1, cur.maxFlow));
  });

  test("(b) selected city: context 0.16/0.18 + focus equals dest section counts", () => {
    const caches = newModelCaches();
    for (const dark of [false, true]) {
      const p = flowPasses(st({ panelDest: dest as any, dark }), caches);
      expect(p.map((x) => x.role)).toEqual(["context", "focus"]);
      expect(p[0].alpha).toBe(dark ? 0.16 : 0.18);
      expect(p[1].alpha).toBe(1);
      const counts = getDestSectionCounts(st({ panelDest: dest as any }), caches)!;
      const want = cur.flows
        .map((f) => ({ s: f.s, n: Math.min(f.n, counts.get(f.s) || 0) }))
        .filter((f) => f.n > 0);
      expect(p[1].items.length).toBe(want.length);
      const got = new Map(p[1].items.map((f) => [f.s, f.n]));
      for (const f of want) expect(got.get(f.s)).toBe(f.n);
    }
  });

  test("(c) filtered view: context = baseFlows 0.16/0.18, focus = filtered", () => {
    const filtered = filterOriginByClasses(cur, ["G"]);
    const s = st({ cur: filtered, baseCur: cur });
    const p = flowPasses(s, newModelCaches());
    expect(p.length).toBe(2);
    expect(p[0].items).toBe(cur.flows);
    expect(p[0].alpha).toBe(0.18);
    expect(p[1].items).toBe(filtered.flows);
    expect(p[1].maxN).toBe(Math.max(1, cur.maxFlow));
  });

  test("(d) isolated: context 0.06/0.08 + corridor", () => {
    const code = cur.deps[0].code;
    const s = st({ iso: code });
    const p = flowPasses(s, newModelCaches());
    expect(p.length).toBe(1);
    expect(p[0].alpha).toBe(0.08);
    expect(flowPasses(st({ iso: code, dark: true }), newModelCaches())[0].alpha).toBe(0.06);
    const c = isolatedCorridor(s, trainsAt)!;
    expect(c).toBeTruthy();
    const pt = tl.getPrepTrain(code)!;
    expect(c.secs.map((x) => x.s)).toEqual(pt.secs);
  });

  test("(e) animated at step k: items equal secFlowSteps[s][k]", () => {
    for (const t of [400, 700, 1000]) {
      const k = Math.min(tl.numSteps - 1, Math.floor(t / tl.stepMins));
      const p = flowPasses(st({ animEnabled: true, animTime: t }), newModelCaches());
      expect(p.length).toBe(1);
      const want = cur.flows.filter((f) => (tl.secFlowSteps.get(f.s)?.[k] ?? 0) > 0);
      expect(p[0].items.length).toBe(want.length);
      for (const it of p[0].items) expect(it.n).toBe(tl.secFlowSteps.get(it.s)![k]);
      expect(p[0].maxN).toBe(Math.max(1, tl.maxFlowSteps[k] || cur.maxFlow));
    }
  });

  test("(g) at animTime >= totalMins equals the static flows", () => {
    const p = flowPasses(st({ animEnabled: true, animTime: tl.totalMins }), newModelCaches());
    expect(p[0].items).toBe(cur.flows);
  });
});

describe("chords", () => {
  test("(f) visible only after the first departure", () => {
    const caches = newModelCaches();
    // Synthetic chords towards the first few terminus indices (the model
    // only reads `b`), plus one nobody departs to.
    const tcs = [...new Set(cur.deps.map((d) => d.tcIdx))].slice(0, 5);
    const co = {
      ...cur,
      chords: [...tcs, -1].map((b) => ({ a: 0, b, n: 1, flat: [], count: 0, bb: {} }) as any),
    } as typeof cur;
    const plan = chordPlan(st({ cur: co, baseCur: co, animEnabled: true, animTime: 0 }), caches)!;
    expect(plan.gated).toBe(true);
    let checked = 0;
    for (const ch of co.chords) {
      const cur = co;
      const first = Math.min(...cur.deps.filter((d) => d.tcIdx === ch.b).map((d) => d.depMins));
      if (!Number.isFinite(first)) {
        expect(chordVisible(plan, ch, 1e6)).toBe(false);
        continue;
      }
      expect(chordVisible(plan, ch, first - 1)).toBe(false);
      expect(chordVisible(plan, ch, first)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("not animated: never gated", () => {
    const plan = chordPlan(st(), newModelCaches())!;
    expect(plan.gated).toBe(false);
    expect(plan.alpha).toBe(1);
  });
});

describe("infra and picking", () => {
  test("infra: plain = all flows; selected = faded rest + connected", () => {
    const caches = newModelCaches();
    expect(infraPasses(st(), caches)).toEqual([{ alpha: 1, sections: cur.flows }]);
    const s = st({ panelDest: dest as any });
    const p = infraPasses(s, caches);
    const counts = getDestSectionCounts(s, caches)!;
    expect(p.map((x) => x.alpha)).toEqual([0.2, 1]);
    expect(p[1].sections.every((f) => counts.has(f.s))).toBe(true);
    expect(p[0].sections.length + p[1].sections.length).toBe(cur.flows.length);
  });

  test("pickable flows: dest pair only; animated only occupied sections", () => {
    const caches = newModelCaches();
    const s = st({ panelDest: dest as any });
    const counts = getDestSectionCounts(s, caches)!;
    const pf = pickableFlows(s, caches);
    expect(pf.every((f) => (counts.get(f.s) ?? 0) > 0)).toBe(true);
    const k = Math.floor(700 / tl.stepMins);
    const anim = pickableFlows(st({ animEnabled: true, animTime: 700 }), caches);
    expect(anim.every((f) => (tl.secFlowSteps.get(f.s)?.[k] ?? 0) > 0)).toBe(true);
    expect(pickableFlows(st(), caches).length).toBe(cur.flows.length);
  });
});
