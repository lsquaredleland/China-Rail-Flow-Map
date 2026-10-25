// Deck flow layers: buildPassData / layer props, no GPU.
import { describe, expect, test } from "bun:test";
import { WIDTH_K, flowColor, flowPasses, getSelCache, isFerrySection, isTrainShown, newModelCaches, palette, rgba, stationR, stationStates, stationZoomK } from "../src/lib";
import type { SelCache, SelInput } from "../src/lib";
import type { ModelState } from "../src/lib";
import { buildPassData, flowPassLayers } from "../src/components/map/deck/layers/flows";
import type { DestVM } from "../src/types";
import { stationDots, stationLayers, stationRipples, stationRings } from "../src/components/map/deck/layers/stations";
import { buildTrainBuffers, glowOf, shownTrains, tailLength, trainLayers } from "../src/components/map/deck/layers/trains";
import { origin, pack } from "./fixture";

const cur = origin("广州");
const set = pack().atlas.sec;
const pal = palette(false);
const dest = cur.dests.find((d) => d.zh === "长沙") as DestVM;
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

describe("buildPassData", () => {
  const [pass] = flowPasses(st(), newModelCaches());
  const items = pass.items.filter((f) => !isFerrySection(set.bb, f.s));
  const pd = buildPassData(set, items, pal, 1, pass.maxN);

  test("one path per item with n > 0, in items order", () => {
    const pos = items.filter((f) => f.n > 0);
    expect(pd.data.length).toBe(pos.length);
    for (let k = 0; k < pos.length; k++) {
      expect(pd.idxToSec[k]).toBe(pos[k].s);
      expect(pd.n[k]).toBe(pos[k].n);
    }
  });

  test("startIndices are monotone and match section lengths", () => {
    const { startIndices, length } = pd.data;
    for (let k = 0; k + 1 < length; k++) {
      expect(startIndices[k + 1] - startIndices[k]).toBe(set.len[pd.idxToSec[k]]);
    }
    const last = pd.idxToSec[length - 1];
    expect(pd.data.attributes.getPath.value.length / 2 - startIndices[length - 1]).toBe(set.len[last]);
  });

  test("geometry equals the section geometry in items order", () => {
    const v = pd.data.attributes.getPath.value;
    for (const k of [0, 1, Math.floor(pd.data.length / 2), pd.data.length - 1]) {
      const s = pd.idxToSec[k];
      const a = Array.from(v.subarray(pd.data.startIndices[k] * 2, (pd.data.startIndices[k] + set.len[s]) * 2));
      expect(a).toEqual(Array.from(set.pts.subarray(set.off[s], set.off[s] + set.len[s] * 2)));
    }
  });

  test("same items identity returns the same object", () => {
    expect(buildPassData(set, items, pal, 1, pass.maxN)).toBe(pd);
  });

  test("n = 0 sections are absent", () => {
    const withZero = [{ s: items[0].s, n: 0 }, ...items.slice(0, 3)];
    expect(buildPassData(set, withZero, pal, 1, pass.maxN).data.length).toBe(3);
  });

  test("colour follows the ramp; a faded pass is pre-blended opaque (D3)", () => {
    const c = rgba(flowColor(pd.n[0], pass.maxN, pal));
    expect(Array.from(pd.rgba.subarray(0, 4))).toEqual(Array.from(c));
    const faded = buildPassData(set, items, pal, 0.18, pass.maxN);
    const paper = rgba(pal.paper);
    for (let i = 0; i < 3; i++) expect(faded.rgba[i]).toBe(Math.round(c[i] * 0.18 + paper[i] * 0.82));
    expect(faded.rgba[3]).toBe(255);
  });

  test("layer width = n * WIDTH_K / fitScale, ids per role, pickable only for focus", () => {
    const passes = flowPasses(st({ panelDest: dest }), newModelCaches());
    expect(passes.map((p) => p.role)).toEqual(["context", "focus"]);
    const layers = flowPassLayers(set, passes, pal, false, 100, 12.5);
    const flows = layers.filter((l) => l.id.startsWith("flows-") && !l.id.endsWith("-ferry"));
    expect(flows.map((l) => l.id)).toEqual(["flows-context", "flows-focus"]);
    // Drawn flows are never picked (their width is the train count); the hairline proxy of the focus pass is.
    expect(flows.map((l) => l.props.pickable)).toEqual([false, false]);
    const proxies = layers.filter((l) => l.id.startsWith("pick-"));
    expect(proxies.map((l) => l.id)).toEqual(["pick-flows-focus"]);
    expect(proxies[0].props.pickable).toBe(true);
    expect((proxies[0].props as any).idxToSec).toBe(buildPassData(set, passes[1].items, pal, 1, passes[1].maxN).idxToSec);
    const l: any = flows[1];
    const pdf = buildPassData(set, passes[1].items, pal, 1, passes[1].maxN);
    expect(l.props.getWidth(undefined, { index: 0 })).toBeCloseTo((pdf.n[0] * WIDTH_K) / 12.5, 9);
    expect(l.props.data).toBe(pdf.data);
  });
});

