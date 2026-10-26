/* National filters: the class filter plus the hour / distance / duration /
   train-code filters, applied to every national train by lookup in the
   per-train index (atlas-v2-national-index.json), and the sums over the
   selected trains (flows per section, departures / arrivals per city, the
   histograms' bins). No domain logic: the pipeline wrote the bins and the
   section / city rows; this selects trains and adds their rows up.
   With no index filter active the precomputed class totals are used. */
import type {
  DistBinFilter,
  DistUnit,
  DurBinFilter,
  NationalFlowsPack,
  NationalIndexPack,
  RawTrain,
} from "../types";
import { requireFmt } from "./decode";
import { classIndex } from "./origin";
import { nationalCityCounts, nationalCounts } from "./nationalFlows";

export interface NatFilter {
  classes: readonly string[];
  hours: readonly number[];
  distBins: readonly DistBinFilter[];
  durBins: readonly DurBinFilter[];
  trainCodes: readonly string[];
  unit: DistUnit;
}

/** Histogram bin counts of the index: hours, distance (km / mi), duration (h). */
export const NAT_HOUR_BINS = 24;
export const NAT_DIST_BINS = { km: 31, mi: 41 } as const;
export const NAT_DIST_SIZE = { km: 100, mi: 50 } as const;
export const NAT_DUR_BINS = 25;

/** Throw a FmtError unless `d` is a national index for a shared pack with
    `nSec` sections and `nTrain` train_table rows. */
export function requireNationalIndex(d: NationalIndexPack, nSec: number, nTrain: number, url: string): void {
  requireFmt(d.fmt, url);
  const ok =
    d.n_sec === nSec &&
    d.n_train === nTrain &&
    [d.hour, d.dist_km, d.dist_mi, d.dur, d.secs, d.dep, d.arr].every((a) => Array.isArray(a) && a.length === nTrain);
  if (ok) return;
  const msg = `${url}: national index does not match the shared pack (${nSec} sections, ${nTrain} trains); rebuild the data pack`;
  console.error(msg);
  const err = new Error(msg);
  err.name = "FmtError";
  throw err;
}

/** Any filter the index answers (everything but the class filter). */
export function natIndexActive(f: NatFilter): boolean {
  return f.hours.length > 0 || f.distBins.length > 0 || f.durBins.length > 0 || f.trainCodes.length > 0;
}

export function natFilterKey(f: NatFilter): string {
  return [
    [...new Set(f.classes)].sort().join(","),
    [...f.hours].sort((a, b) => a - b).join(","),
    f.distBins.map((b) => b.bin).sort((a, b) => a - b).join(","),
    f.durBins.map((b) => b.bin).sort((a, b) => a - b).join(","),
    [...f.trainCodes].sort().join(","),
    f.unit,
  ].join("|");
}

/* Delta-coded rows decoded once per index. */
interface Decoded {
  secs: Int32Array[];
  dep: Int32Array[];
  arr: Int32Array[];
}
const decodedMemo = new WeakMap<NationalIndexPack, Decoded>();
function undelta(rows: number[][]): Int32Array[] {
  return rows.map((r) => {
    const o = new Int32Array(r.length);
    let v = 0;
    for (let i = 0; i < r.length; i++) o[i] = v += r[i];
    return o;
  });
}
function decoded(ix: NationalIndexPack): Decoded {
  let d = decodedMemo.get(ix);
  if (!d) decodedMemo.set(ix, (d = { secs: undelta(ix.secs), dep: undelta(ix.dep), arr: undelta(ix.arr) }));
  return d;
}

/** Which of the filters to skip when selecting (a histogram shows its own
    dimension under all the others). */
export type NatSkip = "hour" | "dist" | "dur" | null;

/** Per-`train_table` row 0/1 flags of the trains that pass the filter (null
    = every train). The class filter alone needs no index; the others are
    ignored until `ix` has loaded. */
export function natSelect(
  trainTable: readonly RawTrain[],
  ix: NationalIndexPack | null,
  f: NatFilter,
  skip: NatSkip = null,
): Uint8Array | null {
  const cls = f.classes.length ? new Set(f.classes.map(classIndex)) : null;
  const useIx = !!ix && natIndexActive(f);
  if (!cls && !useIx) return null;
  const hours = useIx && skip !== "hour" && f.hours.length ? new Set(f.hours) : null;
  const dist = useIx && skip !== "dist" && f.distBins.length ? new Set(f.distBins.map((b) => b.bin)) : null;
  const dur = useIx && skip !== "dur" && f.durBins.length ? new Set(f.durBins.map((b) => b.bin)) : null;
  const codes = useIx && f.trainCodes.length ? new Set(f.trainCodes) : null;
  const distArr = ix ? (f.unit === "mi" ? ix.dist_mi : ix.dist_km) : [];
  const out = new Uint8Array(trainTable.length);
  for (let t = 0; t < out.length; t++) {
    if (cls && !cls.has(classIndex(trainTable[t].class))) continue;
    if (hours && !hours.has(ix!.hour[t])) continue;
    if (dist && !dist.has(distArr[t])) continue;
    if (dur && !dur.has(ix!.dur[t])) continue;
    if (codes && !codes.has(trainTable[t].code)) continue;
    out[t] = 1;
  }
  return out;
}

