// Deck flow layers: buildPassData / layer props, no GPU.
import { describe, expect, test } from "bun:test";
import { LINE_COLOR, boxSide, WIDTH_K, WIDTH_KNEE, speedBand, flowColor, flowUnits, flowPasses, getSelCache, isFerrySection, isTrainShown, mapStyle, newModelCaches, rgba, stationR, stationStates, stationZoomK } from "../src/lib";
import type { MapStyle, SelCache, SelInput } from "../src/lib";
import type { ModelState } from "../src/lib";
import { buildPassData, flowPassLayers } from "../src/components/map/deck/layers/flows";
import type { DestVM } from "../src/types";
import { stationDots, stationLayers, stationRipples, stationRings } from "../src/components/map/deck/layers/stations";
import { buildTrainBuffers, glowOf, shownTrains, tailLength, trainLayers } from "../src/components/map/deck/layers/trains";
import { BOX_DIST, BoxLayer, CIRCLE_DIST } from "../src/components/map/deck/BoxLayer";
import { ScatterplotLayer } from "@deck.gl/layers";
import { origin, pack } from "./fixture";

const cur = origin("广州");
const set = pack().atlas.sec;
const style = mapStyle("paper", "light");
const pal = style.pal;
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
  style,
  ...over,
});

describe("buildPassData", () => {
  const [pass] = flowPasses(st(), newModelCaches());
  const items = pass.items.filter((f) => !isFerrySection(set.bb, f.s));
  const pd = buildPassData(set, items, style, 1, pass.maxN);

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
    expect(buildPassData(set, items, style, 1, pass.maxN)).toBe(pd);
    // A different style is a different cache entry (the key is the style, not only paper + flow).
    expect(buildPassData(set, items, mapStyle("paper", "dark"), 1, pass.maxN)).not.toBe(pd);
  });

  test("by: count colours every path with flowColor of its count", () => {
    for (let p = 0; p < pd.data.length; p++)
      expect(Array.from(pd.rgba.subarray(p * 4, p * 4 + 4))).toEqual(rgba(flowColor(pd.n[p], pass.maxN, pal)));
  });

  test("by: section colours each path by its own section's speed band", () => {
    const ramp = { bands: ["#010101", "#020202", "#030303", "#040404", "#050505"], untagged: "#0F0F0F" };
    const speedStyle = { ...style, key: "test|speed", speedBands: ramp, enc: { ...style.enc, lineColor: LINE_COLOR.speedLimit } } as MapStyle;
    const sp = buildPassData(set, items, speedStyle, 1, pass.maxN);
    const seen = new Set<string>();
    for (let p = 0; p < sp.data.length; p++) {
      const b = speedBand(set.speed[sp.idxToSec[p]]);
      const want = rgba(b < 0 ? ramp.untagged : ramp.bands[b]);
      const got = Array.from(sp.rgba.subarray(p * 4, p * 4 + 4));
      expect(got).toEqual(want);
      seen.add(got.join());
    }
    expect(seen.size).toBeGreaterThan(2);
    expect(Array.from(sp.n)).toEqual(Array.from(pd.n)); // width still the count
  });

  test("n = 0 sections are absent", () => {
    const withZero = [{ s: items[0].s, n: 0 }, ...items.slice(0, 3)];
    expect(buildPassData(set, withZero, style, 1, pass.maxN).data.length).toBe(3);
  });

  test("colour follows the ramp; a faded pass is pre-blended opaque (D3)", () => {
    const c = rgba(flowColor(pd.n[0], pass.maxN, pal));
    expect(Array.from(pd.rgba.subarray(0, 4))).toEqual(Array.from(c));
    const faded = buildPassData(set, items, style, 0.18, pass.maxN);
    const paper = rgba(pal.paper);
    for (let i = 0; i < 3; i++) expect(faded.rgba[i]).toBe(Math.round(c[i] * 0.18 + paper[i] * 0.82));
    expect(faded.rgba[3]).toBe(255);
  });

  test("flowUnits: linear to the knee, then √-compressed, continuous and increasing", () => {
    expect(flowUnits(10)).toBe(10);
    expect(flowUnits(WIDTH_KNEE)).toBe(WIDTH_KNEE);
    expect(flowUnits(WIDTH_KNEE + 1e-6)).toBeCloseTo(WIDTH_KNEE, 4);
    expect(flowUnits(100)).toBeCloseTo(86.49, 2);
    expect(flowUnits(360)).toBeLessThan(205);
    for (let n = 1; n < 600; n++) expect(flowUnits(n + 1)).toBeGreaterThan(flowUnits(n));
  });

  test("layer width = flowUnits(n) * WIDTH_K / fitScale, ids per role, pickable only for focus", () => {
    const passes = flowPasses(st({ panelDest: dest }), newModelCaches());
    expect(passes.map((p) => p.role)).toEqual(["context", "focus"]);
    const layers = flowPassLayers(set, passes, style, 100, 12.5);
    const flows = layers.filter((l) => l.id.startsWith("flows-") && !l.id.endsWith("-ferry"));
    expect(flows.map((l) => l.id)).toEqual(["flows-context", "flows-focus"]);
    // Drawn flows are never picked (their width is the train count); the hairline proxy of the focus pass is.
    expect(flows.map((l) => l.props.pickable)).toEqual([false, false]);
    const proxies = layers.filter((l) => l.id.startsWith("pick-"));
    expect(proxies.map((l) => l.id)).toEqual(["pick-flows-focus"]);
    expect(proxies[0].props.pickable).toBe(true);
    expect((proxies[0].props as any).idxToSec).toBe(buildPassData(set, passes[1].items, style, 1, passes[1].maxN).idxToSec);
    const l: any = flows[1];
    const pdf = buildPassData(set, passes[1].items, style, 1, passes[1].maxN);
    expect(l.props.getWidth(undefined, { index: 0 })).toBeCloseTo((flowUnits(pdf.n[0]) * WIDTH_K) / 12.5, 9);
    expect(l.props.data).toBe(pdf.data);
  });

  test("glow (terminal): one underlay per full-opacity pass, under every pass; paper has none", () => {
    const passes = flowPasses(st({ panelDest: dest }), newModelCaches());
    expect(flowPassLayers(set, passes, style, 100, 12.5).some((l) => l.id.startsWith("flows-glow-"))).toBe(false);
    const term = mapStyle("terminal", "dark");
    const glow = term.glow!;
    const layers = flowPassLayers(set, passes, term, 100, 12.5);
    const ids = layers.map((l) => l.id);
    // the faded context pass keeps flat pre-blended colours: only the focus pass glows
    expect(ids.filter((i) => i.startsWith("flows-glow-"))).toEqual(["flows-glow-focus"]);
    expect(ids.indexOf("flows-glow-focus")).toBeLessThan(ids.indexOf("flows-context"));
    const g: any = layers[ids.indexOf("flows-glow-focus")];
    const f: any = layers[ids.indexOf("flows-focus")];
    // the glow draws exactly what the (chained) flow layer draws, flat and mitred
    expect(g.props.data).toBe(f.props.data);
    expect(g.props.capRounded).toBe(false);
    expect(g.props.jointRounded).toBe(false);
    expect(g.props.pickable).toBe(false);
    expect(g.props.widthMinPixels).toBe(glow.minPixels);
    const w0 = f.props.getWidth(undefined, { index: 0 });
    expect(g.props.getWidth(undefined, { index: 0 })).toBeCloseTo(w0 * glow.widthScale, 9);
    const fc = f.props.getColor(undefined, { index: 0 });
    const c = g.props.getColor(undefined, { index: 0 });
    expect(Array.from(c.slice(0, 3))).toEqual(Array.from(fc.slice(0, 3)));
    expect(c[3]).toBe(Math.round(fc[3] * glow.alpha));
  });

  test("chained flows (terminal): same-colour, same-width sections joined, ends cut square", () => {
    const passes = flowPasses(st({ panelDest: dest }), newModelCaches());
    const term = mapStyle("terminal", "dark");
    const pdf = buildPassData(set, passes[1].items, term, 1, passes[1].maxN);
    const f: any = flowPassLayers(set, passes, term, 100, 12.5).find((l) => l.id === "flows-focus");
    const d = f.props.data;
    expect(f.props.capRounded).toBe(false);
    expect(f.props.jointRounded).toBe(false);
    // picking and recounts keep one path per section
    expect(d).not.toBe(pdf.data);
    expect(d.length).toBeGreaterThan(0);
    expect(d.length).toBeLessThanOrEqual(pdf.data.length);
    // every chain keeps one count and colour, taken from a section of the pass
    const counts = new Set(Array.from(pdf.n));
    for (let i = 0; i < d.length; i++) {
      const w = f.props.getWidth(undefined, { index: i }) * 12.5 / WIDTH_K;
      expect([...counts].some((n) => Math.abs(flowUnits(n) - w) < 1e-6)).toBe(true);
    }
    // vertices: each chain has its sections' vertices minus the shared joints
    const pv = pdf.data.attributes.getPath.value.length / 2;
    const dv = d.attributes.getPath.value.length / 2;
    expect(dv).toBeLessThanOrEqual(pv);
    // paper stays one path per section
    const paper: any = flowPassLayers(set, passes, style, 100, 12.5).find((l) => l.id === "flows-focus");
    expect(paper.props.data).toBe(buildPassData(set, passes[1].items, style, 1, passes[1].maxN).data);
  });
});