describe("station layers", () => {
  const stIn = (animTime: number, pd: DestVM | null) => ({
    points: cur.dests, panelDest: pd, hoverIdx: -1, dark: false, animEnabled: true,
    animTime, totalMins: cur.timeline?.totalMins, sk: 0.5,
  });
  const memo = { selCache: null as SelCache | null };

  test("dot radius = stationR(n) * stationZoomK(r, t); stroke 1.5 light / 3 dark", () => {
    const states = stationStates({ ...stIn(0, null), animEnabled: false }, null);
    const dots = stationDots(states, pal, false, false);
    expect(dots.length).toBe(cur.dests.length);
    for (let i = 0; i < dots.length; i += 37) {
      const r = stationR(cur.dests[i].trains);
      expect(dots[i].r).toBeCloseTo(r * stationZoomK(r, 0.5), 9);
      expect(dots[i].lw).toBe(1.5);
    }
    expect(stationDots(states, palette(true), true, false)[0].lw).toBe(3);
  });

  test("ripple radius r + frac*7*kd, alpha 1 - frac; dimmed dots paint first", () => {
    let found = false;
    for (let t = 300; t < 1400 && !found; t += 5) {
      const states = stationStates(stIn(t, null), null);
      const rp = stationRipples(states, false);
      const withR = states.filter((s) => s.ripple);
      expect(rp.length).toBe(withR.length);
      for (let k = 0; k < rp.length; k++) {
        const s = withR[k], f = s.ripple!.frac;
        expect(rp[k].r).toBeCloseTo(s.r0 * s.kd + f * 7 * s.kd, 9);
        expect(rp[k].col[3]).toBe(Math.round(255 * Math.max(0, 1 - f)));
        found = true;
      }
    }
    expect(found).toBe(true);
    const pd = dest;
    const states = stationStates({ ...stIn(0, pd), animEnabled: false }, null);
    const dots = stationDots(states, pal, false, true);
    const firstFull = dots.findIndex((d) => d.fill[3] === 255);
    expect(dots.slice(0, firstFull).every((d) => d.fill[3] < 255)).toBe(true);
    expect(dots.slice(firstFull).every((d) => d.fill[3] === 255)).toBe(true);
    const rings = stationRings({ panelDest: pd, hoverStation: null, hoverOrigin: true, originPt: [0, 0], sk: 0.5, dark: false });
    expect(rings.map((r) => r.w)).toEqual([3, 2]);
    expect(rings[1].r).toBe(14.5);
  });

  test("layer ids and origin disc", () => {
    const states = stationStates({ ...stIn(0, null), animEnabled: false }, null);
    const ls = stationLayers({ states, pal, dark: false, hasDest: false, originPt: [1, 2], panelDest: null, hoverStation: null, hoverOrigin: false, sk: 0.5, key: "k", posKey: "p" });
    expect(ls.map((l) => l.id)).toEqual(["stations", "ripples", "origin", "rings"]);
    expect(ls[2].props.getRadius).toBe(9);
  });
});

