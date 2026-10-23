/* Pure logic for the atlas: polyline decoding, per-origin view-models,
   palettes, the travel-time ramp, and value formatting. No DOM in here
   except where a function's whole job is producing tooltip HTML. */
import type {
  ArrVM,
  AtlasData,
  BBox,
  DecodedAtlas,
  DecodedSet,
  DepVM,
  DestVM,
  DistUnit,
  OriginVM,
  Palette,
  RampStop,
  SrcVM,
} from "./types";

/* ---------- names & escaping ---------- */

// The data's romanizations for a few famous places, in the form readers know.
const EN_FIX: Record<string, string> = {
  Lasa: "Lhasa",
  Wulumuqi: "Ürümqi",
  Xianggang: "Hong Kong",
};
export function enName(en: string): string {
  return EN_FIX[en] || en;
}

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ---------- palettes ---------- */

// Travel-time bands: three flat colours on a fixed 0–24 hour scale —
// petrol #14746F under 4h, saffron #E3A63F from 4h to 12h, ultramarine
// #34488C beyond 12h. Each band's interior is flat; the doubled stops
// at 210/270 and 690/750 minutes soften each join over ±30 minutes
// around the 4h and 12h boundaries.
const TIME_BANDS: RampStop[] = [
  [0, [20, 116, 111]],
  [210, [20, 116, 111]],
  [270, [227, 166, 63]],
  [690, [227, 166, 63]],
  [750, [52, 72, 140]],
  [1440, [52, 72, 140]],
];

export function palette(dark: boolean): Palette {
  if (dark)
    return {
      paper: "#221b11",
      network: "rgba(206,182,140,0.13)",
      graticule: "rgba(206,182,140,0.07)",
      flow: "rgb(255,140,66)",
      flowHi: "#ffc79a",
      flowStops: [],
      chord: "rgba(190,160,120,0.75)",
      infraLine: "#ecdfc2",
      infraHsr: "#4da3ff",
      infraConv: "#ecdfc2",
      dot: "#ecdfc2",
      dotEdge: "#221b11",
      label: "#ecdfc2",
      labelHalo: "rgba(34,27,17,0.88)",
      origin: "#e8b34b",
      legendInk: "#b8a67f",
      legendLine: "#ff8c42",
      ramp: TIME_BANDS,
    };
  return {
    paper: "#ffffff",
    network: "#C9C8C2",
    graticule: "rgba(201,200,194,0.45)",
    flow: "rgb(200,48,42)",
    flowHi: "#8E1B17",
    flowStops: [
      [0, [240, 169, 159]],
      [0.33, [229, 96, 79]],
      [0.67, [200, 48, 42]],
      [1, [142, 27, 23]],
    ],
    chord: "#c9b8a6",
    infraLine: "#111111",
    infraHsr: "#C8302A",
    infraConv: "#111111",
    dot: "#111111",
    dotEdge: "#ffffff",
    label: "#111111",
    labelHalo: "rgba(255,255,255,0.92)",
    origin: "#111111",
    legendInk: "#555555",
    legendLine: "#C8302A",
    ramp: TIME_BANDS,
  };
}

/* ---------- scales & formatting ---------- */

// Minard width scale: strictly proportional to trains/day at every zoom —
// width = k(zoom) * trains, k = 0.08 px per train at national-fit scale,
// with only a 0.5 px hairline floor so 1-train sections stay visible.
export const WIDTH_K = 0.08;
export function flowWidth(n: number, scale: number, fitScale: number): number {
  return Math.max(0.5, n * WIDTH_K * (scale / fitScale));
}

function rgbStr(c: [number, number, number]): string {
  return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
}

// Flow colour ramp (light scheme only): a section's stroke runs pale
// salmon → mid red → deep crimson as t = sqrt(n / N) goes 0 → 1, where
// N is the widest section of the origin currently on show — so the
// busiest corridors read hottest and the ramp re-normalises on every
// origin / direction switch. The dark scheme carries no stops and keeps
// its single flat flow colour.
export function flowColor(n: number, maxN: number, pal: Palette): string {
  const stops = pal.flowStops;
  if (!stops.length || maxN <= 0) return pal.flow;
  const t = Math.max(0, Math.min(1, Math.sqrt(n / maxN)));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const f = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      const a = stops[i - 1][1];
      const c = stops[i][1];
      return rgbStr([
        Math.round(a[0] + (c[0] - a[0]) * f),
        Math.round(a[1] + (c[1] - a[1]) * f),
        Math.round(a[2] + (c[2] - a[2]) * f),
      ]);
    }
  }
  return rgbStr(stops[stops.length - 1][1]);
}