describe("station layers", () => {
  const stIn = (animTime: number, pd: DestVM | null) => ({
    points: cur.dests, panelDest: pd, hoverIdx: -1, style, animEnabled: true,
    animTime, totalMins: cur.timeline?.totalMins, sk: 0.5,
  });
  const memo = { selCache: null as SelCache | null };

  test("animating: a city is drawn only once a shown train has stopped there", () => {
    const at0 = stationStates(stIn(0, null), null);
    expect(at0.every((s) => !s.lit)).toBe(true);
    expect(stationDots(at0, style, false).length).toBe(0);
    const noon = stationStates(stIn(720, null), null);
    const litNoon = noon.filter((s) => s.lit).length;
    expect(litNoon).toBeGreaterThan(0);
    expect(litNoon).toBeLessThan(noon.length);
    expect(stationDots(noon, style, false).length).toBe(litNoon);
    // monotone over the day, and every city lit at the end
    expect(stationStates(stIn(1080, null), null).filter((s) => s.lit).length).toBeGreaterThanOrEqual(litNoon);
    expect(stationStates(stIn(cur.timeline!.totalMins, null), null).every((s) => s.lit)).toBe(true);
    // the selected destination is always drawn
    const pd = cur.dests[5];
    expect(stationStates(stIn(0, pd), null).find((s) => s.idx === pd.idx)!.lit).toBe(true);
    // not animating: everything drawn
    expect(stationStates({ ...stIn(0, null), animEnabled: false }, null).every((s) => s.lit)).toBe(true);
  });

  test("dot radius = stationR(n) * stationZoomK(r, t); stroke 1.5 light / 3 dark", () => {
    const states = stationStates({ ...stIn(0, null), animEnabled: false }, null);
    const dots = stationDots(states, style, false);
    expect(dots.length).toBe(cur.dests.length);
    for (let i = 0; i < dots.length; i += 37) {
      const r = stationR(cur.dests[i].trains);
      expect(dots[i].r).toBeCloseTo(r * stationZoomK(r, 0.5), 9);
      expect(dots[i].lw).toBe(1.5);
    }
    expect(stationDots(states, mapStyle("paper", "dark"), false)[0].lw).toBe(3);
  });

  test("ripple spreads from the current circle by max(3, 0.8r), alpha 1 - frac; dimmed dots paint first", () => {
    let found = false;
    for (let t = 300; t < 1400 && !found; t += 5) {
      const states = stationStates(stIn(t, null), null);
      const rp = stationRipples(states, style);
      const withR = states.filter((s) => s.ripple);
      expect(rp.length).toBe(withR.length);
      for (let k = 0; k < rp.length; k++) {
        const s = withR[k], f = s.ripple!.frac;
        const r = s.r0 * s.kd; // the circle as drawn now, not its full-day size
        expect(rp[k].r).toBeCloseTo(r + f * Math.max(3, 0.8 * r), 9);
        expect(rp[k].col[3]).toBe(Math.round(255 * Math.max(0, 1 - f)));
        found = true;
      }
    }
    expect(found).toBe(true);
    const pd = dest;
    const states = stationStates({ ...stIn(0, pd), animEnabled: false }, null);
    const dots = stationDots(states, style, true);
    const firstFull = dots.findIndex((d) => d.fill[3] === 255);
    expect(dots.slice(0, firstFull).every((d) => d.fill[3] < 255)).toBe(true);
    expect(dots.slice(firstFull).every((d) => d.fill[3] === 255)).toBe(true);
    const rings = stationRings({ panelDest: pd, hoverStation: null, hoverOrigin: true, originPt: [0, 0], sk: 0.5, style });
    expect(rings.map((r) => r.w)).toEqual([3, 2]);
    expect(rings[1].r).toBe(14.5);
  });

  test("layer ids and origin disc", () => {
    const states = stationStates({ ...stIn(0, null), animEnabled: false }, null);
    const ls = stationLayers({ states, style, hasDest: false, originPt: [1, 2], panelDest: null, hoverStation: null, hoverOrigin: false, sk: 0.5, key: "k", posKey: "p" });
    expect(ls.map((l) => l.id)).toEqual(["stations", "ripples", "origin", "rings"]);
    expect(ls[2].props.getRadius).toBe(9);
    // paper draws discs: the plain ScatterplotLayer, never the box subclass
    for (const l of ls) expect(l).not.toBeInstanceOf(BoxLayer);
  });

  test("marker.minRadius leaves small markers out (terminal); 0 keeps every lit city (paper)", () => {
    const states = stationStates({ ...stIn(0, null), animEnabled: false }, null);
    const all = stationDots(states, style, false);
    const rs = all.map((d) => d.r).sort((x, y) => x - y);
    const min = rs[Math.floor(rs.length / 2)];
    const small = { ...style, key: "test|min", marker: { ...style.marker, minRadius: min } } as MapStyle;
    const kept = stationDots(states, small, false);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(all.length);
    for (const d of kept) expect(d.r).toBeGreaterThanOrEqual(min);
    expect(all.filter((d) => d.r >= min).length).toBe(kept.length);
  });

  test("box marker: squares of the circle's area, rings keep their px gap", () => {
    const box = { ...style, key: "test|box", marker: { ...style.marker, shape: "box" } } as MapStyle;
    const states = stationStates({ ...stIn(0, null), animEnabled: false }, null);
    const ls = stationLayers({ states, style: box, hasDest: false, originPt: [1, 2], originPlaces: [[1, 2]], panelDest: dest, hoverStation: null, hoverOrigin: false, sk: 0.5, closeup: null, key: "k", posKey: "p" });
    expect(ls.map((l) => l.id)).toEqual(["stations", "ripples", "origin", "rings"]);
    for (const l of ls) expect(l).toBeInstanceOf(BoxLayer);
    const dots = stationDots(states, box, false);
    const getR = ls[0].props.getRadius as (d: unknown) => number;
    for (let i = 0; i < dots.length; i += 37) {
      const half = getR(dots[i]);
      expect(half).toBeCloseTo((dots[i].r * Math.sqrt(Math.PI)) / 2, 9);
      expect((2 * half) ** 2).toBeCloseTo(Math.PI * dots[i].r ** 2, 6); // same area as the disc
    }
    expect(ls[2].props.getRadius).toBeCloseTo((9 * Math.sqrt(Math.PI)) / 2, 9);
    const rings = stationRings({ panelDest: dest, hoverStation: null, hoverOrigin: false, originPt: [0, 0], sk: 0.5, style: box });
    const g = stationR(dest.trains) * stationZoomK(stationR(dest.trains), 0.5);
    expect(rings[0].r).toBeCloseTo(boxSide(g) / 2 + 3.8, 9);
  });

  test("BoxLayer swaps the fragment shader's circle distance for the square one", () => {
    const l = new BoxLayer({ id: "b", data: [] });
    (l as unknown as { context: unknown }).context = { defaultShaderModules: [], device: { type: "webgl" } };
    const fs = l.getShaders().fs;
    expect(fs).not.toContain(CIRCLE_DIST);
    expect(fs).toContain("float distToCenter = " + BOX_DIST);
    const circle = new ScatterplotLayer({ id: "c", data: [] });
    (circle as unknown as { context: unknown }).context = { defaultShaderModules: [], device: { type: "webgl" } };
    expect(circle.getShaders().fs).toContain("float distToCenter = " + CIRCLE_DIST);
  });
});