describe("train layers", () => {
  const tl = cur.timeline!;
  const pd = dest;
  const sel: SelInput = { cur, panelDest: pd, isolatedTrainCode: null, direction: "out" };
  const memo = { selCache: null as SelCache | null };

  test("dots exclude trains with isTrainShown === false; none beyond the destination window", () => {
    const cache = getSelCache(sel, memo)!;
    const maxArr = Math.max(...[...cache.win!.values()].map((w) => w.arrMins));
    for (const t of [400, 600, 900, 1200]) {
      const act = tl.getActiveTrains(t);
      const shown = shownTrains(act, (c) => isTrainShown(sel, memo, t, c), null);
      expect(shown.length).toBeLessThanOrEqual(act.length);
      expect(shown.every((x) => isTrainShown(sel, memo, t, x.code))).toBe(true);
      expect(shown.length).toBe(act.filter((x) => isTrainShown(sel, memo, t, x.code)).length);
      if (t > maxArr) expect(shown.length).toBe(0);
    }
    const act = tl.getActiveTrains(600);
    expect(shownTrains(act, () => true, act[0].code).map((x) => x.code)).toEqual([act[0].code]);
  });

  test("train dot getRadius 3 + ring width 2 (outer edge 4 px); isolated 4.15 / 2.7", () => {
    const act = tl.getActiveTrains(600).slice(0, 20);
    const mk = (iso: string | null) =>
      trainLayers({ trains: act, scale: 100, isolatedCode: iso, selectedCode: null, hoveredCode: null, pickable: false, animTime: 600 });
    const dot = mk(null).find((l) => l.id === "trains")!;
    expect(dot.props.getRadius).toBe(3);
    expect(dot.props.getLineWidth).toBe(2);
    expect((dot.props.getRadius as number) + (dot.props.getLineWidth as number) / 2).toBe(4);
    const isoDot = mk(act[0].code).find((l) => l.id === "trains")!;
    expect(isoDot.props.getRadius).toBe(4.15);
    expect(isoDot.props.getLineWidth).toBe(2.7);
    expect(mk(null).map((l) => l.id)).toEqual(["tails", "trains", "pick-trains", "dwell", "trainring"]);
    // Picking: the drawn dots never are; the 1 px proxy is, while paused, and maps index -> train through `shown`.
    const px = (pickable: boolean) =>
      trainLayers({ trains: act, scale: 100, isolatedCode: null, selectedCode: null, hoveredCode: null, pickable, animTime: 600 });
    expect(dot.props.pickable).toBe(false);
    expect(px(true).find((l) => l.id === "pick-trains")!.props.pickable).toBe(true);
    expect(px(false).find((l) => l.id === "pick-trains")!.props.pickable).toBe(false);
    expect((px(true).find((l) => l.id === "pick-trains")!.props as any).shown).toBe(act);
  });

  test("tails: 12 px x speedFrac (22 isolated), none dwelling / on chord; source = pos - heading*len/scale", () => {
    const act = tl.getActiveTrains(600).filter((x) => !x.isDwelling && !x.onChord && (x.speedFrac ?? 1) > 0.5).slice(0, 10);
    const b = buildTrainBuffers(act, 50, null, null, null);
    expect(b.count).toBe(act.length);
    expect(b.tailCount).toBe(act.length);
    for (let i = 0; i < act.length; i++) {
      const len = tailLength(act[i], false);
      expect(len).toBe(Math.round(12 * (act[i].speedFrac ?? 1)));
      expect(b.tailTgt[i * 2]).toBeCloseTo(act[i].lon, 4);
      expect(b.tailSrc[i * 2]).toBeCloseTo(act[i].lon - (Math.cos(act[i].heading) * len) / 50, 4);
      expect(b.tailSrc[i * 2 + 1]).toBeCloseTo(act[i].lat - (Math.sin(act[i].heading) * len) / 50, 4);
      expect(Array.from(b.line.subarray(i * 4, i * 4 + 3))).toEqual(glowOf(act[i].cls).slice(0, 3));
    }
    expect(tailLength({ ...act[0], isDwelling: true } as any, false)).toBe(0);
    expect(tailLength({ ...act[0], onChord: true } as any, false)).toBe(0);
    expect(tailLength({ ...act[0], speedFrac: 1 } as any, true)).toBe(22);
  });
});
