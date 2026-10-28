// lib/tooltip: the HTML must equal what the pre-extraction showTooltip built.
// tooltip.golden.json was captured once by running the original code from
// components/map/interaction.ts (as of the P1a.1 base) on these fixture hits.
import { expect, test } from "bun:test";
import { isFerrySection, sectionLines, tooltipHtml } from "../src/lib";
import golden from "./tooltip.golden.json";
import { pack } from "./fixture";
import { cases } from "./tooltipCases";

const gold = golden as Record<string, string>;

for (const c of cases()) {
  test(`tooltip: ${c.name}`, () => {
    const ferry = c.hit.kind === "seg" && !!c.set && isFerrySection(c.set.bb, c.hit.s);
    const html = tooltipHtml(c.hit, {
      data: pack().atlas.data,
      cur: c.cur,
      direction: c.P.direction,
      distUnit: c.P.distUnit,
      panelDest: c.P.panelDest,
      dark: c.P.dark,
      ferry,
    });
    expect(html).toBe(gold[c.name]);
  });
}

test("ferry hits carry the ferry line, others do not", () => {
  const f = cases().filter((c) => c.name.startsWith("seg ferry"));
  expect(f.length).toBe(2);
  for (const c of f) expect(gold[c.name]).toContain("粤海铁路轮渡");
  expect(gold["seg 1"]).not.toContain("粤海铁路轮渡");
});

test("seg tooltips list the section's OSM line names", () => {
  const c = cases().find((x) => x.name === "seg 1")!;
  const base = { data: pack().atlas.data, cur: c.cur, direction: c.P.direction, distUnit: c.P.distUnit, panelDest: null, dark: false, ferry: false };
  const html = tooltipHtml(c.hit, { ...base, lines: [["京广高速线", "Beijing–Guangzhou HSR"], ["京广线", ""]] });
  expect(html).toContain("<div class='t-sub'>京广高速线 &middot; Beijing–Guangzhou HSR</div>");
  expect(html).toContain("<div class='t-sub'>京广线</div>");
  expect(tooltipHtml(c.hit, base)).toBe(gold["seg 1"]);
});

test("sectionLines reads l by direction; national uses sections", () => {
  const data = {
    lines: [["甲线", "A Line"], ["乙线", ""]],
    sections: [{ g: "", l: [1, 0] }],
    in_sections: [{ g: "", l: [0] }],
  } as never;
  expect(sectionLines(data, { direction: "out" }, 0)).toEqual([["乙线", ""], ["甲线", "A Line"]]);
  expect(sectionLines(data, { direction: "in" }, 0)).toEqual([["甲线", "A Line"]]);
  expect(sectionLines(data, { direction: "in", national: true }, 0)).toEqual([["乙线", ""], ["甲线", "A Line"]]);
  expect(sectionLines({ ...(data as object), lines: undefined } as never, { direction: "out" }, 0)).toEqual([]);
});