describe("train layers", () => {
  test("glowOf follows the style: paper's classes are the same in both modes; terminal's trains are cyan", () => {
    for (const c of ["G", "K", "", "D", "Z"]) expect(glowOf(c, mapStyle("paper", "dark"))).toEqual(glowOf(c));
    for (const c of ["G", "K", ""]) expect(glowOf(c, mapStyle("terminal", "dark"))).toEqual([63, 230, 255, 255]);
  });

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
      trainLayers({ trains: act, scale: 100, isolatedCode: iso, selectedCode: null, hoveredCode: null, animTime: 600 });
    const dot = mk(null).find((l) => l.id === "trains")!;
    expect(dot.props.getRadius).toBe(3);
    expect(dot.props.getLineWidth).toBe(2);
    expect((dot.props.getRadius as number) + (dot.props.getLineWidth as number) / 2).toBe(4);
    const isoDot = mk(act[0].code).find((l) => l.id === "trains")!;
    expect(isoDot.props.getRadius).toBe(4.15);
    expect(isoDot.props.getLineWidth).toBe(2.7);
    expect(mk(null).map((l) => l.id)).toEqual(["tails", "trains", "dwell", "trainring"]);
    // Trains are picked on the CPU: no picking proxy, nothing pickable.
    expect(dot.props.pickable).toBe(false);
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
