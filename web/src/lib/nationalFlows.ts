/* National flows (B, P3.2): per-section train counts from
   atlas-v2-national.json under the class filter, their widths on the
   origin flows' scale, and the flow pass the deck flows layer consumes
   (the same FlowPass shape as mapModel.flowPasses, so the binary PathLayer
   path is reused). A+B (P3.3): the same counts up to a minute of the day,
   from atlas-v2-national-entries.json by binary search and sums only (R3).
   Pure; the layer is deck/layers/national.ts. */
import type { NationalEntriesPack, NationalFlowsPack } from "../types";
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

/** Throw a FmtError unless `d` is a national entries file for a shared pack
    with `nSections` sections: same `fmt`, `n_sec`, 8 class rows of
    `nSections` tick lists each, a positive tick rate. */
export function requireNationalEntries(d: NationalEntriesPack, nSections: number, url: string): void {
  requireFmt(d.fmt, url);
  const ok =
    d.n_sec === nSections &&
    d.ticks_per_min > 0 &&
    Array.isArray(d.by_class) &&
    d.by_class.length === 8 &&
    d.by_class.every((c) => Array.isArray(c) && c.length === nSections);
  if (ok) return;
  const msg = `${url}: national entries do not match the shared sections (${nSections}); rebuild the data pack`;
  console.error(msg);
  const err = new Error(msg);
  err.name = "FmtError";
  throw err;
}

/** Number of values <= x in the ascending array `a`. */
function upperBound(a: readonly number[], x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Trains per section that have entered it by `minute` of the day (D7:
    cumulative since 00:00), under the class filter (`classes` as
    nationalCounts; empty = all). Σ over the selected classes of the entry
    ticks <= minute x ticks_per_min. Monotone in `minute`; at 1440 it equals
    nationalCounts on the matching flows file. */
export function nationalCountsAt(ne: NationalEntriesPack, classes: readonly string[], minute: number): Uint32Array {
  const out = new Uint32Array(ne.n_sec);
  const x = minute * ne.ticks_per_min;
  const cis = classes.length ? new Set(classes.map(classIndex)) : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const ci of cis) {
    const row = ne.by_class[ci];
    for (let s = 0; s < out.length; s++) {
      const a = row[s];
      if (a.length) out[s] += upperBound(a, x);
    }
  }
  return out;
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