// Travel-time colour: minutes from the origin mapped through the
// palette's band stops (TIME_BANDS) — flat green / amber / purple bands
// with a ±30-minute blend where they meet at 4h and 12h, clamped at
// both ends of the 0-24 hour scale.
export function rampColor(mins: number, pal: Palette): string {
  const u = Math.max(0, Math.min(1, mins / 1440));
  const stops = pal.ramp;
  for (let i = 1; i < stops.length; i++) {
    const su = stops[i][0] / 1440;
    if (u <= su) {
      const pu = stops[i - 1][0] / 1440;
      const f = su > pu ? (u - pu) / (su - pu) : 0;
      const a = stops[i - 1][1];
      const c = stops[i][1];
      return rgbStr([
        Math.round(a[0] + (c[0] - a[0]) * f),
        Math.round(a[1] + (c[1] - a[1]) * f),
        Math.round(a[2] + (c[2] - a[2]) * f),
      ]);
    }
  }
  return rgbStr(stops[stops.length - 1][1]);
}

// Dot radius is a screen-space size, clamped so a destination stays a
// marker at any zoom instead of swelling into a blob over the track.
export function stationR(trains: number): number {
  return Math.max(2, Math.min(26, 1.3 + Math.sqrt(trains) * 0.55));
}

export function fmtTime(m: number | null | undefined): string {
  if (m === null || m === undefined || m < 0 || isNaN(m)) return "—";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h + ":" + (mm < 10 ? "0" : "") + mm;
}

/** Minutes since midnight → zero-padded "HH:MM" clock time, the display
    form of every clock field in the v2 data (which stores raw minutes). */
export function fmtClock(m: number | null | undefined): string {
  if (m === null || m === undefined || m < 0 || isNaN(m)) return "—";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
}

// One value, in the unit picked on the toolbar switcher; unknown
// distances (rail_km -1, e.g. Hong Kong's unrouted tunnel leg) read
// as an em dash.
export function fmtDist(km: number | null | undefined, unit: DistUnit): string {
  if (km === null || km === undefined || km < 0 || isNaN(km)) return "—";
  if (unit === "mi")
    return Math.round(km * 0.621371).toLocaleString("en-US") + " mi";
  return km.toLocaleString("en-US") + " km";
}

/** The fact rows shared by the hover tooltip and the pinned detail panel. */
export function stationRows(
  c: DestVM,
  originEn: string,
  unit: DistUnit,
): [string, string][] {
  return [
    ["Direct trains / day", String(c.trains)],
    ["of which fast (G/D/C/S)", String(c.fast)],
    ["Trains ending here", String(c.terminating)],
    ["Fastest from " + originEn, fmtTime(c.fastest)],
    ["Median journey", fmtTime(c.median)],
    ["Crow flies", fmtDist(c.crow, unit)],
    ["By rail", fmtDist(c.rail, unit)],
  ];
}

/** stationRows as the tooltip's HTML table (the tooltip is set via innerHTML). */
export function stationRowsHtml(
  c: DestVM,
  originEn: string,
  unit: DistUnit,
): string {
  return rowsHtml(stationRows(c, originEn, unit));
}

/** The mirrored fact rows for a source city in inbound mode. */
export function sourceRows(
  c: SrcVM,
  destEn: string,
  unit: DistUnit,
): [string, string][] {
  return [
    ["Direct trains / day", String(c.trains)],
    ["of which fast (G/D/C/S)", String(c.fast)],
    ["Originate in " + c.en, String(c.originating)],
    ["Fastest to " + destEn, fmtTime(c.fastest)],
    ["Median journey", fmtTime(c.median)],
    ["Crow flies", fmtDist(c.crow, unit)],
    ["By rail", fmtDist(c.rail, unit)],
  ];
}

/** sourceRows as the tooltip's HTML table. */
export function sourceRowsHtml(
  c: SrcVM,
  destEn: string,
  unit: DistUnit,
): string {
  return rowsHtml(sourceRows(c, destEn, unit));
}

function rowsHtml(rows: [string, string][]): string {
  return (
    "<table>" +
    rows
      .map(
        (r) =>
          "<tr><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) + "</td></tr>",
      )
      .join("") +
    "</table>"
  );
}

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
  return { data, sec, inSec, net, extent: e };
}

/* ---------- station lookups ---------- */

