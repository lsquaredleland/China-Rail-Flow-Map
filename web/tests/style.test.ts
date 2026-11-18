// lib/style: the paper skin reproduces the palette and the formerly inlined
// literals exactly, is memoised per (skin, mode), and its encodings equal the
// palette helpers they wrap.
import { describe, expect, test } from "bun:test";
import {
  LINE_COLOR,
  NODE_COLOR,
  NODE_SIZE,
  SKINS,
  flowColor,
  mapStyle,
  modeOf,
  natCityR,
  palette,
  paletteRGBA,
  rampColor,
  resolveMode,
  rgba,
  skinHasModeToggle,
  stationR,
} from "../src/lib";
import type { Mode } from "../src/lib";

const MODES: Mode[] = ["light", "dark"];

describe("mapStyle", () => {
  test("memoised: the same (skin, mode) returns the same object; modes differ", () => {
    expect(mapStyle("paper", "light")).toBe(mapStyle("paper", "light"));
    expect(mapStyle("paper", "dark")).toBe(mapStyle("paper", modeOf(true)));
    expect(mapStyle("paper", "light")).not.toBe(mapStyle("paper", "dark"));
    expect(mapStyle("paper", "dark").key).toBe("paper|dark");
    expect(Object.isFrozen(mapStyle("paper", "light").ink)).toBe(true);
  });

  for (const mode of MODES) {
    const dark = mode === "dark";
    const st = mapStyle("paper", mode);
    test(`paper ${mode}: pal and the palette inks equal palette() / paletteRGBA()`, () => {
      expect(st.pal).toEqual(palette(dark));
      const css = palette(dark) as unknown as Record<string, unknown>;
      const tuples = paletteRGBA(dark) as Record<string, number[]>;
      const inks = st.ink as unknown as Record<string, { css: string; rgba: number[] }>;
      for (const [k, v] of Object.entries(tuples)) {
        expect(inks[k].rgba).toEqual(v);
        if (k !== "ferry") expect(inks[k].css).toBe(css[k] as string);
      }
    });

    test(`paper ${mode}: the formerly inlined literals`, () => {
      const lit = (light: string, night: string) => (dark ? night : light);
      const i = st.ink;
      expect(i.ferryHi.css).toBe(lit("#0284C7", "#7DD3FC"));
      expect(i.ripple.css).toBe(lit("#D97706", "#F59E0B"));
      expect(i.ring.css).toBe(lit("#111111", "#EDEDEA"));
      expect(i.originFill.rgba).toEqual(dark ? [237, 237, 234, 255] : [17, 17, 17, 255]);
      expect(i.originEdge.rgba).toEqual(dark ? [26, 27, 30, 255] : [255, 255, 255, 255]);
      expect(i.labelBox.css).toBe(lit("#ffffff", "#1A1B1E"));
      expect(i.labelBoxText.css).toBe(lit("#111111", "#EDEDEA"));
      expect(i.trainHs.rgba).toEqual([245, 158, 11, 255]);
      expect(i.trainConv.rgba).toEqual([6, 182, 212, 255]);
      expect(i.trainOther.rgba).toEqual([226, 232, 240, 255]);
      expect(i.rushPeak.css).toBe(lit("#C8302A", "#E54035"));
      expect(st.marker.edgeWidth).toBe(dark ? 3 : 1.5);
      expect(st.alpha).toEqual(
        dark
          ? { context: 0.16, isoFlow: 0.06, isoChord: 0.05, isoInfra: 0.08, contextInfra: 0.18, natCityFill: 0.4 }
          : { context: 0.18, isoFlow: 0.08, isoChord: 0.08, isoInfra: 0.1, contextInfra: 0.2, natCityFill: 0.35 },
      );
      expect(st.line).toEqual({ capRounded: true, jointRounded: true });
    });
  }

  test("cardPal: at night the saffron band lifts to #F0B85A; by day it is the palette", () => {
    expect(mapStyle("paper", "light").cardPal).toBe(mapStyle("paper", "light").pal);
    const night = mapStyle("paper", "dark");
    expect(rampColor(480, night.cardPal)).toBe("rgb(240,184,90)");
    expect(rampColor(120, night.cardPal)).toBe(rampColor(120, night.pal));
    expect(rampColor(1080, night.cardPal)).toBe(rampColor(1080, night.pal));
  });
});

describe("skin modes", () => {
  test("paper supports both modes and keeps the requested one", () => {
    expect(SKINS.paper.modes).toEqual(["light", "dark"]);
    expect(resolveMode("paper", "dark")).toBe("dark");
    expect(resolveMode("paper", "light")).toBe("light");
    expect(skinHasModeToggle("paper")).toBe(true);
  });
});

describe("encodings", () => {
  const pal = palette(false);
  test("volume = flowColor; timeBand = rampColor or pal.dot; flat = pal.dot", () => {
    for (const [n, maxN] of [[1, 100], [37, 100], [100, 100], [5, 0]])
      expect(LINE_COLOR.volume.color({ n, maxN }, pal)).toBe(flowColor(n, maxN, pal));
    for (const m of [0, 200, 240, 600, 720, 1500]) expect(NODE_COLOR.timeBand.color(m, pal)).toBe(rampColor(m, pal));
    expect(NODE_COLOR.timeBand.color(undefined, pal)).toBe(pal.dot);
    expect(NODE_COLOR.flat.color(300, pal)).toBe(pal.dot);
    expect(rgba(NODE_COLOR.flat.color(undefined, pal))).toEqual(rgba(pal.dot));
  });

  test("directTrains = stationR; callsAtCity = natCityR", () => {
    for (const n of [0, 1, 10, 250, 3000]) {
      expect(NODE_SIZE.directTrains.radius(n)).toBe(stationR(n));
      expect(NODE_SIZE.callsAtCity.radius(n)).toBe(natCityR(n));
    }
  });
});
