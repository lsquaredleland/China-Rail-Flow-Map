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
  RawArr,
  RawCall,
  RawDep,
  RawFlow,
  RawInCall,
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

/* ---------- per-train tables: lazy per-origin expansion ---------- */
// A tables pack holds per-train paths; the client reads per-row ones. The
// expansion runs per origin on first read of its fields (the selected
// origin, typically), so the other origins never allocate per-row copies.
// Copy an expanded origin with copyFields, not Object.assign or spread
// (those read every getter and so expand every origin).

/** What the per-row expansion reads from a tables pack, JSON or TA1. */
interface TableSource<Row, Call> {
  n: number;
  rows(o: number): Row[];
  lists(o: number): Call[][];
  /** Per row: `dep_off` (out) or `arr_len` (in). */
  mark(o: number): ArrayLike<number>;
  path(t: number): ArrayLike<number>;
  /** Out tables only. */
  stopPos(t: number): ArrayLike<number>;
  chords: [number, ChordLeg[]][];
}

function slice(a: ArrayLike<number>, from: number, to = a.length): number[] {
  from = Math.max(0, from);
  const out = new Array<number>(Math.max(0, to - from));
  for (let i = from; i < to; i++) out[i - from] = a[i];
  return out;
}

function once<T>(f: () => T): () => T {
  let v: T | undefined;
  let done = false;
  return () => {
    if (!done) {
      v = f();
      done = true;
    }
    return v as T;
  };
}

/** An object whose fields are each computed on first read, then kept as
    plain data properties (assignment works too). */
function lazyFields<T extends object>(make: { [K in keyof T]: () => T[K] }): T {
  const obj = {} as T;
  const keep = (target: object, k: PropertyKey, value: unknown) =>
    Object.defineProperty(target, k, { value, writable: true, enumerable: true, configurable: true });
  for (const k of Object.keys(make) as (keyof T)[]) {
    Object.defineProperty(obj, k, {
      enumerable: true,
      configurable: true,
      get() {
        const v = make[k]();
        keep(this, k, v);
        return v;
      },
      set(v) {
        keep(this, k, v);
      },
    });
  }
  return obj;
}

/** Merge `src`'s fields into `target` without reading lazy ones. */
export function copyFields(target: object, src: object): void {
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(src));
}

function outOrigins<Row extends RawDep, Call>(s: TableSource<Row, Call>) {
  const chords = once(() => new Map(s.chords));
  return Array.from({ length: s.n }, (_, o) => {
    const rows = once(() => s.rows(o));
    const lists = once(() => s.lists(o));
    const expand = once(() => {
      const deps = rows();
      const off = s.mark(o);
      const dep_secs: number[][] = [];
      const dep_chord_legs: ChordLeg[][] = [];
      const dep_stop_pos: number[][] = [];
      for (let i = 0; i < deps.length; i++) {
        const t = deps[i][0];
        const d = off[i];
        dep_secs.push(slice(s.path(t), d));
        dep_chord_legs.push(
          (chords().get(t) || [])
            .filter((l) => l[1] >= d)
            .map((l): ChordLeg => [l[0], l[1] - d, l[2] - d]),
        );
        const sp = s.stopPos(t);
        dep_stop_pos.push(slice(sp, sp.length - deps[i][7]).map((p) => p - d));
      }
      return { dep_secs, dep_chord_legs, dep_stop_pos };
    });
    return lazyFields<OutTablesData["origins"][number]>({
      deps: rows,
      calls: () => lists() as RawCall[][],
      dep_secs: () => expand().dep_secs,
      dep_chord_legs: () => expand().dep_chord_legs,
      dep_stop_pos: () => expand().dep_stop_pos,
    });
  });
}

function inOrigins<Row extends RawArr, Call>(s: TableSource<Row, Call>) {
  const chords = once(() => new Map(s.chords));
  return Array.from({ length: s.n }, (_, o) => {
    const rows = once(() => s.rows(o));
    const lists = once(() => s.lists(o));
    const expand = once(() => {
      const arrs = rows();
      const len = s.mark(o);
      const arr_secs: number[][] = [];
      const arr_chord_legs: ChordLeg[][] = [];
      for (let i = 0; i < arrs.length; i++) {
        const t = arrs[i][0];
        arr_secs.push(slice(s.path(t), 0, len[i]));
        arr_chord_legs.push((chords().get(t) || []).filter((l) => l[2] <= len[i]));
      }
      return { arr_secs, arr_chord_legs };
    });
    return lazyFields<InTablesData["origins"][number]>({
      arrs: rows,
      in_calls: () => lists() as RawInCall[][],
      arr_secs: () => expand().arr_secs,
      arr_chord_legs: () => expand().arr_chord_legs,
    });
  });
}

/** Per-row dep_secs / dep_chord_legs / dep_stop_pos from the fmt 6 JSON out tables (lazy per origin). */
export function expandOutTables(d: OutTablesPack): OutTablesData {
  return {
    origins: outOrigins({
      n: d.origins.length,
      rows: (o) => d.origins[o].deps,
      lists: (o) => d.origins[o].calls,
      mark: (o) => d.origins[o].dep_off,
      path: (t) => d.paths[t],
      stopPos: (t) => d.stop_pos[t],
      chords: d.chords,
    }),
  };
}

