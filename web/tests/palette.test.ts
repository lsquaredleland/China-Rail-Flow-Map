// lib/palette: the RGBA tuples the WebGL layers use equal the CSS strings the
// Canvas renderer uses, parsed independently here.
import { expect, test } from "bun:test";
import { palette, paletteRGBA, rgba } from "../src/lib";

/** Independent parse: canvas-style CSS colour -> [r, g, b, round(255a)]. */
function parse(css: string): number[] {
  if (css.startsWith("#")) {
    const h = css.length === 4 ? [...css.slice(1)].map((c) => c + c).join("") : css.slice(1);
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)).concat(255);
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(css);
  if (!m) throw new Error("unparsed " + css);
  return [+m[1], +m[2], +m[3], Math.round(255 * (m[4] === undefined ? 1 : +m[4]))];
}

for (const dark of [false, true]) {
  test(`paletteRGBA(${dark}) equals the parsed CSS palette`, () => {
    const css = palette(dark) as unknown as Record<string, unknown>;
    const out = paletteRGBA(dark) as Record<string, number[]>;
    for (const [k, v] of Object.entries(out)) {
      if (k === "ferry") continue;
      expect(typeof css[k]).toBe("string");
      expect(v).toEqual(parse(css[k] as string));
    }
    expect(out.ferry).toEqual(parse(dark ? "#38BDF8" : "#0284C7"));
  });
}

test("rgba handles short hex, rgb(), rgba() and the alpha multiplier; results are cached", () => {
  expect(rgba("#abc")).toEqual([170, 187, 204, 255]);
  expect(rgba("rgb(200,48,42)")).toEqual([200, 48, 42, 255]);
  expect(rgba("rgba(46,48,53,0.5)")).toEqual([46, 48, 53, 128]);
  expect(rgba("#111111", 0.18)).toEqual([17, 17, 17, 46]);
  expect(rgba("#111111", 0.18)).toBe(rgba("#111111", 0.18));
  expect(() => rgba("blue")).toThrow();
});
