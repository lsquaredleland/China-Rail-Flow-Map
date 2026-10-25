// Deck flow layers: buildPassData / layer props, no GPU.
import { describe, expect, test } from "bun:test";
import { WIDTH_K, flowColor, flowPasses, isFerrySection, newModelCaches, palette, rgba } from "../src/lib";
import type { ModelState } from "../src/lib";
import { buildPassData, flowPassLayers } from "../src/components/map/deck/layers/flows";
import type { DestVM } from "../src/types";
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
    expect(flows.map((l) => l.props.pickable)).toEqual([false, true]);
    const l: any = flows[1];
    const pdf = buildPassData(set, passes[1].items, pal, 1, passes[1].maxN);
    expect(l.props.getWidth(undefined, { index: 0 })).toBeCloseTo((pdf.n[0] * WIDTH_K) / 12.5, 9);
    expect(l.props.data).toBe(pdf.data);
  });
});
