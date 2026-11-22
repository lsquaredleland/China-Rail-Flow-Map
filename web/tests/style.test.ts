// lib/style: the paper skin reproduces the palette and the formerly inlined
// literals exactly, is memoised per (skin, mode), and its encodings equal the
// palette helpers they wrap.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  LINE_COLOR,
  NODE_COLOR,
  NODE_SIZE,
  SKINS,
  SPEED_BANDS,
  boxSide,
  flowColor,
  legendTitle,
  mapStyle,
  modeOf,
  natCityR,
  parseSkin,
  palette,
  paletteRGBA,
  rampColor,
  resolveMode,
  rgba,
  skinHasModeToggle,
  speedBand,
  stationR,
} from "../src/lib";
import type { Mode, SkinId } from "../src/lib";

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

describe("terminal skin", () => {
  const t = mapStyle("terminal", "dark");
  test("dark only: light resolves to dark, no day/night toggle, one memoised style", () => {
    expect(SKINS.terminal.modes).toEqual(["dark"]);
    expect(SKINS.terminal.defaultMode).toBe("dark");
    expect(resolveMode("terminal", "light")).toBe("dark");
    expect(skinHasModeToggle("terminal")).toBe(false);
    expect(mapStyle("terminal", "light")).toBe(t);
    expect(t.key).toBe("terminal|dark");
    expect(t.mode).toBe("dark");
  });

  test("encodings and shapes: speedLimit lines, flat box cities, chained angular flows", () => {
    expect(t.enc.lineColor).toBe(LINE_COLOR.speedLimit);
    expect(t.enc.nodeColor).toBe(NODE_COLOR.flat);
    expect(t.enc.nodeSize).toBe(NODE_SIZE.stationRadius);
    expect(t.enc.natNodeSize).toBe(NODE_SIZE.natCityRadius);
    expect(t.marker.shape).toBe("box");
    expect(t.line).toEqual({ capRounded: false, jointRounded: false });
    expect(t.flowJoin).toBe("chain");
    expect(mapStyle("paper", "light").flowJoin).toBe("section");
    expect(t.font.family).toBe("'CRT Face', 'Share Tech Mono', 'Noto Sans SC', ui-monospace, monospace");
    // canvas labels in capitals, once the web face is loaded
    expect(t.font.caps).toBe(true);
    expect(t.font.load).toEqual(["16px 'Share Tech Mono'", "16px 'CRT Face'"]);
    expect(t.glow).toEqual({ widthScale: 1.3, minPixels: 3, alpha: 0.12 });
    expect(t.marker).toEqual({ shape: "box", edgeWidth: 1, minRadius: 5 });
  });

  test("the TSpeed colours", () => {
    expect(t.speedBands).toEqual({ bands: ["#F4FFE8", "#FFD43B", "#FF3D8B", "#7A5CFF"], untagged: "#3A4A6E" });
    expect(t.ink.paper.css).toBe("#04060C");
    expect(t.ink.label.css).toBe("#FF8F40");
    // boxes: a dark well under a soft edge, apart from the amber 200-249 band
    expect(t.ink.dotEdge.css).toBe("#8DA2CC");
    expect(t.ink.dot.rgba).toEqual([4, 6, 12, 128]);
    expect(t.speedBands.bands).not.toContain(t.ink.dotEdge.css);
    expect(t.ink.rushPeak.css).toBe("#FFC21A");
    expect(t.ink.originFill.css).toBe("#EAF2FF");
    for (const k of ["trainHs", "trainConv", "trainOther"] as const) expect(t.ink[k].css).toBe("#3FE6FF");
    // the national boxes take the fill's own alpha
    expect(t.alpha.natCityFill).toBe(1);
    // ink and pal agree where both exist
    expect(t.ink.landFill.css).toBe(t.pal.landFill);
    expect(t.ink.outline.css).toBe(t.pal.outline);
  });

  test("paper is untouched by the second skin", () => {
    expect(mapStyle("paper", "light").enc.lineColor).toBe(LINE_COLOR.volume);
    expect(mapStyle("paper", "dark").marker.shape).toBe("circle");
    expect(mapStyle("paper", "light").pal).toEqual(palette(false));
    for (const m of ["light", "dark"] as const) {
      const p = mapStyle("paper", m);
      expect(p.glow).toBeNull();
      expect(p.marker.minRadius).toBe(0);
      expect(p.font.caps).toBe(false);
      expect(p.font.load).toEqual([]);
    }
  });
});

