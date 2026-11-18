// Legend from encodings: paper keeps the volume ramp and circle samples; a
// speedLimit / box skin (terminal) shows the speed-band key and box samples.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Legend from "../src/components/Legend";
import { SPEED_BANDS, mapStyle } from "../src/lib";

const markup = (style?: Parameters<typeof mapStyle>[0]) =>
  renderToStaticMarkup(<Legend title="t" style={style ? mapStyle(style, "dark") : undefined} />);

describe("Legend", () => {
  test("paper: circle samples, the speed key hidden, no box samples", () => {
    for (const h of [markup(), markup("paper")]) {
      expect(h).toContain("Circle size = direct trains/day");
      expect(h).toContain('class="lg-dot"');
      expect(h).not.toContain("Box size");
      // the speed key is in the DOM but hidden until draw() asks for it
      expect(h).toMatch(/<g style="display:none"><text[^>]*>Section speed limit · km\/h/);
    }
  });

  test("terminal: the speed bands with the skin's colours, box samples", () => {
    const h = markup("terminal");
    const t = mapStyle("terminal", "dark");
    expect(h).toContain("Section speed limit · km/h");
    for (const b of SPEED_BANDS) expect(h).toContain(">" + b.label.replace("<", "&lt;") + "<");
    expect(h).toContain(">untagged<");
    for (const c of [...t.speedBands.bands, t.speedBands.untagged]) expect(h).toContain('fill="' + c + '"');
    expect(h).toContain("Box size = direct trains/day");
    expect(h).not.toContain('class="lg-dot"');
    expect(h).toContain('stroke="#8DA2CC"');
    // the trains key wears the skin's class colours
    expect(h).toContain('fill="#3FE6FF"');
  });
});