/** Per-row arr_secs / arr_chord_legs from the fmt 6 JSON in tables (lazy per origin). */
export function expandInTables(d: InTablesPack): InTablesData {
  return {
    origins: inOrigins({
      n: d.origins.length,
      rows: (o) => d.origins[o].arrs,
      lists: (o) => d.origins[o].in_calls,
      mark: (o) => d.origins[o].arr_len,
      path: (t) => d.paths[t],
      stopPos: () => [],
      chords: d.chords,
    }),
  };
}

/* ---------- TA1: the tables as typed-array columns ---------- */
// Layout and columns: pipeline/analyze/src/ta1.rs. The columns are views
// into the fetched buffer (no parse, no per-row objects); only an origin's
// rows that are read get materialised, by the expansion above.

type Ta1Array = Int16Array | Int32Array | Uint32Array;

interface Ta1Column {
  name: string;
  type: "i16" | "i32" | "u32";
  width: number;
  length: number;
  offset: number;
}

export interface Ta1 {
  fmt: number;
  pack: string;
  meta: { chords: [number, ChordLeg[]][] };
  cols: Record<string, { width: number; v: Ta1Array }>;
}

/** Does `u8` start with the TA1 magic? */
export function isTa1(u8: Uint8Array): boolean {
  return u8.length >= 8 && u8[0] === 0x54 && u8[1] === 0x41 && u8[2] === 0x31 && u8[3] === 0;
}

/** Read a TA1 file into column views. Throws on anything else. */
export function readTa1(bytes: Uint8Array): Ta1 {
  if (!isTa1(bytes)) throw new Error("not a TA1 file");
  // Typed views need aligned offsets; a fetched buffer starts at 0, a
  // pooled Node buffer may not.
  const u8 = bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hl = dv.getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
  const body = u8.byteOffset + Math.ceil((8 + hl) / 8) * 8;
  const cols: Ta1["cols"] = {};
  for (const c of h.columns as Ta1Column[]) {
    const at = body + c.offset;
    const v =
      c.type === "i16"
        ? new Int16Array(u8.buffer, at, c.length)
        : c.type === "i32"
          ? new Int32Array(u8.buffer, at, c.length)
          : new Uint32Array(u8.buffer, at, c.length);
    cols[c.name] = { width: c.width, v };
  }
  return { fmt: h.fmt, pack: h.pack, meta: h.meta, cols };
}

function ta1Source<Row, Call>(t: Ta1, rowsKey: string, markKey: string, listsKey: string): TableSource<Row, Call> {
  const col = (name: string) => {
    const c = t.cols[name];
    if (!c) throw new Error(`TA1 ${t.pack}: no column ${name}`);
    return c;
  };
  const rowsOf = (v: Ta1Array, w: number, r0: number, r1: number) => {
    const out = new Array(r1 - r0);
    for (let r = r0; r < r1; r++) out[r - r0] = slice(v, r * w, r * w + w);
    return out;
  };
  const pathOff = col("path_off").v;
  const paths = col("paths").v;
  const rowOff = col("row_off").v;
  const rows = col(rowsKey);
  const mark = col(markKey).v;
  const listOff = col("list_off").v;
  const callOff = col("call_off").v;
  const calls = col(listsKey);
  const stop = t.cols.stop_off && { off: t.cols.stop_off.v, v: col("stop_pos").v };
  return {
    n: rowOff.length - 1,
    rows: (o) => rowsOf(rows.v, rows.width, rowOff[o], rowOff[o + 1]),
    lists: (o) => {
      const out: Call[][] = [];
      for (let l = listOff[o]; l < listOff[o + 1]; l++)
        out.push(rowsOf(calls.v, calls.width, callOff[l], callOff[l + 1]));
      return out;
    },
    mark: (o) => mark.subarray(rowOff[o], rowOff[o + 1]),
    path: (t) => paths.subarray(pathOff[t], pathOff[t + 1]),
    stopPos: (t) => (stop ? stop.v.subarray(stop.off[t], stop.off[t + 1]) : []),
    chords: t.meta.chords,
  };
}

/** The out tables from atlas-v2-out-tables.ta1 (lazy per origin). */
export function expandOutTa1(t: Ta1): OutTablesData {
  if (t.pack !== "out-tables") throw new Error(`TA1: expected out-tables, got ${t.pack}`);
  return { origins: outOrigins(ta1Source<RawDep, RawCall>(t, "deps", "dep_off", "calls")) };
}

/** The in tables from atlas-v2-in-tables.ta1 (lazy per origin). */
export function expandInTa1(t: Ta1): InTablesData {
  if (t.pack !== "in-tables") throw new Error(`TA1: expected in-tables, got ${t.pack}`);
  return { origins: inOrigins(ta1Source<RawArr, RawInCall>(t, "arrs", "arr_len", "in_calls")) };
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
