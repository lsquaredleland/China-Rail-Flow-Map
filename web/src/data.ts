import type { InMapData, OutMapData, SharedData } from "./types";
import { decodeFlows, requireFmt } from "./lib";
import { maybeReloadForStale } from "./staleReload";

// The v2 atlas dataset ships in five split files (same origin order
// throughout): the shared tables and geometry, and per direction a map
// file (identity, aggregates, flows) and a tables file (the per-train
// rows). Loading is staged so the map paints before the table data
// arrives:
//   phase 1 — shared + out-map in parallel (plus in-map when the
//     persisted direction is inbound): the map renders and is fully
//     interactive on this data alone;
//   phase 2 — the active direction's tables file (with the schedules asset,
//     O16, in parallel), fetched immediately
//     behind phase 1; the departures table and histograms fill in
//     when it lands;
//   phase 3 — the other direction loads the same way on the first
//     flip: its map file (paint), then its tables behind it.
// Every file is fetched at most once and cached for the session; each
// merge goes into the origins in place, by index.
export const SHARED_URL = "assets/atlas-v2-shared.json";
const OUT_MAP_URL = "assets/atlas-v2-out-map.json";
export const OUT_TABLES_URL = "assets/atlas-v2-out-tables.json";
export const IN_MAP_URL = "assets/atlas-v2-in-map.json";
export const IN_TABLES_URL = "assets/atlas-v2-in-tables.json";
export const OUTLINE_URL = "assets/china-outline.json";
// Every data file carries the pack format (fmt 6: renumbered sections,
// delta-coded map flows, per-train paths with station throats); older packs would draw wrong,
// so each file is checked on load and refused otherwise.
// Fetch the out/in map files with their flows decoded and format checked.
export async function fetchOutMap(): Promise<OutMapData> {
  const d = await fetchData<OutMapData>(OUT_MAP_URL);
  requireFmt(d.fmt, OUT_MAP_URL);
  for (const o of d.origins) decodeFlows(o.flows);
  return d;
}
export async function fetchInMap(): Promise<InMapData> {
  const d = await fetchData<InMapData>(IN_MAP_URL);
  requireFmt(d.fmt, IN_MAP_URL);
  for (const o of d.origins) decodeFlows(o.in_flows);
  return d;
}

export const SCHEDULES_URL = "assets/atlas-v2-schedules.json";
// National per-section flows (P3.1/P3.2): fetched only when national flows
// are requested, never for the origin view.
export const NATIONAL_FLOWS_URL = "assets/atlas-v2-national.json";
// National flow entry ticks (P3.3): fetched only for national Trains + flows.
export const NATIONAL_ENTRIES_URL = "assets/atlas-v2-national-entries.json";
// National per-train index (optional): the hour / distance / duration / code
// filters and their histograms; fetched only when national mode asks for it.
export const NATIONAL_INDEX_URL = "assets/atlas-v2-national-index.json";
// National trains (P2.2): every national train's whole run, fetched only on
// entering national mode, never for the origin view.
export const NATIONAL_TRAINS_URL = "assets/atlas-v2-national-trains.json";

// The footer's ABOUT text: fixed prose plus the timetable source sentence.
// The source sentence and the schedule window are pack facts: the pipeline
// writes them into `shared.about` (train-export packs); a pack without it
// derives the window from `shared.calendar`, and a pack with neither (a
// 12306 build) names the source only.
const ABOUT_PROSE =
  "Minard-style passenger rail flow maps for China's top rail cities. " +
  "Flow line width reflects daily train frequency along each railway corridor. " +
  "In the outbound view, trains are traced from the origin city outward to their destinations; " +
  "in the inbound view, trains are traced from their starting stations through all intermediate calls into the selected city. ";

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function longDate(iso: string, year: boolean): string | undefined {
  const [y, m, d] = iso.split("-").map(Number);
  const month = MONTHS_LONG[m - 1];
  if (!month || !d || !y) return undefined;
  return year ? `${d} ${month} ${y}` : `${d} ${month}`;
}

/** The timetable source sentence for a calendar (ISO dates in order); the
    same wording the pipeline writes (`provenance::about_block`). */
function sourceSentence(calendar: readonly string[] | undefined): string {
  const base = "Timetable data is sourced from China Railway (12306)";
  if (!calendar || calendar.length === 0) return `${base}.`;
  const from = calendar[0];
  const to = calendar[calendar.length - 1];
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const a = longDate(from, from === to || !sameYear);
  const b = longDate(to, true);
  if (!a || !b) return `${base}.`;
  const window = from === to ? `on ${a}` : `from ${a} to ${b}`;
  return `${base}, covering the passenger trains listed as running on at least one date ${window}.`;
}

export function aboutText(shared: Pick<SharedData, "about" | "calendar">): string {
  return ABOUT_PROSE + (shared.about?.source ?? sourceSentence(shared.calendar));
}

/* Fetch one dataset file, preferring its Brotli twin (the .br asset).
   The host (vercel.json) sends the .br with Content-Encoding: br +
   Content-Type: application/json, so the browser has already decompressed
   it and the bytes are JSON ("{"). Anything else (header missing, SPA
   fallback HTML) falls back to the plain .json split. */
declare const __ASSET_MANIFEST__: string | undefined; // JSON text (a string define keeps esbuild from hoisting it into a shared chunk)
/* The build content-hashes the .br packs (web/bundle.mjs) and bakes the
   name -> hashed-path map into the bundle; unhashed names (dev, or a
   missing entry) resolve to the plain twin path. */
function brUrl(jsonUrl: string): string {
  const m: Record<string, string> | undefined =
    typeof __ASSET_MANIFEST__ === "undefined" ? undefined : JSON.parse(__ASSET_MANIFEST__);
  return (m && m[jsonUrl]) || jsonUrl + ".br";
}
export async function fetchData<T>(jsonUrl: string): Promise<T> {
  try {
    const url = brUrl(jsonUrl);
    const res = await fetch(url);
    if (!res.ok && maybeReloadForStale(res.status, url)) {
      return new Promise<T>(() => {}); // the page is about to reload
    }
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const u8 = new Uint8Array(buf);
      if (u8[0] === 0x7b) {
        return JSON.parse(new TextDecoder().decode(u8)) as T;
      }
    }
  } catch {
    /* fall through to the plain split */
  }
  const r = await fetch(jsonUrl);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return (await r.json()) as T;
}
// ci probe