describe("legendTitle", () => {
  const paper = mapStyle("paper", "light");
  const term = mapStyle("terminal", "dark");
  test("paper keeps the view's captions", () => {
    expect(legendTitle(paper, { national: false, direction: "out", cityEn: "Beijing" })).toBe("Fastest time from origin");
    expect(legendTitle(paper, { national: false, direction: "in", cityEn: "Beijing" })).toBe("Fastest time to Beijing");
    expect(legendTitle(paper, { national: false, direction: "in", cityEn: null })).toBe("Fastest time to destination");
    expect(legendTitle(paper, { national: true, direction: "out", cityEn: null })).toBe("All trains of China Rail");
  });
  test("a line colour with its own title names the card in every view", () => {
    for (const national of [false, true])
      for (const direction of ["out", "in"] as const)
        expect(legendTitle(term, { national, direction, cityEn: "Beijing" })).toBe("Section speed limit");
    expect(LINE_COLOR.speedLimit.title).toBe("Section speed limit");
    expect(LINE_COLOR.volume.title).toBeUndefined();
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

describe("skin selection", () => {
  test("parseSkin: registered ids as is; unknown, empty and null are paper", () => {
    for (const id of Object.keys(SKINS)) expect(parseSkin(id)).toBe(id as SkinId);
    for (const s of ["", null, undefined, "Paper", "neon", "toString", "__proto__"]) expect(parseSkin(s)).toBe("paper");
  });

  /* The pre-paint script in index.template.html, run on a fake window: it must
     pick the same skin and mode as useUrlState + resolveMode. */
  const html = readFileSync(new URL("../index.template.html", import.meta.url), "utf8");
  const body = /<script>\s*([\s\S]*?)<\/script>/.exec(html)![1];
  const prePaint = (search: string, store: Record<string, string>, prefersDark: boolean) => {
    const attrs: Record<string, string> = {};
    const win = { location: { search }, matchMedia: () => ({ matches: prefersDark }) };
    const doc = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
    const ss = { getItem: (k: string) => (k in store ? store[k] : null) };
    new Function("window", "document", "sessionStorage", body)(win, doc, ss);
    return attrs;
  };
  const expected = (search: string, store: Record<string, string>, prefersDark: boolean) => {
    const q = new URLSearchParams(search);
    const sk = q.get("skin");
    const skin = parseSkin(sk === null ? store["crfa-skin"] : sk);
    const p = q.get("theme");
    const s = store["crfa-theme"];
    const dark = p === "dark" || p === "night" ? true : p === "light" || p === "day" ? false : s === "dark" ? true : s === "light" ? false : prefersDark;
    return { "data-skin": skin, "data-theme": resolveMode(skin, modeOf(dark)) };
  };
  const searches = ["", "?skin=paper", "?skin=bogus", "?theme=light", "?theme=night&skin=paper", ...Object.keys(SKINS).map((k) => "?theme=light&skin=" + k)];
  const stores: Record<string, string>[] = [{}, { "crfa-theme": "dark" }, ...Object.keys(SKINS).map((k) => ({ "crfa-skin": k, "crfa-theme": "light" })), { "crfa-skin": "bogus" }];
  for (const search of searches)
    for (const store of stores)
      for (const pd of [false, true])
        test(`pre-paint script ${search || "(none)"} ${JSON.stringify(store)} prefersDark=${pd}`, () => {
          expect(prePaint(search, store, pd)).toEqual(expected(search, store, pd));
        });

  test("pre-paint script does not throw without storage or matchMedia", () => {
    const attrs: Record<string, string> = {};
    const doc = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
    new Function("window", "document", "sessionStorage", body)({ location: { search: "?skin=paper" } }, doc, undefined);
    expect(attrs).toEqual({ "data-skin": "paper", "data-theme": "light" });
  });
});

describe("encodings", () => {
  const pal = palette(false);
  const st = mapStyle("paper", "light");
  test("volume = flowColor; timeBand = rampColor or pal.dot; flat = pal.dot", () => {
    expect(LINE_COLOR.volume.by).toBe("count");
    for (const [n, maxN] of [[1, 100], [37, 100], [100, 100], [5, 0]])
      for (const [s, speed] of [[-1, 0], [3, 350]])
        expect(LINE_COLOR.volume.color({ n, maxN, s, speed }, st)).toBe(flowColor(n, maxN, pal));
    for (const m of [0, 200, 240, 600, 720, 1500]) expect(NODE_COLOR.timeBand.color(m, pal)).toBe(rampColor(m, pal));
    expect(NODE_COLOR.timeBand.color(undefined, pal)).toBe(pal.dot);
    expect(NODE_COLOR.flat.color(300, pal)).toBe(pal.dot);
    expect(rgba(NODE_COLOR.flat.color(undefined, pal))).toEqual(rgba(pal.dot));
  });

  test("stationRadius = stationR; natCityRadius = natCityR", () => {
    for (const n of [0, 1, 10, 250, 3000]) {
      expect(NODE_SIZE.stationRadius.radius(n)).toBe(stationR(n));
      expect(NODE_SIZE.natCityRadius.radius(n)).toBe(natCityR(n));
    }
  });

  test("speedBand: boundaries at 120 / 200 / 300; 0 is untagged", () => {
    const cases: [number, number][] = [
      [0, -1], [1, 3], [119, 3], [120, 2], [199, 2], [200, 1], [249, 1], [250, 1], [299, 1], [300, 0], [350, 0], [450, 0],
    ];
    for (const [v, b] of cases) expect(speedBand(v)).toBe(b);
    expect(SPEED_BANDS.map((b) => b.label)).toEqual(["300+", "200–299", "120–199", "<120"]);
  });

  test("speedLimit: the skin's band colour by the section's speed, untagged colour at 0", () => {
    const ramp = { bands: ["#000001", "#000002", "#000003", "#000004"], untagged: "#00000F" };
    const style = { pal, speedBands: ramp };
    const c = (speed: number) => LINE_COLOR.speedLimit.color({ n: 10, maxN: 100, s: 0, speed }, style);
    expect(LINE_COLOR.speedLimit.by).toBe("section");
    expect([300, 299, 250, 249, 200, 199, 120, 119, 1, 0].map(c)).toEqual([
      "#000001", "#000002", "#000002", "#000002", "#000002", "#000003", "#000003", "#000004", "#000004", "#00000F",
    ]);
    // the count never matters
    expect(LINE_COLOR.speedLimit.color({ n: 99, maxN: 1, s: 7, speed: 310 }, style)).toBe("#000001");
  });

  test("boxSide: a square of the circle's area (side = r * sqrt(pi))", () => {
    for (const r of [0, 1.5, 2, 7.3, 26]) {
      expect(boxSide(r)).toBeCloseTo(r * Math.sqrt(Math.PI), 12);
      expect(boxSide(r) ** 2).toBeCloseTo(Math.PI * r * r, 9);
    }
  });
});
