/* National flows (B, P3.2; A+B, P3.3): the flow layers, the hovered section's
   highlight and the infrastructure overlay. Memo keys: see ./index.ts. */
import type { Layer } from "@deck.gl/core";
import { PathLayer } from "@deck.gl/layers";
import type { DecodedAtlas, NationalEntriesPack, NationalFlowsPack } from "../../../../../types";
import { NAT_WIDTH_FACTOR, flowWidth, nationalCountsAt, nationalFlowPasses, palette, rgba } from "../../../../../lib";
import type { InfraPass } from "../../../../../lib";
import type { PassData } from "../flows";
import { buildPassData, infraLayers, passDataLayers, recountPassData, wholePath } from "../flows";
import type { NatView } from "./timeline";

/* ---------- national flows (B, P3.2; A+B, P3.3) ---------- */

interface NationalFlowsInput {
  atlas: DecodedAtlas;
  nf: NationalFlowsPack;
  /** The entry ticks; with `minute` the flows are the trains entered by then (A+B). */
  ne: NationalEntriesPack | null;
  /** Minute of the day on the entry-tick grid, 0..1440 (A+B), or null for the day's totals (B). */
  minute: number | null;
  /** The class filter (the entry ticks are per class) and the resolved filter view. */
  classes: readonly string[];
  view: NatView;
  dark: boolean;
  scale: number;
  fitScale: number;
  /** 1 = full; an isolated train fades the flows (isoFlowAlpha), as in the origin view. */
  alpha?: number;
}

interface NationalFlows {
  layers: Layer[];
  /** Sections drawn (count > 0). */
  sections: number;
  /** Trains per section as drawn (the day's totals, or entered by the clock's minute). */
  counts: Uint32Array | number[];
  /** ms of this call's count update (B pass build or A+B recount); 0 when cached. */
  updateMs: number;
}

/* B's pass per (file, class filter, theme). Its paint order (widest first by
   the day's counts) is also A+B's, so A+B keeps the geometry and recounts. */
let dayMemo: { nf: NationalFlowsPack; cls: string; dark: boolean; alpha: number; pd: PassData; maxN: number; sections: number } | null = null;
let atMemo: { day: PassData; ne: NationalEntriesPack; minute: number; pd: PassData; sections: number; counts: Uint32Array } | null = null;

/** The national flow layers (under the dots): B draws the day's totals; A+B
    the same paths with each section's trains entered by `minute`, recounted
    only when the minute, class filter, theme or file changes. */
export function nationalFlowLayers(inp: NationalFlowsInput): NationalFlows {
  const { atlas, nf, ne, minute, classes, view, dark, scale, fitScale, alpha = 1 } = inp;
  const pal = palette(dark);
  const cls = view.key;
  let updateMs = 0;
  if (!dayMemo || dayMemo.nf !== nf || dayMemo.cls !== cls || dayMemo.dark !== dark || dayMemo.alpha !== alpha) {
    const t0 = performance.now();
    const pass = nationalFlowPasses(view.counts)[0];
    const pd = buildPassData(atlas.sec, pass.items, pal, alpha, pass.maxN);
    dayMemo = { nf, cls, dark, alpha, pd, maxN: pass.maxN, sections: pass.items.length };
    updateMs = performance.now() - t0;
  }
  const day = dayMemo;
  let pd = day.pd;
  let sections = day.sections;
  let drawnCounts: Uint32Array | number[] = view.counts;
  if (minute !== null && ne) {
    if (!atMemo || atMemo.day !== day.pd || atMemo.ne !== ne || atMemo.minute !== minute) {
      const t0 = performance.now();
      const counts = nationalCountsAt(ne, classes, minute);
      let drawn = 0;
      for (let s = 0; s < counts.length; s++) if (counts[s] > 0) drawn++;
      atMemo = { day: day.pd, ne, minute, pd: recountPassData(day.pd, counts, pal, day.maxN, alpha), sections: drawn, counts };
      updateMs = performance.now() - t0;
    }
    pd = atMemo.pd;
    sections = atMemo.sections;
    drawnCounts = atMemo.counts;
  }
  // Width = flowUnits(n) * WIDTH_K / fitScale, so the national factor rides on fitScale.
  return { layers: passDataLayers("national", pd, alpha, alpha >= 1, pal, dark, scale, fitScale / NAT_WIDTH_FACTOR), sections, counts: drawnCounts, updateMs };
}

/** The hovered section's highlight, as the origin view draws it: the whole
    section a little wider than its flow. */
export function nationalHighlight(atlas: DecodedAtlas, s: number, n: number, scale: number, fitScale: number, dark: boolean): Layer[] {
  const hw = Math.max(0.5, flowWidth(n, scale, fitScale) * NAT_WIDTH_FACTOR) + 1.6;
  return [
    new PathLayer<number[]>({
      id: "nat-seg-highlight",
      data: [wholePath(atlas.sec, s, false)],
      getPath: (d: number[]) => d,
      positionFormat: "XY",
      widthUnits: "pixels",
      getWidth: hw,
      getColor: rgba(palette(dark).flowHi),
      capRounded: true,
      jointRounded: true,
      updateTriggers: { getWidth: hw },
    } as object),
  ];
}

/** The infrastructure overlay for the sections the national flows draw
    (those with trains under the filters), memoised per counts array and alpha. */
const infraMemo = new WeakMap<object, Map<number, InfraPass[]>>();
export function nationalInfraLayers(atlas: DecodedAtlas, counts: ArrayLike<number>, dark: boolean, alpha = 1): Layer[] {
  let byAlpha = infraMemo.get(counts);
  if (!byAlpha) infraMemo.set(counts, (byAlpha = new Map()));
  let passes = byAlpha.get(alpha);
  if (!passes) {
    const sections: { s: number }[] = [];
    for (let s = 0; s < counts.length; s++) if (counts[s] > 0) sections.push({ s });
    passes = [{ alpha, sections: sections as InfraPass["sections"] }];
    byAlpha.set(alpha, passes);
  }
  return infraLayers(atlas.sec, passes, palette(dark), dark);
}
