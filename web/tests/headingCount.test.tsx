// The departures heading's big number follows the train-class filter, in all
// four modes, and equals the class-filtered row count and the station-line sum.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { inArrivalsMode } from "../src/components/departures/inArrivals";
import { inCallsMode } from "../src/components/departures/inCalls";
import { outCallsMode } from "../src/components/departures/outCalls";
import { outDeparturesMode } from "../src/components/departures/outDepartures";
import type { DepCtx, ModeView } from "../src/components/departures/types";
import { origin, pack } from "./fixture";

const sum = (s: { n: number }[] | null) => s!.reduce((a, x) => a + x.n, 0);
const text = (v: ModeView) =>
  renderToStaticMarkup(<h2>{v.heading}</h2>).replace(/<[^>]+>/g, "");
const lead = (v: ModeView) =>
  /dep-num-lead">(\d+)</.exec(renderToStaticMarkup(<h2>{v.heading}</h2>))![1];

const sortState = { key: "dep", dir: 1 } as any;
const ctxFor = (selectedClasses: string[], extra: Partial<DepCtx> = {}): DepCtx =>
  ({
    unit: "km",
    q: "",
    hasExtraFilters: false,
    matchesRowFilters: () => true,
    selectedClasses,
    selectedTrainCodes: [],
    handleRowClick: () => {},
    handleClearChip: () => {},
    emptyProps: {} as any,
    sort: sortState,
    setSort: () => {},
    callSort: { key: "arr", dir: 1 },
    setCallSort: () => {},
    arrSort: sortState,
    setArrSort: () => {},
    inCallSort: { key: "arr", dir: 1 },
    setInCallSort: () => {},
    ...extra,
  }) as DepCtx;

// Inbound rows are hand-made: the fixture loads only the outbound pack.
const arrs = ["G", "G", "D", "D", "D", "K"].map((cls, i) => ({
  cls,
  code: cls + i,
  tsZh: i % 2 ? "甲" : "乙",
  tsEn: i % 2 ? "A" : "B",
  hay: "",
  dep: "08:00",
  arr: "09:00",
  dur: 60,
  distKm: 100,
}));
const inCalls = ["G", "D", "D", "K"].map((cls, i) => ({
  arr: { cls, code: cls + i, hay: "", arr: "09:00" },
  bsZh: i % 2 ? "甲" : "乙",
  bsEn: i % 2 ? "A" : "B",
  started: i < 2,
  dur: 60,
}));
const fakeCur = { en: "Town", o: { zh: "镇" }, arrs } as any;

describe("heading count follows the class filter", () => {
  const o = origin("广州");
  const withD = o.deps.filter((d) => d.cls === "D").length;

  test("outbound departures", () => {
    for (const cls of [[], ["D"], ["G", "D"]]) {
      const v = outDeparturesMode(ctxFor(cls, { cur: o }));
      const rows = cls.length ? o.deps.filter((d) => cls.includes(d.cls)) : o.deps;
      expect(v.count).toBe(rows.length);
      expect(sum(v.stations)).toBe(v.count);
      expect(lead(v)).toBe(String(v.count));
      expect(v.total).toBe(o.deps.length);
    }
    expect(withD).toBeGreaterThan(0);
    expect(withD).toBeLessThan(o.deps.length);
  });

  test("outbound heading wording: unchanged with All, tagged and 'of N' with a filter", () => {
    const all = text(outDeparturesMode(ctxFor([], { cur: o })));
    expect(all).toBe(`Departures from ${o.en} · ${o.o.zh} ${o.deps.length}`);
    const d = text(outDeparturesMode(ctxFor(["D"], { cur: o })));
    expect(d).toBe(`D departures from ${o.en} · ${o.o.zh} ${withD} of ${o.deps.length}`);
  });

  test("outbound trains call at a destination", () => {
    const { atlas } = pack();
    const dest = o.dests.find((x) => x.calls.some((c) => c.dep.cls === "D") &&
      x.calls.some((c) => c.dep.cls !== "D"))!;
    for (const cls of [[], ["D"], ["G", "D"]]) {
      const v = outCallsMode(ctxFor(cls, { atlas }), o, dest);
      const rows = cls.length ? dest.calls.filter((c) => cls.includes(c.dep.cls)) : dest.calls;
      expect(v.count).toBe(rows.length);
      expect(sum(v.stations)).toBe(v.count);
      expect(lead(v)).toBe(String(v.count));
      expect(v.total).toBe(dest.calls.length);
      const t = text(v);
      expect(t.includes(" of " + dest.calls.length)).toBe(cls.length > 0);
      // terminate-here count follows the filter too
      const term = rows.filter((c) => c.term).length;
      expect(t).toContain(term > 0 ? term + " terminate here" : "none terminate here");
    }
    expect(text(outCallsMode(ctxFor(["D"], { atlas }), o, dest))).toContain(
      " D trains call at " + dest.en,
    );
  });

  test("inbound arrivals", () => {
    for (const cls of [[], ["D"], ["G", "K"]]) {
      const v = inArrivalsMode(ctxFor(cls), fakeCur);
      const rows = cls.length ? arrs.filter((a) => cls.includes(a.cls)) : arrs;
      expect(v.count).toBe(rows.length);
      expect(sum(v.stations)).toBe(v.count);
      expect(lead(v)).toBe(String(v.count));
      expect(v.total).toBe(arrs.length);
    }
    expect(text(inArrivalsMode(ctxFor([]), fakeCur))).toBe(`Arrivals into Town · 镇 — 6 arrivals`);
    expect(text(inArrivalsMode(ctxFor(["D"]), fakeCur))).toBe(
      `D arrivals into Town · 镇 — 3 arrivals of 6`,
    );
  });

  test("inbound trains arrive from a source", () => {
    const src = { en: "Src", zh: "源", inCalls, trains: 4, originating: 2 } as any;
    for (const cls of [[], ["D"], ["G", "K"]]) {
      const v = inCallsMode(ctxFor(cls), fakeCur, src);
      const rows = cls.length ? inCalls.filter((c) => cls.includes(c.arr.cls)) : inCalls;
      expect(v.count).toBe(rows.length);
      expect(sum(v.stations)).toBe(v.count);
      expect(lead(v)).toBe(String(v.count));
      expect(v.total).toBe(4);
    }
    const t = text(inCallsMode(ctxFor(["D"]), fakeCur, src));
    expect(t).toContain("2 D trains arrive from Src · 源 of 4");
    expect(t).toContain("1 start there");
  });
});