export function stationName(data: AtlasData, idx: number): string | null {
  if (idx === null || idx === undefined || idx < 0) return null;
  const s = data.station_table[idx];
  return s ? s.zh : null;
}

export function stationLabel(data: AtlasData, idx: number): string {
  const s = data.station_table[idx];
  if (!s) return "—";
  return enName(s.en) + " · " + s.zh;
}

/** Great-circle distance in km between two [lon, lat] points. */
export function haversineKm(
  a: [number, number],
  b: [number, number],
): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a[1] * rad) *
      Math.cos(b[1] * rad) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* ---------- per-origin view-model ---------- */

export const FLOW_CLASSES = [
  "G",
  "D",
  "C",
  "S",
  "Z",
  "T",
  "K",
  "plain",
] as const;

export function classIndex(cls: string): number {
  switch (cls) {
    case "G":
      return 0;
    case "D":
      return 1;
    case "C":
      return 2;
    case "S":
      return 3;
    case "Z":
      return 4;
    case "T":
      return 5;
    case "K":
      return 6;
    default:
      return 7;
  }
}

export function buildOrigin(atlas: DecodedAtlas, idx: number): OriginVM {
  const { data } = atlas;
  const o = data.origins[idx];
  const flows = o.flows.map((f) => ({
    s: f[0],
    n: f[1],
    byClass: [
      f[2] || 0,
      f[3] || 0,
      f[4] || 0,
      f[5] || 0,
      f[6] || 0,
      f[7] || 0,
      f[8] || 0,
      f[9] || 0,
    ],
  }));
  // Widest first, narrower on top: strokes are opaque, so where a
  // narrower section shares ground with a wider one it reads as a
  // clean step down in width, never a ghost stripe inside the band,
  // and junction overlaps cannot double-darken.
  flows.sort((a, b) => b.n - a.n);
  // Departures are built first: each destination's `calls` list joins
  // back into this array by index, so a calling train carries its code,
  // boarding station/time and final terminus with it.
  // v2 deps rows are positional:
  // [train, from-station, dep minutes, to-station, to-city, arr minutes,
  //  duration, stops, km].
  const deps: DepVM[] = (o.deps || []).map((d, di) => {
    const t = data.train_table[d[0]];
    const fs = data.station_table[d[1]];
    const ts = data.station_table[d[3]];
    const tc = data.city_table[d[4]];
    const rec: DepVM = {
      code: t.code,
      cls: t.class,
      dep: fmtClock(d[2]),
      arr: fmtClock(d[5]),
      dur: d[6],
      stops: d[7],
      tcIdx: d[4],
      fsZh: fs.zh,
      fsEn: fs.en,
      tsZh: ts.zh,
      tsEn: ts.en,
      tcZh: tc.zh,
      tcEn: enName(tc.en),
      km: d[8],
      distKm: d[8] > 0 ? d[8] : haversineKm(o.pt, tc.pt),
      hay: "",
      secs: (o.dep_secs && o.dep_secs[di]) || [],
    };
    rec.hay = (
      rec.code +
      " " +
      rec.cls +
      " " +
      rec.fsZh +
      " " +
      rec.fsEn +
      " " +
      rec.tsZh +
      " " +
      rec.tsEn +
      " " +
      rec.tcZh +
      " " +
      tc.en +
      " " +
      rec.tcEn
    ).toLowerCase();
    return rec;
  });
  const dests: DestVM[] = o.dests.map((d, di) => {
    const c = data.city_table[d[0]];
    return {
      idx: d[0],
      zh: c.zh,
      en: enName(c.en),
      pt: c.pt,
      trains: d[1],
      fast: d[2],
      endpoint: d[3],
      terminating: d[3],
      fastest: d[4],
      median: d[5],
      crow: d[6],
      rail: d[7],
      nn: 0,
      calls: ((o.calls || [])[di] || []).map((call) => {
        const rawDep = (o.deps || [])[call[0]];
        const depMins = rawDep ? rawDep[2] : -1;
        const dur =
          depMins >= 0 && call[1] >= 0 ? call[3] * 1440 + call[1] - depMins : -1;
        return {
          dep: deps[call[0]],
          arr: fmtClock(call[1]),
          depAt: call[4] === 1 ? "—" : fmtClock(call[2]),
          dur: dur > 0 ? dur : -1,
          dayOff: call[3],
          term: call[4] === 1,
          secCnt:
            call[5] !== undefined
              ? call[5]
              : deps[call[0]]
                ? deps[call[0]].secs.length
                : 0,
        };
      }),
    };
  });
  dests.sort((a, b) => b.trains - a.trains);
  // Nearest-neighbour distance for every destination: the label pass
  // places the most squeezed termini first (Hong Kong's dot sits ~5 px
  // from Shenzhen's at national scale), before their neighbours' labels
  // take the only free spots around them.
  for (let di = 0; di < dests.length; di++) {
    let best2 = Infinity;
    for (let dj = 0; dj < dests.length; dj++) {
      if (dj === di) continue;
      const ddx = dests[di].pt[0] - dests[dj].pt[0];
      const ddy = dests[di].pt[1] - dests[dj].pt[1];
      const dd2 = ddx * ddx + ddy * ddy;
      if (dd2 < best2) best2 = dd2;
    }
    dests[di].nn = Math.sqrt(best2);
  }
  const chords = o.chords.map((ch) => {
    const f = decodeFlat(ch.g);
    return { a: ch.a, b: ch.b, n: ch.n, flat: f, count: f.length / 2, bb: flatBB(f) };
  });
  chords.sort((a, b) => a.n - b.n);

  /* ---------- inbound mirror ---------- */
  // The inbound fields are absent until the inbound files have loaded;
  // every inbound list then builds as empty and the header/table counts
  // stay at zero behind the map's loading affordance.
  const inFlows = (o.in_flows || []).map((f) => ({
    s: f[0],
    n: f[1],
    byClass: [
      f[2] || 0,
      f[3] || 0,
      f[4] || 0,
      f[5] || 0,
      f[6] || 0,
      f[7] || 0,
      f[8] || 0,
      f[9] || 0,
    ],
  }));
  inFlows.sort((a, b) => b.n - a.n);
  // Arrivals are built before the sources: each source's `in_calls`
  // list joins back into this array by index, exactly as outbound
  // calls join into deps.
  // v2 arrs rows are positional:
  // [train, origin-station, origin-city, dep minutes, arrival-station,
  //  arr minutes, duration, stops, km].
  const arrs: ArrVM[] = (o.arrs || []).map((a, ai) => {
    const t = data.train_table[a[0]];
    const fs = data.station_table[a[1]];
    const ts = data.station_table[a[4]];
    const fc = data.city_table[a[2]];
    const rec: ArrVM = {
      code: t.code,
      cls: t.class,
      dep: fmtClock(a[3]),
      arr: fmtClock(a[5]),
      dur: a[6],
      stops: a[7],
      dayOff: a[6] >= 0 ? Math.floor((a[3] + a[6]) / 1440) : 0,
      fcIdx: a[2],
      fcZh: fc.zh,
      fcEn: enName(fc.en),
      fsZh: fs.zh,
      fsEn: fs.en,
      tsZh: ts.zh,
      tsEn: ts.en,
      km: a[8],
      distKm: a[8] > 0 ? a[8] : haversineKm(fc.pt, o.pt),
      hay: "",
      secs: (o.arr_secs && o.arr_secs[ai]) || [],
    };
    rec.hay = (
      rec.code +
      " " +
      rec.cls +
      " " +
      rec.fsZh +
      " " +
      rec.fsEn +
      " " +
      rec.tsZh +
      " " +
      rec.tsEn +
      " " +
      rec.fcZh +
      " " +
      fc.en +
      " " +
      rec.fcEn
    ).toLowerCase();
    return rec;
  });
  const srcs: SrcVM[] = (o.srcs || []).map((s, si) => {
    const c = data.city_table[s[0]];
    return {
      idx: s[0],
      zh: c.zh,
      en: enName(c.en),
      pt: c.pt,
      trains: s[1],
      fast: s[2],
      endpoint: s[3],
      originating: s[3],
      fastest: s[4],
      median: s[5],
      crow: s[6],
      rail: s[7],
      nn: 0,
      inCalls: ((o.in_calls || [])[si] || []).map((call) => {
        const bs = data.station_table[call[5]];
        const dur =
          call[1] >= 0 && call[2] >= 0
            ? call[3] * 1440 + call[2] - call[1]
            : -1;
        return {
          arr: arrs[call[0]],
          board: fmtClock(call[1]),
          arrTime: fmtClock(call[2]),
          dur: dur > 0 ? dur : -1,
          dayOff: call[3],
          started: call[4] === 1,
          bsZh: bs ? bs.zh : "—",
          bsEn: bs ? bs.en : "",
          secCnt:
            call[6] !== undefined
              ? call[6]
              : arrs[call[0]]
                ? arrs[call[0]].secs.length
                : 0,
        };
      }),
    };
  });
  srcs.sort((a, b) => b.trains - a.trains);
  for (let si = 0; si < srcs.length; si++) {
    let best2 = Infinity;
    for (let sj = 0; sj < srcs.length; sj++) {
      if (sj === si) continue;
      const ddx = srcs[si].pt[0] - srcs[sj].pt[0];
      const ddy = srcs[si].pt[1] - srcs[sj].pt[1];
      const dd2 = ddx * ddx + ddy * ddy;
      if (dd2 < best2) best2 = dd2;
    }
    srcs[si].nn = Math.sqrt(best2);
  }
  return {
    o,
    en: enName(o.en),
    flows,
    dests,
    chords,
    deps,
    maxFlow: flows.length ? flows[0].n : 0,
    inFlows,
    srcs,
    arrs,
    maxInFlow: inFlows.length ? inFlows[0].n : 0,
  };
}

