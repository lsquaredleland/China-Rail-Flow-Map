/* National flows (B, P3.2): per-section train counts from
   atlas-v2-national.json under the class filter, their widths on the
   origin flows' scale, and the flow pass the deck flows layer consumes
   (the same FlowPass shape as mapModel.flowPasses, so the binary PathLayer
   path is reused). Pure; the layer itself is P3.2's. */
import type { NationalFlowsPack } from "../types";
import { requireFmt } from "./decode";
import type { FlowItem, FlowPass } from "./mapModel";
import { classIndex } from "./origin";
import { flowWidth } from "./palette";

/** Throw a FmtError unless `d` is a national file for a shared pack with
    `nSections` sections: same `fmt`, and every array section-parallel. */
export function requireNationalFlows(d: NationalFlowsPack, nSections: number, url: string): void {
  requireFmt(d.fmt, url);
  const ok =
    Array.isArray(d.total) &&
    d.total.length === nSections &&
    Array.isArray(d.by_class) &&
    d.by_class.length === 8 &&
    d.by_class.every((c) => Array.isArray(c) && c.length === nSections);
  if (ok) return;
  const msg = `${url}: national flows do not match the shared sections (${nSections}); rebuild the data pack`;
  console.error(msg);
  const err = new Error(msg);
  err.name = "FmtError";
  throw err;
}

/** Trains/day per section under the class filter (`classes` as the origin
    view's: train-class letters plus "plain"; empty = all classes, which is
    `total`). Otherwise the sum of the selected `by_class` rows. */
export function nationalCounts(nf: NationalFlowsPack, classes: readonly string[]): Uint32Array {
  if (!classes.length) return Uint32Array.from(nf.total);
  const out = new Uint32Array(nf.total.length);
  for (const ci of new Set(classes.map(classIndex))) {
    const row = nf.by_class[ci];
    for (let s = 0; s < out.length; s++) out[s] += row[s];
  }
  return out;
}

/** Stroke width (CSS px) per section, on the origin flows' scale. */
export function nationalWidths(counts: Uint32Array, scale: number, fitScale: number): Float32Array {
  const w = new Float32Array(counts.length);
  for (let s = 0; s < counts.length; s++) w[s] = flowWidth(counts[s], scale, fitScale);
  return w;
}

/** The national flow pass: sections with n > 0, widest first (ties by
    section id), one pass at alpha 1, the colour ramp normalised to the
    widest section. */
export function nationalFlowPasses(counts: Uint32Array): FlowPass[] {
  const items: FlowItem[] = [];
  let maxN = 0;
  for (let s = 0; s < counts.length; s++) {
    const n = counts[s];
    if (n > 0) items.push({ s, n });
    if (n > maxN) maxN = n;
  }
  items.sort((a, b) => b.n - a.n); // stable: equal n keep section order
  return [{ role: "all", items, alpha: 1, maxN: Math.max(1, maxN), pickable: true }];
}
