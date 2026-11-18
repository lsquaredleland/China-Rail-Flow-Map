// lib/tooltip: the HTML must equal what the pre-extraction showTooltip built.
// tooltip.golden.json was captured once by running the original code from
// components/map/interaction.ts (as of the P1a.1 base) on these fixture hits.
import { expect, test } from "bun:test";
import { decodeSet, isFerrySection, mapStyle, modeOf, sectionInfo, tooltipHtml } from "../src/lib";
import type { AtlasData } from "../src/types";
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
      style: mapStyle("paper", modeOf(c.P.dark)),
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
  const base = { data: pack().atlas.data, cur: c.cur, direction: c.P.direction, distUnit: c.P.distUnit, panelDest: null, style: mapStyle("paper", "light"), ferry: false };
  const html = tooltipHtml(c.hit, { ...base, lines: [["京广高速线", "Beijing–Guangzhou HSR"], ["京广线", ""]] });
  expect(html).toContain("<div class='sc-line'><div class='sc-zh'>京广高速线</div><div class='sc-en'>Beijing–Guangzhou HSR</div></div>");
  expect(html).toContain("<div class='sc-line'><div class='sc-zh'>京广线</div></div>");
  expect(html).not.toContain("sc-foot");
  const fast = tooltipHtml(c.hit, { ...base, speed: 350 });
  expect(fast).toContain("<span class='tc-kicker'>Line speed limit</span><span class='sc-speed'><b>350</b> km/h</span>");
  expect(tooltipHtml(c.hit, { ...base, speed: 350, distUnit: "mi" })).toContain("<b>217</b> mph");
  expect(tooltipHtml(c.hit, base)).toBe(gold["seg 1"]);
});

test("sectionInfo reads l / the decoded speed by direction; national uses sections", () => {
  const data = {
    lines: [["甲线", "A Line"], ["乙线", ""]],
    sections: [{ g: "", l: [1, 0], v: 350 }],
    in_sections: [{ g: "", l: [0] }],
  } as unknown as AtlasData;
  const atlas = {
    data,
    sec: decodeSet([""], undefined, data.sections.map((s) => s.v)),
    inSec: decodeSet([""], undefined, data.in_sections.map((s) => s.v)),
  };
  expect(sectionInfo(atlas, { direction: "out" }, 0)).toEqual({ lines: [["乙线", ""], ["甲线", "A Line"]], speed: 350 });
  expect(sectionInfo(atlas, { direction: "in" }, 0)).toEqual({ lines: [["甲线", "A Line"]], speed: undefined });
  expect(sectionInfo(atlas, { direction: "in", national: true }, 0).speed).toBe(350);
  expect(sectionInfo({ ...atlas, data: { ...data, lines: undefined } as unknown as AtlasData }, { direction: "out" }, 0).lines).toEqual([]);
});

test("sectionInfo's speed equals the raw v of every section on the pack", () => {
  const atlas = pack().atlas;
  for (const [out, raw] of [[true, atlas.data.sections], [false, atlas.data.in_sections]] as const)
    for (let s = 0; s < raw.length; s++)
      expect(sectionInfo(atlas, { direction: out ? "out" : "in" }, s).speed).toBe(raw[s].v);
});

test("train tooltips show the leg average and the track limit when known", () => {
  const train = { code: "G1", cls: "G", fromStation: "北京南", toStation: "上海虹桥", depTime: "09:00", arrTime: "13:28", durMins: 268, progressPct: 40, lon: 0, lat: 0, heading: 0 };
  const base = { data: pack().atlas.data, cur: null as never, direction: "out" as const, distUnit: "km" as const, panelDest: null, style: mapStyle("paper", "light"), ferry: false };
  const html = tooltipHtml({ kind: "train", train: { ...train, legKmh: 295, trackKmh: 350 } }, base);
  expect(html).toContain("Speed (leg avg)</td><td style='text-align:right'>~295 km/h");
  expect(html).toContain("Track limit</td><td style='text-align:right'>350 km/h");
  const bare = tooltipHtml({ kind: "train", train }, base);
  expect(bare).not.toContain("leg avg");
  expect(bare).not.toContain("Track limit");
  expect(tooltipHtml({ kind: "train", train: { ...train, legKmh: 295 } }, { ...base, distUnit: "mi" })).toContain("~183 mph");
});

test("the city card's fastest time is the rust accent", () => {
  const c = cases().find((x) => x.name === "station out km")!;
  const html = tooltipHtml(c.hit, { data: pack().atlas.data, cur: c.cur, direction: "out", distUnit: "km", panelDest: null, style: mapStyle("paper", "light"), ferry: false });
  expect(html).toMatch(/<span>Fastest from Guangzhou<\/span><b class='cc-accent'><i class='cc-swatch'[^>]*><\/i>0:25<\/b>/);
  expect(html).toContain("<span>By rail</span><b>");
});
