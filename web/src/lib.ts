/* Pure logic for the atlas: polyline decoding, per-origin view-models,
   palettes, the travel-time ramp, and value formatting. No DOM in here
   except where a function's whole job is producing tooltip HTML. */
import type {
  ActiveTrainVM,
  ArrVM,
  AtlasData,
  AtlasVM,
  BBox,
  DayTimelineVM,
  DecodedAtlas,
  DecodedOutline,
  DecodedSet,
  DepVM,
  DestVM,
  DistBinFilter,
  DistUnit,
  DurBinFilter,
  FlowVM,
  OriginFilterCriteria,
  OriginVM,
  OutlineData,
  Palette,
  PrepTrain,
  ChordSpan,
  PrepTrainStop,
  RampStop,
  ScheduleStop,
  SchedulesData,
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

// Travel-time bands: three flat colours on a fixed 0–24 hour scale.
// Day: petrol #14746F under 4h, saffron #E3A63F from 4h to 12h, ultramarine #34488C beyond 12h.
const TIME_BANDS: RampStop[] = [
  [0, [20, 116, 111]],
  [210, [20, 116, 111]],
  [270, [227, 166, 63]],
  [690, [227, 166, 63]],
  [750, [52, 72, 140]],
  [1440, [52, 72, 140]],
];

// Night: petrol lifted to #2BB5AC, saffron #F1B94E, and ultramarine lifted to
// pale periwinkle #A4B8F5 to maintain lightness separation on graphite.
const TIME_BANDS_NIGHT: RampStop[] = [
  [0, [43, 181, 172]],
  [210, [43, 181, 172]],
  [270, [241, 185, 78]],
  [690, [241, 185, 78]],
  [750, [164, 184, 245]],
  [1440, [164, 184, 245]],
];

export function palette(dark: boolean): Palette {
  if (dark)
    return {
      paper: "#1A1B1E",
      network: "#2E3035",
      graticule: "rgba(46,48,53,0.5)",
      flow: "rgb(200,48,42)",
      flowHi: "#C8302A",
      flowStops: [
        [0, [142, 27, 23]],      // deep red #8E1B17
        [0.33, [180, 36, 31]],
        [0.67, [200, 48, 42]],   // traffic red #C8302A
        [1, [229, 64, 53]],      // luminous traffic red #E54035
      ],
      chord: "#c9b8a6",
      infraLine: "#EDEDEA",
      infraHsr: "#FF6A00",
      infraConv: "#EDEDEA",
      dot: "#EDEDEA",
      dotEdge: "#1A1B1E",
      label: "#EDEDEA",
      labelHalo: "rgba(26,27,30,0.92)",
      origin: "#EDEDEA",
      legendInk: "#A3A3A0",
      legendLine: "#C8302A",
      ramp: TIME_BANDS,
      outline: "rgba(255,255,255,0.13)",
      dashLine: "rgba(56,189,248,0.40)",
      landFill: "rgba(255,255,255,0.015)",
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
    infraHsr: "#FF6A00",
    infraConv: "#111111",
    dot: "#111111",
    dotEdge: "#ffffff",
    label: "#111111",
    labelHalo: "rgba(255,255,255,0.92)",
    origin: "#111111",
    legendInk: "#555555",
    legendLine: "#C8302A",
    ramp: TIME_BANDS,
    outline: "rgba(160,155,145,0.60)",
    dashLine: "rgba(2,132,199,0.50)",
    landFill: "rgba(0,0,0,0.012)",
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
      .map((r) => {
        const isAccent = r[0].startsWith("Fastest") || r[0] === "By rail";
        return (
          "<tr><td>" +
          esc(r[0]) +
          "</td><td" +
          (isAccent ? ' class="accent-val"' : "") +
          ">" +
          esc(r[1]) +
          "</td></tr>"
        );
      })
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
  // Calibrate known city centroid coordinates where historical data used distant sub-stations or geocoding homonyms
  const CITY_COORD_CORRECTIONS: Record<string, [number, number]> = {
    铜仁: [109.1995, 27.7306], // Tongren Railway Station & downtown (was Tongren South 50km away in Yuping)
    兰溪: [119.5074, 29.2152], // Lanxi East Station, Jinhua, Zhejiang (was misgeocoded to Shandong)
    溆浦: [110.594, 27.908],   // Xupu Station downtown (was Xupu South)
  };
  for (let i = 0; i < data.city_table.length; i++) {
    const c = data.city_table[i];
    const fix = CITY_COORD_CORRECTIONS[c.zh];
    if (fix) {
      c.pt = [fix[0], fix[1]];
    }
  }

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

/** Decode the China + islands outline rings and Nine-dash line once. */
export function prepOutline(data: OutlineData): DecodedOutline {
  return {
    rings: decodeSet(data.rings),
    lines: decodeSet(data.lines),
  };
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
    const ds = decodeSecs(o.dep_secs && o.dep_secs[di]);
    const rec: DepVM = {
      t: d[0],
      code: t.code,
      cls: t.class,
      dep: fmtClock(d[2]),
      arr: fmtClock(d[5]),
      depMins: d[2],
      arrMins: d[5],
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
      secs: ds.secs,
      secRevs: ds.revs,
      chordLegs: (o.dep_chord_legs && o.dep_chord_legs[di]) || [],
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
      arrTimes: ((o.calls || [])[di] || [])
        .map((call) => (call[1] >= 0 ? call[3] * 1440 + call[1] : -1))
        .filter((t) => t >= 0)
        .sort((a, b) => a - b),
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
          arrMins: call[1] >= 0 ? call[3] * 1440 + call[1] : -1,
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
    const as = decodeSecs(o.arr_secs && o.arr_secs[ai]);
    const rec: ArrVM = {
      t: a[0],
      code: t.code,
      cls: t.class,
      dep: fmtClock(a[3]),
      arr: fmtClock(a[5]),
      depMins: a[3],
      arrMins: a[5],
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
      secs: as.secs,
      secRevs: as.revs,
      chordLegs: (o.arr_chord_legs && o.arr_chord_legs[ai]) || [],
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
      arrTimes: ((o.in_calls || [])[si] || [])
        .map((call) => call[1])
        .filter((t) => t >= 0)
        .sort((a, b) => a - b),
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
          boardMins: call[1],
          arrMins: call[2] >= 0 ? call[3] * 1440 + call[2] : -1,
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
  const res: OriginVM = {
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

  let timelineCache: DayTimelineVM | undefined;

  Object.defineProperty(res, "timeline", {
    get() {
      if (!timelineCache && deps.length > 0) {
        timelineCache = buildDayTimeline(res, atlas);
      }
      return timelineCache;
    },
    set(v) {
      timelineCache = v;
    },
    configurable: true,
    enumerable: true,
  });

  return res;
}

export const prepOrigin = buildOrigin;

interface SecGeometryCache {
  secLengths: Float64Array;
  secCumLens: Float64Array[];
}

function getSecGeometry(secSet: DecodedSet): SecGeometryCache {
  const cached = (secSet as any)._geoCache as SecGeometryCache | undefined;
  if (cached) return cached;
  const numSections = secSet.len.length;
  const secLengths = new Float64Array(numSections);
  const secCumLens: Float64Array[] = new Array(numSections);
  for (let s = 0; s < numSections; s++) {
    const off = secSet.off[s];
    const cnt = secSet.len[s];
    if (cnt <= 1) {
      secLengths[s] = 0;
      secCumLens[s] = new Float64Array(cnt);
      continue;
    }
    const cum = new Float64Array(cnt);
    let sum = 0;
    for (let k = 0; k < cnt - 1; k++) {
      const p0x = secSet.pts[off + k * 2];
      const p0y = secSet.pts[off + k * 2 + 1];
      const p1x = secSet.pts[off + (k + 1) * 2];
      const p1y = secSet.pts[off + (k + 1) * 2 + 1];
      sum += haversineKm([p0x, p0y], [p1x, p1y]);
      cum[k + 1] = sum;
    }
    secLengths[s] = sum;
    secCumLens[s] = cum;
  }
  const result: SecGeometryCache = { secLengths, secCumLens };
  (secSet as any)._geoCache = result;
  return result;
}

/** Realistic train velocity ramp profile between stops:
 *  Accelerates smoothly from station stop (sin^2 ramp), cruises at top leg speed,
 *  and decelerates smoothly into the next station platform. */
export function trainEase(tau: number, durMins: number): number {
  if (tau <= 0) return 0;
  if (tau >= 1) return 1;
  const accelMins = Math.min(3, durMins * 0.25);
  const a = Math.max(0.01, Math.min(0.35, accelMins / durMins));
  const denom = 1 - a;
  if (tau <= a) {
    return (0.5 * tau - (a / (2 * Math.PI)) * Math.sin((Math.PI * tau) / a)) / denom;
  }
  if (tau >= 1 - a) {
    const tPrime = 1 - tau;
    const rem = (0.5 * tPrime - (a / (2 * Math.PI)) * Math.sin((Math.PI * tPrime) / a)) / denom;
    return 1 - rem;
  }
  return (0.5 * a + (tau - a)) / denom;
}

/** Normalized instantaneous speed fraction in [0, 1] (0 at station halt, 1 at full cruise). */
export function trainSpeedFrac(tau: number, durMins: number): number {
  if (tau <= 0 || tau >= 1) return 0;
  const accelMins = Math.min(3, durMins * 0.25);
  const a = Math.max(0.01, Math.min(0.35, accelMins / durMins));
  if (tau <= a) {
    return Math.sin((Math.PI * tau) / (2 * a)) ** 2;
  }
  if (tau >= 1 - a) {
    return Math.sin((Math.PI * (1 - tau)) / (2 * a)) ** 2;
  }
  return 1.0;
}

// Scratch result of trainState (single-threaded; avoids per-call allocation).
const trainScratch = {
  dist: 0,
  speedFrac: 1,
  dwell: 0 as 0 | 1 | 2 | 3, // 0 moving, 1 origin, 2 intermediate stop, 3 final
  stop: null as PrepTrainStop | null,
};

function trainState(pt: PrepTrain, t: number) {
  const r = trainScratch;
  r.stop = null;
  r.dwell = 0;
  r.speedFrac = 1;
  if (t < pt.depMins) {
    r.dist = 0;
    r.dwell = 1;
    r.speedFrac = 0;
    return;
  }
  if (t >= pt.arrMins) {
    r.dist = pt.totalDist;
    r.dwell = 3;
    r.speedFrac = 0;
    return;
  }
  const stops = pt.stops;
  let legStartDist = 0;
  let legStartTime = pt.depMins;
  let legEndDist = pt.totalDist;
  let legEndTime = pt.arrMins;
  if (stops) {
    for (let si = 0; si < stops.length; si++) {
      const st = stops[si];
      if (st.depMins !== null && st.depMins > st.arrMins && t >= st.arrMins && t <= st.depMins) {
        r.dist = st.dist;
        r.dwell = 2;
        r.stop = st;
        r.speedFrac = 0;
        return;
      }
    }
    for (let si = 0; si < stops.length; si++) {
      const st = stops[si];
      if (t < st.arrMins) {
        legEndDist = st.dist;
        legEndTime = st.arrMins;
        break;
      }
      legStartDist = st.dist;
      legStartTime = st.depMins !== null ? st.depMins : st.arrMins;
    }
  }
  const legDur = Math.max(1, legEndTime - legStartTime);
  const tau = Math.max(0, Math.min(1, (t - legStartTime) / legDur));
  r.speedFrac = trainSpeedFrac(tau, legDur);
  r.dist = legStartDist + trainEase(tau, legDur) * (legEndDist - legStartDist);
}

/** Distance along the train's route at simulation minute `t`: the single
    position model behind the dots, the flow lighting and the corridor. */
export function trainDistAt(pt: PrepTrain, t: number): number {
  trainState(pt, t);
  return trainScratch.dist;
}

/** Inverse of trainDistAt: the first minute the train has reached `dist`,
    found by bisecting the easing curve within the leg that contains it. */
function timeAtDist(pt: PrepTrain, dist: number): number {
  let legStartDist = 0;
  let legStartTime = pt.depMins;
  let legEndDist = pt.totalDist;
  let legEndTime = pt.arrMins;
  const stops = pt.stops;
  if (stops) {
    for (let si = 0; si < stops.length; si++) {
      const st = stops[si];
      if (dist <= st.dist) {
        legEndDist = st.dist;
        legEndTime = st.arrMins;
        break;
      }
      legStartDist = st.dist;
      legStartTime = st.depMins !== null ? st.depMins : st.arrMins;
    }
  }
  const span = legEndDist - legStartDist;
  if (span <= 0) return legEndTime;
  const frac = Math.max(0, Math.min(1, (dist - legStartDist) / span));
  const legDur = Math.max(1, legEndTime - legStartTime);
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 14; it++) {
    const mid = (lo + hi) / 2;
    if (trainEase(mid, legDur) < frac) lo = mid;
    else hi = mid;
  }
  return legStartTime + hi * legDur;
}

/** Decode a travel-ordered section list: `~s` marks a section walked in reverse. */
function decodeSecs(raw: number[] | undefined): { secs: number[]; revs: Uint8Array } {
  const n = raw ? raw.length : 0;
  const secs: number[] = new Array(n);
  const revs = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = raw![i];
    if (v < 0) {
      secs[i] = ~v;
      revs[i] = 1;
    } else {
      secs[i] = v;
    }
  }
  return { secs, revs };
}

interface TrainEntries {
  secs: number[];
  times: number[];
}

export function buildDayTimeline(
  cur: OriginVM,
  atlas: AtlasVM,
): DayTimelineVM {
  const secSet = atlas.sec;
  const stepMins = 5;

  const rawTrains = cur.deps || [];

  if (!secSet || !secSet.len) {
    const empty: DayTimelineVM = {
      stepMins,
      numSteps: 12,
      totalMins: 60,
      totalDays: 1,
      secFlowSteps: new Map(),
      maxFlowSteps: new Uint16Array(12),
      getActiveTrains: () => [],
      getPrepTrain: () => undefined,
      totalTrains: 0,
      getDepartedCount: () => 0,
      getArrivedCount: () => 0,
      subset: () => empty,
    };
    return empty;
  }

  const { secLengths, secCumLens } = getSecGeometry(secSet);

  // Every origin flow section gets a step array, even if no dot enters it.
  const flowSecs = (cur.flows || []).map((f) => f.s);

  interface RawStopCall {
    cityZh: string;
    cityEn: string;
    pt: [number, number];
    arrMins: number;
    depMins: number | null;
    isTerm: boolean;
    secCnt: number;
  }
  const callsByTrain = new Map<number, RawStopCall[]>();
  if (cur.dests && cur.o.calls) {
    const rawCalls = cur.o.calls;
    for (let di = 0; di < rawCalls.length; di++) {
      const destCalls = rawCalls[di] || [];
      const dest = cur.dests[di];
      if (!dest) continue;
      for (let ci = 0; ci < destCalls.length; ci++) {
        const c = destCalls[ci];
        const trainIdx = c[0];
        let list = callsByTrain.get(trainIdx);
        if (!list) {
          list = [];
          callsByTrain.set(trainIdx, list);
        }
        list.push({
          cityZh: dest.zh,
          cityEn: dest.en,
          pt: dest.pt,
          arrMins: c[3] * 1440 + c[1],
          depMins: c[4] === 1 ? null : c[3] * 1440 + c[2],
          isTerm: c[4] === 1,
          secCnt: c[5] !== undefined ? c[5] : (rawTrains[trainIdx]?.secs.length ?? 0),
        });
      }
    }
  }

  const prepTrains: PrepTrain[] = [];
  // Per train: each distinct section it covers and the minute its dot first
  // enters it (the flow lighting). Kept so a filtered subset re-tallies
  // flows without re-deriving any geometry.
  const trainEntries: TrainEntries[] = [];

  for (let ti = 0; ti < rawTrains.length; ti++) {
    const train = rawTrains[ti];
    const routeSecs = train.secs || [];

    const secRevs = train.secRevs;
    const nSecs = routeSecs.length;
    const endPt = (i: number, atEnd: boolean): [number, number] => {
      const sec = routeSecs[i];
      const k = atEnd !== (secRevs[i] === 1) ? secSet.len[sec] - 1 : 0;
      return [secSet.pts[secSet.off[sec] + k * 2], secSet.pts[secSet.off[sec] + k * 2 + 1]];
    };

    // Legs without track geometry get a virtual length in distance space: at
    // the widest join inside the leg's [s0, s1] window (one per join), as long
    // as the crow-flies gap there. The dot crosses it on a straight line.
    const virt = new Float64Array(nSecs + 1);
    for (const leg of train.chordLegs || []) {
      let bestJ = -1;
      let bestGap = 0;
      for (let j = Math.max(1, leg[1]); j <= Math.min(nSecs - 1, leg[2]); j++) {
        const gap = haversineKm(endPt(j - 1, true), endPt(j, false));
        if (gap > bestGap) {
          bestGap = gap;
          bestJ = j;
        }
      }
      if (bestJ > 0) virt[bestJ] = bestGap;
    }

    let totalDist = 0;
    const secStarts = new Float64Array(nSecs); // where each entry's own track starts
    const chordSpans: ChordSpan[] = [];
    for (let i = 0; i < nSecs; i++) {
      if (virt[i] > 0) {
        const p0 = endPt(i - 1, true);
        const p1 = endPt(i, false);
        chordSpans.push({
          d0: totalDist,
          d1: totalDist + virt[i],
          lon0: p0[0],
          lat0: p0[1],
          lon1: p1[0],
          lat1: p1[1],
        });
        totalDist += virt[i];
      }
      secStarts[i] = totalDist;
      totalDist += secLengths[routeSecs[i]] || 0;
    }

    const dur = train.dur > 0 ? train.dur : 1;
    const depMins =
      typeof train.depMins === "number" && train.depMins >= 0
        ? train.depMins
        : 0;
    const arrMins = depMins + dur;

    const fromStation = train.fsZh || "";
    const fromStationEn = train.fsEn || "";
    const toStation = train.tsZh || "";
    const toStationEn = train.tsEn || "";
    const depTime = train.dep || "";
    const arrTime = train.arr || "";

    const trainCalls = callsByTrain.get(ti) || [];
    trainCalls.sort((a, b) => a.arrMins - b.arrMins);

    const stops: PrepTrainStop[] = [];
    if (trainCalls.length > 0 && routeSecs.length > 0) {
      let prevDist = 0;
      for (let ci = 0; ci < trainCalls.length; ci++) {
        const call = trainCalls[ci];
        if (call.isTerm) {
          stops.push({
            cityZh: call.cityZh,
            cityEn: call.cityEn,
            arrMins: call.arrMins,
            depMins: null,
            dist: totalDist,
            isTerm: true,
          });
          continue;
        }
        // Exact: the route position where this call's leg ends.
        // Calls sharing one join with a chord ahead of them stop before it; the
        // last one stops after it (a stop's dot sits on the near side of the gap
        // it departs across).
        const k = call.secCnt;
        const next = trainCalls[ci + 1];
        const beforeGap = k < nSecs && virt[k] > 0 && next !== undefined && !next.isTerm && next.secCnt === k;
        const dist = Math.max(
          prevDist,
          k >= nSecs ? totalDist : beforeGap ? secStarts[k] - virt[k] : secStarts[k],
        );
        prevDist = dist;
        stops.push({
          cityZh: call.cityZh,
          cityEn: call.cityEn,
          arrMins: call.arrMins,
          depMins: call.depMins,
          dist,
          isTerm: false,
        });
      }
    }

    prepTrains.push({
      code: train.code,
      cls: train.cls,
      fromStation,
      fromStationEn,
      toStation,
      toStationEn,
      depTime,
      arrTime,
      depMins,
      arrMins,
      dur,
      totalDist,
      secs: routeSecs,
      secStarts,
      secRevs,
      stops: stops.length > 0 ? stops : undefined,
      chordSpans: chordSpans.length > 0 ? chordSpans : undefined,
    });

    // Each section counts once per train, from the minute the dot first
    // enters it.
    const seenSecs = new Set<number>();
    const ptLast = prepTrains[prepTrains.length - 1];
    const entrySecs: number[] = [];
    const entryTimes: number[] = [];
    for (let i = 0; i < routeSecs.length; i++) {
      const s_i = routeSecs[i];
      if (seenSecs.has(s_i)) continue;
      seenSecs.add(s_i);
      entrySecs.push(s_i);
      entryTimes.push(timeAtDist(ptLast, secStarts[i]));
    }
    trainEntries.push({ secs: entrySecs, times: entryTimes });
  }

  return assembleTimeline(prepTrains, trainEntries, flowSecs);

  /** The timeline of `trains`: bar length, cumulative flow per section and
      step, and the per-frame queries. Cheap enough to rerun per filter. */
  function assembleTimeline(
    trains: PrepTrain[],
    entries: TrainEntries[],
    initSecs: number[],
  ): DayTimelineVM {
    // Track max arrival time across all services (ending time of the bar varies depending on the last train)
    let maxArrMins = 0;
    for (let ti = 0; ti < trains.length; ti++) {
      if (trains[ti].arrMins > maxArrMins) maxArrMins = trains[ti].arrMins;
    }
    const totalMins = Math.max(60, Math.ceil(maxArrMins / 5) * 5);
    const totalDays = Math.max(1, Math.ceil(totalMins / 1440));
    const numSteps = Math.ceil(totalMins / stepMins);
    const secFlowSteps = new Map<number, Uint16Array>();
    const maxFlowSteps = new Uint16Array(numSteps);
    for (const s of initSecs) {
      if (!secFlowSteps.has(s)) secFlowSteps.set(s, new Uint16Array(numSteps));
    }

    // Count each entry at its start step, then accumulate per section. Clamp
    // startStep to [0, numSteps - 1] so that late-departing trains that
    // traverse sections into the following day contribute their full flow
    // count by the last step.
    for (let ti = 0; ti < entries.length; ti++) {
      const { secs, times } = entries[ti];
      for (let k = 0; k < secs.length; k++) {
        let stepArr = secFlowSteps.get(secs[k]);
        if (!stepArr) {
          stepArr = new Uint16Array(numSteps);
          secFlowSteps.set(secs[k], stepArr);
        }
        stepArr[Math.min(numSteps - 1, Math.max(0, Math.ceil(times[k] / stepMins)))]++;
      }
    }
    for (const arr of secFlowSteps.values()) {
      for (let step = 1; step < numSteps; step++) arr[step] += arr[step - 1];
    }

    // Max flow across all sections at each 5-min step
    for (let step = 0; step < numSteps; step++) {
      let m = 0;
      for (const arr of secFlowSteps.values()) {
        if (arr[step] > m) m = arr[step];
      }
      maxFlowSteps[step] = m;
    }

    function getActiveTrains(tMins: number): ActiveTrainVM[] {
      const active: ActiveTrainVM[] = [];
      for (let i = 0; i < trains.length; i++) {
        const pt = trains[i];
        // 10 min pre-departure boarding dwell at origin
        const boardStart = Math.max(0, pt.depMins - 10);
        // 8 min disembarkation dwell at final terminus
        const termEnd = pt.arrMins + 8;
        if (
          tMins < boardStart ||
          tMins > termEnd ||
          pt.totalDist <= 0 ||
          pt.secs.length === 0
        ) {
          continue;
        }

        trainState(pt, tMins);
        const targetDist = trainScratch.dist;
        const speedFrac = trainScratch.speedFrac;
        const dw = trainScratch.dwell;
        const isDwelling = dw !== 0;
        let dwellStation: string | undefined;
        let dwellStationEn: string | undefined;
        let dwellStatus: "origin" | "stop" | "dest" | undefined;
        let dwellDetail: string | undefined;
        if (dw === 1) {
          dwellStation = pt.fromStation;
          dwellStationEn = pt.fromStationEn;
          dwellStatus = "origin";
          dwellDetail = `Departs ${pt.depTime}`;
        } else if (dw === 3) {
          dwellStation = pt.toStation;
          dwellStationEn = pt.toStationEn;
          dwellStatus = "dest";
          dwellDetail = "Final Destination";
        } else if (dw === 2 && trainScratch.stop) {
          const st = trainScratch.stop;
          dwellStation = st.cityZh;
          dwellStationEn = st.cityEn;
          dwellStatus = "stop";
          dwellDetail = `${fmtClock(st.arrMins)} - ${fmtClock(st.depMins!)}`;
        }

        if (pt.chordSpans) {
          let span: ChordSpan | undefined;
          for (const c of pt.chordSpans) {
            if (targetDist >= c.d0 && targetDist <= c.d1 && c.d1 > c.d0) {
              span = c;
              break;
            }
          }
          if (span) {
            const a = (targetDist - span.d0) / (span.d1 - span.d0);
            active.push({
              lon: span.lon0 + a * (span.lon1 - span.lon0),
              lat: span.lat0 + a * (span.lat1 - span.lat0),
              heading: Math.atan2(span.lat1 - span.lat0, span.lon1 - span.lon0),
              cls: pt.cls,
              code: pt.code,
              fromStation: pt.fromStation,
              fromStationEn: pt.fromStationEn,
              toStation: pt.toStation,
              toStationEn: pt.toStationEn,
              depTime: pt.depTime,
              arrTime: pt.arrTime,
              durMins: pt.dur,
              progressPct: Math.round((Math.max(0, Math.min(pt.totalDist, targetDist)) / Math.max(1, pt.totalDist)) * 100),
              isDwelling,
              dwellStation,
              dwellStationEn,
              dwellStatus,
              dwellDetail,
              speedFrac,
              curDist: targetDist,
              onChord: true,
            });
            continue;
          }
        }

        // Find which section in the route
        let secIdx = 0;
        while (
          secIdx < pt.secs.length - 1 &&
          pt.secStarts[secIdx + 1] <= targetDist
        ) {
          secIdx++;
        }
        const s = pt.secs[secIdx];
        const distInSec = targetDist - pt.secStarts[secIdx];
        const isSecRev = pt.secRevs[secIdx] === 1;
        const sLen = secLengths[s] || 0;
        // If traversed in reverse, effective distance along vertices starts from the end
        const distInSecEffective = isSecRev
          ? Math.max(0, Math.min(sLen, sLen - distInSec))
          : distInSec;

        // Find which segment within section s
        const off = secSet.off[s];
        const cnt = secSet.len[s];
        if (cnt <= 1) {
          if (cnt === 1) {
            active.push({
              lon: secSet.pts[off],
              lat: secSet.pts[off + 1],
              heading: 0,
              cls: pt.cls,
              code: pt.code,
              fromStation: pt.fromStation,
              fromStationEn: pt.fromStationEn,
              toStation: pt.toStation,
              toStationEn: pt.toStationEn,
              depTime: pt.depTime,
              arrTime: pt.arrTime,
              durMins: pt.dur,
              progressPct: Math.round((Math.max(0, Math.min(pt.totalDist, targetDist)) / Math.max(1, pt.totalDist)) * 100),
              isDwelling,
              dwellStation,
              dwellStationEn,
              dwellStatus,
              dwellDetail,
              speedFrac,
              curDist: targetDist,
            });
          }
          continue;
        }

        const cum = secCumLens[s];
        let k = 0;
        while (k < cnt - 2 && cum[k + 1] < distInSecEffective) {
          k++;
        }
        const segLen = cum[k + 1] - cum[k];
        const segAlpha =
          segLen > 0
            ? Math.max(0, Math.min(1, (distInSecEffective - cum[k]) / segLen))
            : 0;
        const lon0 = secSet.pts[off + k * 2];
        const lat0 = secSet.pts[off + k * 2 + 1];
        const lon1 = secSet.pts[off + (k + 1) * 2];
        const lat1 = secSet.pts[off + (k + 1) * 2 + 1];
        const lon = lon0 + segAlpha * (lon1 - lon0);
        const lat = lat0 + segAlpha * (lat1 - lat0);

        // Traversal heading: if reversed, movement vector is (lon0 - lon1, lat0 - lat1)
        const dLon = isSecRev ? lon0 - lon1 : lon1 - lon0;
        const dLat = isSecRev ? lat0 - lat1 : lat1 - lat0;
        const heading = Math.atan2(dLat, dLon);

        active.push({
          lon,
          lat,
          heading,
          cls: pt.cls,
          code: pt.code,
          fromStation: pt.fromStation,
          fromStationEn: pt.fromStationEn,
          toStation: pt.toStation,
          toStationEn: pt.toStationEn,
          depTime: pt.depTime,
          arrTime: pt.arrTime,
          durMins: pt.dur,
          progressPct: Math.round((Math.max(0, Math.min(pt.totalDist, targetDist)) / Math.max(1, pt.totalDist)) * 100),
          isDwelling,
          dwellStation,
          dwellStationEn,
          dwellStatus,
          dwellDetail,
          speedFrac,
          curDist: targetDist,
        });
      }
      return active;
    }

    function getDepartedCount(tMins: number): number {
      let count = 0;
      for (let i = 0; i < trains.length; i++) {
        if (trains[i].depMins <= tMins) {
          count++;
        }
      }
      return count;
    }

    function getArrivedCount(tMins: number): number {
      let count = 0;
      for (let i = 0; i < trains.length; i++) {
        if (trains[i].arrMins <= tMins) {
          count++;
        }
      }
      return count;
    }

    const prepMap = new Map<string, PrepTrain>();
    for (let i = 0; i < trains.length; i++) {
      prepMap.set(trains[i].code, trains[i]);
    }

    return {
      stepMins,
      numSteps,
      totalMins,
      totalDays,
      secFlowSteps,
      maxFlowSteps,
      getActiveTrains,
      getPrepTrain: (code: string) => prepMap.get(code),
      totalTrains: trains.length,
      getDepartedCount,
      getArrivedCount,
      subset: (codes: Set<string>) => {
        const subTrains: PrepTrain[] = [];
        const subEntries: TrainEntries[] = [];
        for (let i = 0; i < trains.length; i++) {
          if (!codes.has(trains[i].code)) continue;
          subTrains.push(trains[i]);
          subEntries.push(entries[i]);
        }
        return assembleTimeline(subTrains, subEntries, []);
      },
    };
  }
}

/** Return a derived OriginVM filtered to the selected train classes,
    departure/arrival hour, journey distance bin, or journey duration bin.
    Preserves `o` reference identity so MapCanvas redraws in place without
    resetting camera zoom/pan. */
export function filterOrigin(
  cur: OriginVM,
  criteria: OriginFilterCriteria,
): OriginVM {
  const {
    classes = [],
    hour = null,
    hours = null,
    distBin = null,
    distBins = null,
    durBin = null,
    durBins = null,
    trainCodes = null,
    unit = "km",
  } = criteria;

  const activeHours: number[] =
    hours && hours.length > 0
      ? hours
      : hour !== null && hour !== undefined
        ? [hour]
        : [];
  const activeDistBins: DistBinFilter[] =
    distBins && distBins.length > 0
      ? distBins
      : distBin
        ? [distBin]
        : [];
  const activeDurBins: DurBinFilter[] =
    durBins && durBins.length > 0
      ? durBins
      : durBin
        ? [durBin]
        : [];
  const activeTrainCodes: string[] =
    trainCodes && trainCodes.length > 0 ? trainCodes : [];

  const hasClassFilter = classes.length > 0;
  const hasHourFilter = activeHours.length > 0;
  const hasDistFilter = activeDistBins.length > 0;
  const hasDurFilter = activeDurBins.length > 0;
  const hasTrainFilter = activeTrainCodes.length > 0;

  const hasAnyFilter =
    hasClassFilter ||
    hasHourFilter ||
    hasDistFilter ||
    hasDurFilter ||
    hasTrainFilter;
  if (!hasAnyFilter) return cur;

  const clsIndices = Array.from(new Set(classes.map(classIndex)));
  const hasClass = (cls: string) =>
    !hasClassFilter ||
    classes.includes(cls) ||
    (classes.includes("plain") && classIndex(cls) === 7);

  const trainCodeSet = hasTrainFilter ? new Set(activeTrainCodes) : null;
  const hourSet = hasHourFilter ? new Set(activeHours) : null;

  const matchesDep = (d: DepVM) => {
    if (trainCodeSet && !trainCodeSet.has(d.code)) return false;
    if (!hasClass(d.cls)) return false;
    if (hourSet) {
      const h = parseInt(d.dep.slice(0, 2), 10);
      if (!hourSet.has(h)) return false;
    }
    if (hasDistFilter) {
      const v = unit === "km" ? d.distKm : d.distKm * 0.621371;
      const matched = activeDistBins.some((bin) => {
        const b = Math.min(
          bin.nb - 1,
          Math.max(0, Math.floor(v / bin.size)),
        );
        return b === bin.bin;
      });
      if (!matched) return false;
    }
    if (hasDurFilter) {
      const matched = activeDurBins.some((bin) => {
        const b = Math.min(
          bin.nb - 1,
          Math.max(0, Math.floor(d.dur / bin.size)),
        );
        return b === bin.bin;
      });
      if (!matched) return false;
    }
    return true;
  };

  const matchesArr = (a: ArrVM) => {
    if (trainCodeSet && !trainCodeSet.has(a.code)) return false;
    if (!hasClass(a.cls)) return false;
    if (hourSet) {
      const h = parseInt(a.arr.slice(0, 2), 10);
      if (!hourSet.has(h)) return false;
    }
    if (hasDistFilter) {
      const v = unit === "km" ? a.distKm : a.distKm * 0.621371;
      const matched = activeDistBins.some((bin) => {
        const b = Math.min(
          bin.nb - 1,
          Math.max(0, Math.floor(v / bin.size)),
        );
        return b === bin.bin;
      });
      if (!matched) return false;
    }
    if (hasDurFilter) {
      const matched = activeDurBins.some((bin) => {
        const b = Math.min(
          bin.nb - 1,
          Math.max(0, Math.floor(a.dur / bin.size)),
        );
        return b === bin.bin;
      });
      if (!matched) return false;
    }
    return true;
  };

  const deps = cur.deps.filter(matchesDep);
  const arrs = cur.arrs.filter(matchesArr);

  let flows: FlowVM[];
  if (
    cur.deps.length > 0 &&
    (hasHourFilter || hasDistFilter || hasDurFilter || hasTrainFilter)
  ) {
    const secMap = new Map<number, { n: number; byClass: number[] }>();
    for (const d of deps) {
      const ci = classIndex(d.cls);
      for (const s of new Set(d.secs)) {
        let entry = secMap.get(s);
        if (!entry) {
          entry = { n: 0, byClass: new Array(8).fill(0) };
          secMap.set(s, entry);
        }
        entry.n++;
        if (ci >= 0 && ci < 8) entry.byClass[ci]++;
      }
    }
    flows = Array.from(secMap.entries()).map(([s, { n, byClass }]) => ({
      s,
      n,
      byClass,
    }));
    flows.sort((a, b) => b.n - a.n);
  } else {
    flows = cur.flows
      .map((f) => {
        let n = 0;
        for (const ci of clsIndices) n += f.byClass[ci] || 0;
        return { s: f.s, n, byClass: f.byClass };
      })
      .filter((f) => f.n > 0)
      .sort((a, b) => b.n - a.n);
  }

  let inFlows: FlowVM[];
  if (
    cur.arrs.length > 0 &&
    (hasHourFilter || hasDistFilter || hasDurFilter || hasTrainFilter)
  ) {
    const secMap = new Map<number, { n: number; byClass: number[] }>();
    for (const a of arrs) {
      const ci = classIndex(a.cls);
      for (const s of new Set(a.secs)) {
        let entry = secMap.get(s);
        if (!entry) {
          entry = { n: 0, byClass: new Array(8).fill(0) };
          secMap.set(s, entry);
        }
        entry.n++;
        if (ci >= 0 && ci < 8) entry.byClass[ci]++;
      }
    }
    inFlows = Array.from(secMap.entries()).map(([s, { n, byClass }]) => ({
      s,
      n,
      byClass,
    }));
    inFlows.sort((a, b) => b.n - a.n);
  } else {
    inFlows = cur.inFlows
      .map((f) => {
        let n = 0;
        for (const ci of clsIndices) n += f.byClass[ci] || 0;
        return { s: f.s, n, byClass: f.byClass };
      })
      .filter((f) => f.n > 0)
      .sort((a, b) => b.n - a.n);
  }

  let dests = cur.dests;
  if (cur.deps.length > 0) {
    dests = [];
    for (const d of cur.dests) {
      const calls = d.calls.filter((c) => c.dep && matchesDep(c.dep));
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
        arrTimes: calls
          .map((c) => (c.arrMins !== undefined ? c.arrMins : -1))
          .filter((t) => t >= 0)
          .sort((a, b) => a - b),
        calls,
      });
    }
    dests.sort((a, b) => b.trains - a.trains);
  }

  let srcs = cur.srcs;
  if (cur.arrs.length > 0) {
    srcs = [];
    for (const s of cur.srcs) {
      const inCalls = s.inCalls.filter((c) => c.arr && matchesArr(c.arr));
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

  const res: OriginVM = {
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

  // The animation of a filtered view runs only the matching trains: built on
  // first use from the full origin's timeline, without re-deriving geometry.
  let timelineCache: DayTimelineVM | undefined;
  Object.defineProperty(res, "timeline", {
    get() {
      if (!timelineCache && deps.length > 0) {
        timelineCache = cur.timeline?.subset(new Set(deps.map((d) => d.code)));
      }
      return timelineCache;
    },
    configurable: true,
    enumerable: true,
  });

  return res;
}

export function filterOriginByClasses(
  cur: OriginVM,
  selectedClasses: string[],
): OriginVM {
  return filterOrigin(cur, { classes: selectedClasses });
}

/** Formats raw schedule integers into human-readable ScheduleStop records */
export function formatScheduleStops(
  schedulesData: SchedulesData | null,
  stationTable: { zh: string; en: string }[],
  t: number,
): ScheduleStop[] | null {
  if (!schedulesData || !schedulesData.schedules) return null;
  const rawStops = schedulesData.schedules[t];
  if (!rawStops || rawStops.length === 0) return null;

  return rawStops.map(([stIdx, arrMins, depMins, dayOff, legKm]) => {
    let stZh = "";
    let stEn = "";
    if (stIdx < stationTable.length) {
      stZh = stationTable[stIdx].zh;
      stEn = stationTable[stIdx].en;
    } else {
      const extraIdx = stIdx - stationTable.length;
      stZh =
        schedulesData.extra_stations[extraIdx] ||
        (extraIdx >= 0 ? `Station ${stIdx}` : "");
      stEn = stZh;
    }
    const arr = arrMins >= 0 ? fmtClock(arrMins) : "—";
    const dep = depMins >= 0 ? fmtClock(depMins) : "—";
    const dwellMins =
      arrMins >= 0 && depMins >= 0 ? Math.max(0, depMins - arrMins) : 0;
    return {
      stIdx,
      stZh,
      stEn,
      arr,
      dep,
      arrMins,
      depMins,
      dayOff,
      dwellMins,
      legKm: typeof legKm === "number" ? legKm : 0,
    };
  });
}