/** Trains per section under the filter: the precomputed class sums when no
    index filter is active, else the selected trains' section rows added up. */
export function natFlowCounts(
  nf: NationalFlowsPack,
  ix: NationalIndexPack | null,
  f: NatFilter,
  sel: Uint8Array | null,
): Uint32Array {
  if (!ix || !sel || !natIndexActive(f)) return nationalCounts(nf, f.classes);
  const out = new Uint32Array(nf.total.length);
  const { secs } = decoded(ix);
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue;
    const r = secs[t];
    for (let i = 0; i < r.length; i++) out[r[i]]++;
  }
  return out;
}

/** Departures / arrivals per `nf.cities` row under the filter (class sums, or
    the selected trains' dep / arr city rows added up). */
export function natCityCounts(
  nf: NationalFlowsPack,
  ix: NationalIndexPack | null,
  f: NatFilter,
  sel: Uint8Array | null,
): { idx: number[]; dep: Uint32Array; arr: Uint32Array } {
  const c = nf.cities;
  if (!c || !ix || !sel || !natIndexActive(f)) return nationalCityCounts(nf, f.classes);
  const pos = new Map<number, number>();
  c.idx.forEach((city, i) => pos.set(city, i));
  const dep = new Uint32Array(c.idx.length), arr = new Uint32Array(c.idx.length);
  const d = decoded(ix);
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue;
    for (const city of d.dep[t]) {
      const i = pos.get(city);
      if (i !== undefined) dep[i]++;
    }
    for (const city of d.arr[t]) {
      const i = pos.get(city);
      if (i !== undefined) arr[i]++;
    }
  }
  return { idx: c.idx, dep, arr };
}

/** The stop events (departures and arrivals) at each `nf.cities` city of the
    selected trains, as minutes of the day sorted per city: city i's events
    are `minutes[off[i] .. off[i + 1]]`. */
export interface NatCityEvents {
  off: Uint32Array;
  minutes: Uint16Array;
}

/** The selected trains' event minutes per city (null when the index has no
    `dep_min` / `arr_min`: an older pack). A selection-dependent reduction,
    built once per selection; the clock then only binary-searches it. */
export function natCityEvents(
  nf: NationalFlowsPack,
  ix: NationalIndexPack | null,
  sel: Uint8Array | null,
): NatCityEvents | null {
  const c = nf.cities;
  if (!c || !ix || !ix.dep_min || !ix.arr_min) return null;
  const pos = new Map<number, number>();
  c.idx.forEach((city, i) => pos.set(city, i));
  const d = decoded(ix);
  const rows: [Int32Array[], number[][]][] = [
    [d.dep, ix.dep_min],
    [d.arr, ix.arr_min],
  ];
  const each = (fn: (city: number, minute: number) => void) => {
    for (let t = 0; t < ix.n_train; t++) {
      if (sel && !sel[t]) continue;
      for (const [ids, mins] of rows) {
        const row = ids[t], m = mins[t];
        for (let j = 0; j < row.length; j++) {
          const i = pos.get(row[j]);
          if (i !== undefined) fn(i, m[j]);
        }
      }
    }
  };
  const off = new Uint32Array(c.idx.length + 1);
  each((i) => off[i + 1]++);
  for (let i = 0; i < c.idx.length; i++) off[i + 1] += off[i];
  const minutes = new Uint16Array(off[c.idx.length]);
  const cur = off.slice(0, c.idx.length);
  each((i, m) => (minutes[cur[i]++] = m));
  for (let i = 0; i < c.idx.length; i++) minutes.subarray(off[i], off[i + 1]).sort();
  return { off, minutes };
}

/** Events of city `i` with minute <= t. */
export function natCityEventsAt(ev: NatCityEvents, i: number, t: number): number {
  let lo = ev.off[i], hi = ev.off[i + 1];
  const start = lo;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ev.minutes[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - start;
}

/** Histogram counts of one dimension under every other filter. */
export function natHistogram(
  trainTable: readonly RawTrain[],
  ix: NationalIndexPack,
  f: NatFilter,
  dim: Exclude<NatSkip, null>,
): number[] {
  const sel = natSelect(trainTable, ix, f, dim);
  const arr = dim === "hour" ? ix.hour : dim === "dur" ? ix.dur : f.unit === "mi" ? ix.dist_mi : ix.dist_km;
  const nb = dim === "hour" ? NAT_HOUR_BINS : dim === "dur" ? NAT_DUR_BINS : NAT_DIST_BINS[f.unit];
  const out = new Array<number>(nb).fill(0);
  for (let t = 0; t < arr.length; t++) {
    if (sel && !sel[t]) continue;
    const b = arr[t];
    if (b >= 0 && b < nb) out[b]++;
  }
  return out;
}
