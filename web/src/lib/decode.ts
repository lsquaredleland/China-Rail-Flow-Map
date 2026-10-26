/* Wire-format decoding: polylines, section sets, the fmt 6 packs. */
import type {
  AtlasData,
  BBox,
  ChordLeg,
  DecodedAtlas,
  DecodedOutline,
  DecodedSet,
  InTablesData,
  InTablesPack,
  OutTablesData,
  OutTablesPack,
  OutlineData,
  RawFlow,
} from "../types";

/* ---------- polyline decoding ---------- */

// Google polyline encoding, precision 1e4, [lat, lon] order on the wire.
// Returns a flat array [lon0, lat0, lon1, lat1, ...].
export function decodeFlat(str: string): number[] {
  const pts: number[] = [];
  let lat = 0,
    lon = 0,
    i = 0;
  const n = str.length;
  let b = 0,
    shift = 0,
    result = 0;
  while (i < n) {
    shift = 0;
    result = 0;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    pts.push(lon / 1e4, lat / 1e4);
  }
  return pts;
}

// Decode a list of encoded strings once into one typed array + offsets + bboxes.
export function decodeSet(
  strings: string[],
  hsrFlags?: ArrayLike<number>,
): DecodedSet {
  const flats = new Array<number[]>(strings.length);
  let total = 0;
  for (let i = 0; i < strings.length; i++) {
    const f = decodeFlat(strings[i]);
    flats[i] = f;
    total += f.length;
  }
  const pts = new Float32Array(total);
  const off = new Int32Array(strings.length);
  const len = new Int32Array(strings.length);
  const bb = new Float32Array(strings.length * 4);
  const hsr = new Uint8Array(strings.length);
  if (hsrFlags) {
    for (let i = 0; i < strings.length; i++) hsr[i] = hsrFlags[i] ? 1 : 0;
  }
  let pos = 0;
  for (let i = 0; i < strings.length; i++) {
    const f = flats[i];
    off[i] = pos;
    len[i] = f.length / 2;
    pts.set(f, pos);
    let x0 = 1e9,
      y0 = 1e9,
      x1 = -1e9,
      y1 = -1e9;
    for (let j = 0; j < f.length; j += 2) {
      if (f[j] < x0) x0 = f[j];
      if (f[j] > x1) x1 = f[j];
      if (f[j + 1] < y0) y0 = f[j + 1];
      if (f[j + 1] > y1) y1 = f[j + 1];
    }
    bb[i * 4] = x0;
    bb[i * 4 + 1] = y0;
    bb[i * 4 + 2] = x1;
    bb[i * 4 + 3] = y1;
    pos += f.length;
  }
  return { pts, off, len, bb, hsr };
}

export function flatBB(f: number[]): BBox {
  let x0 = 1e9,
    y0 = 1e9,
    x1 = -1e9,
    y1 = -1e9;
  for (let j = 0; j < f.length; j += 2) {
    if (f[j] < x0) x0 = f[j];
    if (f[j] > x1) x1 = f[j];
    if (f[j + 1] < y0) y0 = f[j + 1];
    if (f[j + 1] > y1) y1 = f[j + 1];
  }
  return { x0, y0, x1, y1 };
}

/** Decode the shared geometry once: sections, backdrop network, data extent. */
export function prepAtlas(data: AtlasData): DecodedAtlas {
  const sec = decodeSet(
    data.sections.map((s) => s.g),
    data.sections.map((s) => (s.h ? 1 : 0)),
  );
  const inSec = decodeSet(
    data.in_sections.map((s) => s.g),
    data.in_sections.map((s) => (s.h ? 1 : 0)),
  );
  const net = decodeSet(data.network);
  const thr = decodeSet(data.throats || []);
  const e = { lon0: 1e9, lat0: 1e9, lon1: -1e9, lat1: -1e9 };
  for (let i = 0; i < data.network.length; i++) {
    if (net.bb[i * 4] < e.lon0) e.lon0 = net.bb[i * 4];
    if (net.bb[i * 4 + 2] > e.lon1) e.lon1 = net.bb[i * 4 + 2];
    if (net.bb[i * 4 + 1] < e.lat0) e.lat0 = net.bb[i * 4 + 1];
    if (net.bb[i * 4 + 3] > e.lat1) e.lat1 = net.bb[i * 4 + 3];
  }
  for (let i = 0; i < data.city_table.length; i++) {
    const p = data.city_table[i].pt;
    if (p[0] < e.lon0) e.lon0 = p[0];
    if (p[0] > e.lon1) e.lon1 = p[0];
    if (p[1] < e.lat0) e.lat0 = p[1];
    if (p[1] > e.lat1) e.lat1 = p[1];
  }
  e.lon0 -= 1.2;
  e.lon1 += 1.2;
  e.lat0 -= 1.0;
  e.lat1 += 1.0;
  return { data, sec, inSec, net, thr, extent: e };
}