/** Return a derived OriginVM filtered to the selected train classes
    (e.g. ["G", "D"]). Preserves `o` reference identity so MapCanvas
    redraws in place without resetting camera zoom/pan. */
export function filterOriginByClasses(
  cur: OriginVM,
  selectedClasses: string[],
): OriginVM {
  if (!selectedClasses.length) return cur;
  const clsIndices = Array.from(new Set(selectedClasses.map(classIndex)));
  const hasClass = (cls: string) =>
    selectedClasses.includes(cls) ||
    (selectedClasses.includes("plain") && classIndex(cls) === 7);

  const flows = cur.flows
    .map((f) => {
      let n = 0;
      for (const ci of clsIndices) n += f.byClass[ci] || 0;
      return { s: f.s, n, byClass: f.byClass };
    })
    .filter((f) => f.n > 0)
    .sort((a, b) => b.n - a.n);

  const inFlows = cur.inFlows
    .map((f) => {
      let n = 0;
      for (const ci of clsIndices) n += f.byClass[ci] || 0;
      return { s: f.s, n, byClass: f.byClass };
    })
    .filter((f) => f.n > 0)
    .sort((a, b) => b.n - a.n);

  const deps = cur.deps.filter((d) => hasClass(d.cls));
  const arrs = cur.arrs.filter((a) => hasClass(a.cls));

  let dests = cur.dests;
  if (cur.deps.length > 0) {
    dests = [];
    for (const d of cur.dests) {
      const calls = d.calls.filter((c) => c.dep && hasClass(c.dep.cls));
      if (!calls.length) continue;
      let fast = 0;
      let terminating = 0;
      const times: number[] = [];
      for (const c of calls) {
        if (["G", "D", "C", "S"].includes(c.dep.cls)) fast++;
        if (c.term) terminating++;
        if (c.dur > 0 && c.dur < 6000) times.push(c.dur);
      }
      times.sort((a, b) => a - b);
      dests.push({
        ...d,
        trains: calls.length,
        fast,
        endpoint: terminating,
        terminating,
        fastest: times.length ? times[0] : d.fastest,
        median: times.length ? times[Math.floor(times.length / 2)] : d.median,
        calls,
      });
    }
    dests.sort((a, b) => b.trains - a.trains);
  }

  let srcs = cur.srcs;
  if (cur.arrs.length > 0) {
    srcs = [];
    for (const s of cur.srcs) {
      const inCalls = s.inCalls.filter((c) => c.arr && hasClass(c.arr.cls));
      if (!inCalls.length) continue;
      let fast = 0;
      let originating = 0;
      const times: number[] = [];
      for (const c of inCalls) {
        if (["G", "D", "C", "S"].includes(c.arr.cls)) fast++;
        if (c.started) originating++;
        if (c.dur > 0 && c.dur < 6000) times.push(c.dur);
      }
      times.sort((a, b) => a - b);
      srcs.push({
        ...s,
        trains: inCalls.length,
        fast,
        endpoint: originating,
        originating,
        fastest: times.length ? times[0] : s.fastest,
        median: times.length ? times[Math.floor(times.length / 2)] : s.median,
        inCalls,
      });
    }
    srcs.sort((a, b) => b.trains - a.trains);
  }

  return {
    o: cur.o,
    en: cur.en,
    flows,
    dests,
    chords: cur.chords,
    deps,
    maxFlow: flows.length ? flows[0].n : 0,
    inFlows,
    srcs,
    arrs,
    maxInFlow: inFlows.length ? inFlows[0].n : 0,
  };
}
