/* Schematic (octilinear) geometry: the offline LOOM octi layout of the whole
   network (scripts/octi, docs/OCTI.md), shipped as atlas-v2-octi.json. It is
   a geometry twin of the shared pack: the same section, throat, station and
   city ids with schematic positions, so flows, paths, trains and tables are
   untouched. The client only swaps the arrays before decoding. */
import type { DecodedOutline, DecodedSet, NationalTrainsPack, RawCity, RawOrigin, SharedData } from "../types";

export const OCTI_URL = "assets/atlas-v2-octi.json";

/** The track geometry a session draws: real (OSM) or the octi schematic. */
export type Geom = "real" | "octi";

/** `?geom=octi` selects the schematic; anything else is real geometry. */
export function geomFromUrl(search: string = typeof location === "undefined" ? "" : location.search): Geom {
  return new URLSearchParams(search).get("geom") === "octi" ? "octi" : "real";
}

/** A URL (path + query + hash) with `geom` set, for the toggle's reload. */
export function urlWithGeom(href: string, geom: Geom): string {
  const u = new URL(href);
  if (geom === "octi") u.searchParams.set("geom", "octi");
  else u.searchParams.delete("geom");
  return u.pathname + u.search + u.hash;
}

export interface OctiPack {
  fmt: number;
  build: unknown;
  layout: string;
  /** "lon-mercdeg": points are (lon, mercator y in degrees), so the layout's
      0/45/90 degree legs stay exact on the client's equirectangular plane. */
  plane: string;
  n_sec: number;
  n_in: number;
  n_thr: number;
  n_extra: number;
  n_station: number;
  n_city: number;
  sections: string[];
  in_sections: string[];
  network: string[];
  throats: string[];
  extra: string[];
  station_pt: ([number, number] | null)[];
  city_pt: [number, number][];
}

/** Throw a FmtError unless `o` was built from this shared pack: same format,
    same build stamp, one entry per section, throat, station and city. */
export function requireOcti(o: OctiPack, shared: SharedData, url: string = OCTI_URL): void {
  const build = (shared as SharedData & { build?: unknown }).build;
  const ok =
    o.fmt === shared.fmt &&
    o.plane === "lon-mercdeg" &&
    JSON.stringify(o.build) === JSON.stringify(build) &&
    o.n_sec === shared.sections.length &&
    o.sections.length === o.n_sec &&
    o.n_in === shared.in_sections.length &&
    o.in_sections.length === o.n_in &&
    o.n_thr === shared.throats.length &&
    o.throats.length === o.n_thr &&
    o.extra.length === o.n_extra &&
    o.n_station === shared.station_table.length &&
    o.station_pt.length === o.n_station &&
    o.n_city === shared.city_table.length &&
    o.city_pt.length === o.n_city;
  if (ok) return;
  const err = new Error(`${url}: schematic layout does not match the shared pack; rebuild it (scripts/octi)`);
  err.name = "FmtError";
  throw err;
}

/** A copy of `shared` drawn on the schematic: section, in-section, network
    and throat geometry, station and city points swapped; everything else
    (ids, lines, speeds, tables) shared with the original. */
export function applyOcti(shared: SharedData, o: OctiPack): SharedData {
  return {
    ...shared,
    sections: shared.sections.map((s, i) => ({ ...s, g: o.sections[i] })),
    in_sections: shared.in_sections.map((s, i) => ({ ...s, g: o.in_sections[i] })),
    network: o.network,
    throats: o.throats,
    station_table: shared.station_table.map((t, i) => {
      const p = o.station_pt[i];
      return p ? { ...t, pt: p } : t;
    }),
    city_table: shared.city_table.map((c, i) => ({ ...c, pt: o.city_pt[i] })),
  };
}

/** National trains with their extra throat pieces on the schematic. Throws
    a FmtError when the counts disagree. */
export function applyOctiTrains(t: NationalTrainsPack, o: OctiPack, url: string = OCTI_URL): NationalTrainsPack {
  if (t.extra.length !== o.n_extra) {
    const err = new Error(`${url}: schematic layout does not match the national trains; rebuild it (scripts/octi)`);
    err.name = "FmtError";
    throw err;
  }
  return { ...t, extra: o.extra };
}

/** Web-mercator y of a latitude, in degrees (the schematic's plane y). */
export function mercDeg(lat: number): number {
  return (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;
}

function mercSet(set: DecodedSet): DecodedSet {
  const pts = Float32Array.from(set.pts);
  for (let i = 1; i < pts.length; i += 2) pts[i] = mercDeg(pts[i]);
  const bb = Float32Array.from(set.bb);
  for (let i = 0; i < bb.length; i += 4) {
    bb[i + 1] = mercDeg(bb[i + 1]);
    bb[i + 3] = mercDeg(bb[i + 3]);
  }
  return { ...set, pts, bb };
}

/** The coastline outline on the schematic's plane (latitudes to mercator y). */
export function octiOutline(o: DecodedOutline): DecodedOutline {
  return { rings: mercSet(o.rings), lines: mercSet(o.lines) };
}

/** The origins (out-map) carry their own point; on the schematic each takes
    its city's schematic point (same zh), in place, so markers, labels and
    the home view sit on the drawn hub. Returns how many moved. */
export function octiOrigins(origins: RawOrigin[], cities: readonly RawCity[]): number {
  const at = new Map<string, [number, number]>();
  for (const c of cities) if (!at.has(c.zh)) at.set(c.zh, c.pt);
  let moved = 0;
  for (const o of origins) {
    const p = at.get(o.zh);
    if (p) {
      o.pt = [p[0], p[1]];
      moved++;
    }
  }
  return moved;
}