/** Decode the China + islands outline rings and Nine-dash line once. */
export function prepOutline(data: OutlineData): DecodedOutline {
  return {
    rings: decodeSet(data.rings),
    lines: decodeSet(data.lines),
  };
}

/* ---------- fmt 6 decode ---------- */
// The packs ship sections renumbered, map flows sorted + delta-coded and
// per-row paths deduplicated into per-train paths (see atlaspack.rs). These
// rebuild exactly the per-row shapes the rest of the client reads. fmt 6 =
// fmt 5 plus station throats in the paths (O1): positions (dep_off, arr_len,
// chord legs, stop positions) index the whole path; decodeSecs drops the
// throats for everything but the dot animation.

/** The data pack format every file must carry. */
export const DATA_FMT = 6;

/** Throw a FmtError unless `fmt` is the supported pack format. */
export function requireFmt(fmt: unknown, url: string): void {
  if (fmt === DATA_FMT) return;
  const msg = `${url}: unsupported data format ${String(fmt)} (need fmt ${DATA_FMT}); rebuild the data pack`;
  console.error(msg);
  const err = new Error(msg);
  err.name = "FmtError";
  throw err;
}

/** Undo the delta coding of map flow rows in place: column 0 becomes the section id. */
export function decodeFlows(rows: RawFlow[] | undefined): void {
  if (!rows) return;
  let id = 0;
  for (let i = 0; i < rows.length; i++) {
    id += rows[i][0];
    rows[i][0] = id;
  }
}

/** Per-train chord legs by train index. */
function chordsByTrain(chords: [number, ChordLeg[]][]): Map<number, ChordLeg[]> {
  return new Map(chords);
}

/** Rebuild per-row dep_secs / dep_chord_legs / dep_stop_pos from the fmt 6 out tables. */
export function expandOutTables(d: OutTablesPack): OutTablesData {
  const chords = chordsByTrain(d.chords);
  return {
    origins: d.origins.map((o) => {
      const dep_secs: number[][] = [];
      const dep_chord_legs: ChordLeg[][] = [];
      const dep_stop_pos: number[][] = [];
      for (let i = 0; i < o.deps.length; i++) {
        const row = o.deps[i];
        const t = row[0];
        const off = o.dep_off[i];
        dep_secs.push(d.paths[t].slice(off));
        dep_chord_legs.push(
          (chords.get(t) || [])
            .filter((l) => l[1] >= off)
            .map((l): ChordLeg => [l[0], l[1] - off, l[2] - off]),
        );
        const sp = d.stop_pos[t];
        dep_stop_pos.push(sp.slice(sp.length - row[7]).map((p) => p - off));
      }
      return { deps: o.deps, calls: o.calls, dep_secs, dep_chord_legs, dep_stop_pos };
    }),
  };
}

/** Rebuild per-row arr_secs / arr_chord_legs from the fmt 6 in tables. */
export function expandInTables(d: InTablesPack): InTablesData {
  const chords = chordsByTrain(d.chords);
  return {
    origins: d.origins.map((o) => {
      const arr_secs: number[][] = [];
      const arr_chord_legs: ChordLeg[][] = [];
      for (let i = 0; i < o.arrs.length; i++) {
        const t = o.arrs[i][0];
        const len = o.arr_len[i];
        arr_secs.push(d.paths[t].slice(0, len));
        arr_chord_legs.push((chords.get(t) || []).filter((l) => l[2] <= len));
      }
      return { arrs: o.arrs, in_calls: o.in_calls, arr_secs, arr_chord_legs };
    }),
  };
}

/** Decode a travel-ordered path into its flow sections: `~s` marks a
    section walked in reverse; entries >= nSec are throats (O1) and are
    dropped, so flows, counts and highlights never see them. */
export function decodeSecs(raw: number[] | undefined, nSec: number): { secs: number[]; revs: Uint8Array } {
  const secs: number[] = [];
  const revs: number[] = [];
  for (const v of raw || []) {
    const id = v < 0 ? ~v : v;
    if (id >= nSec) continue;
    secs.push(id);
    revs.push(v < 0 ? 1 : 0);
  }
  return { secs, revs: Uint8Array.from(revs) };
}
