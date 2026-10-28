/* City close-ups (origin view): from URL zoom CLOSEUP_Z an origin city's
   major stations split its dot into one dot per station, each labelled, and
   merge back below it. Which stations, where and of which city come with the
   pack (`station_table` `closeup` / `pt` / `city`, chosen by the pipeline);
   this module only groups them and interpolates the split. Pure. */
import type { RawCity, RawStation } from "../types";

/** URL zoom (`z`) at and above which cities split. */
export const CLOSEUP_Z = 9;
/** Length of the split / merge animation, ms. */
export const CLOSEUP_MS = 450;
/** Smallest station dot, px (Guangzhou has 41 stations): never above the city's own. */
const CLOSEUP_MIN_PX = 4;

/** Drawn radius of a station dot of a city drawn at `r` px, at factor `f` (DotPlace.f). */
export const splitRadius = (r: number, f: number) => (f >= 1 ? r : Math.max(Math.min(CLOSEUP_MIN_PX, r), r * f));

export interface CloseupStation {
  zh: string;
  en: string;
  pt: [number, number];
}

/** The `view.scale` of URL zoom `z` (z = log2(scale * 360 / 256), as the URL writes it). */
export const scaleOfZoom = (z: number) => (256 * Math.pow(2, z)) / 360;

const byCityCache = new WeakMap<RawStation[], Map<string, CloseupStation[]>>();

/** City name (zh) → its close-up stations (two or more, as the pipeline flags them). */
export function cityStations(stations: RawStation[], cities: RawCity[]): Map<string, CloseupStation[]> {
  const hit = byCityCache.get(stations);
  if (hit) return hit;
  const all = new Map<string, CloseupStation[]>();
  for (const s of stations) {
    if (!s.closeup || s.city === undefined || !s.pt || !cities[s.city]) continue;
    const zh = cities[s.city].zh;
    let l = all.get(zh);
    if (!l) all.set(zh, (l = []));
    l.push({ zh: s.zh, en: s.en, pt: s.pt });
  }
  const out = new Map<string, CloseupStation[]>();
  for (const [zh, l] of all) if (l.length >= 2) out.set(zh, l);
  byCityCache.set(stations, out);
  return out;
}

/** The split's animation: from progress `from` towards `to` (0 merged, 1 split), started at `at` (ms). */
export interface SplitAnim {
  from: number;
  to: number;
  at: number;
}

/** Progress at `now` (ms), eased in and out. */
export function splitK(a: SplitAnim, now: number): number {
  const u = Math.max(0, (now - a.at) / CLOSEUP_MS);
  if (u >= 1) return a.to;
  const e = u < 0.5 ? 2 * u * u : 1 - ((2 - 2 * u) * (2 - 2 * u)) / 2;
  return a.from + (a.to - a.from) * e;
}

/** The animation heading to `to`: `a` itself when it already does, else a new one from where `a` is now. */
export function retarget(a: SplitAnim, to: number, now: number): SplitAnim {
  return a.to === to ? a : { from: splitK(a, now), to, at: now };
}

export interface DotPlace {
  pos: [number, number];
  /** Radius factor on the city's dot: each of n station dots has 1/n of its area once split. */
  f: number;
  /** The station, when the city is split. */
  st?: CloseupStation;
}

/** Where a city's dot(s) are drawn at split progress `k`: the city's point,
    or one dot per station on its way from the city's point to the station's. */
export function dotPlaces(pt: [number, number], stations: CloseupStation[] | undefined, k: number): DotPlace[] {
  if (!stations || k <= 0) return [{ pos: pt, f: 1 }];
  const f = 1 + (1 / Math.sqrt(stations.length) - 1) * k;
  return stations.map((st) => ({
    pos: [pt[0] + (st.pt[0] - pt[0]) * k, pt[1] + (st.pt[1] - pt[1]) * k],
    f,
    st,
  }));
}
