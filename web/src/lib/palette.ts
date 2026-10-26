/* Palettes, the travel-time ramp, flow widths and station radii. */
import type {
  Palette,
  RampStop,
} from "../types";

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

// Night: petrol and saffron as by day; the 12–24h band is lifted from the
// ultramarine (2.0:1 on graphite) to periwinkle #8F9CF2 (6.7:1 on #1A1B1E).
const TIME_BANDS_NIGHT: RampStop[] = [
  [0, [20, 116, 111]],
  [210, [20, 116, 111]],
  [270, [227, 166, 63]],
  [690, [227, 166, 63]],
  [750, [143, 156, 242]],
  [1440, [143, 156, 242]],
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
      ramp: TIME_BANDS_NIGHT,
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

// Width scale: width = k(zoom) * flowUnits(trains/day), k = 0.06 px per
// unit at national-fit scale, with a 0.5 px hairline floor so 1-train
// sections stay visible. flowUnits is the train count itself up to
// WIDTH_KNEE, then grows with its square root (same value and slope at the
// knee), so the busiest corridors don't swamp the map.
export const WIDTH_K = 0.06;
export const WIDTH_KNEE = 40;
const SQRT_KNEE = Math.sqrt(WIDTH_KNEE);
export function flowUnits(n: number): number {
  return n <= WIDTH_KNEE ? n : WIDTH_KNEE + 2 * SQRT_KNEE * (Math.sqrt(n) - SQRT_KNEE);
}
export function flowWidth(n: number, scale: number, fitScale: number): number {
  return Math.max(0.5, flowUnits(n) * WIDTH_K * (scale / fitScale));
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
export const STATION_R_MIN = 2;
export const STATION_R_MAX = 26;
export function stationR(trains: number): number {
  return Math.max(
    STATION_R_MIN,
    Math.min(STATION_R_MAX, 1.3 + Math.sqrt(trains) * 0.55),
  );
}

/** Zoom growth of a dot with base radius r at zoom progress t in [0, 1]:
    1 at t = 0, and at full zoom 3x for the smallest possible dot easing
    linearly to 2x for the largest. */
export function stationZoomK(r: number, t: number): number {
  const kmax = 3 - (r - STATION_R_MIN) / (STATION_R_MAX - STATION_R_MIN);
  return 1 + (kmax - 1) * t;
}

/* ---------- RGBA tuples for WebGL layers ---------- */

export type RGBA = [number, number, number, number];

const rgbaCache = new Map<string, RGBA>();

/** Parses a palette colour (`#rgb`, `#rrggbb`, `rgb(r,g,b)`, `rgba(r,g,b,a)`)
    into a 0-255 `[r, g, b, a]` tuple, the CSS alpha times `alpha`. The tuple is
    cached and shared: callers must not mutate it. */
export function rgba(css: string, alpha = 1): RGBA {
  const key = css + "|" + alpha;
  const hit = rgbaCache.get(key);
  if (hit) return hit;
  let r: number, g: number, b: number, a = 1;
  if (css[0] === "#") {
    const h = css.length === 4 ? css.slice(1).replace(/./g, (x) => x + x) : css.slice(1);
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = css.match(/[\d.]+/g);
    if (!m || m.length < 3) throw new Error("rgba(): unsupported colour " + css);
    r = +m[0];
    g = +m[1];
    b = +m[2];
    if (m.length > 3) a = +m[3];
  }
  const out: RGBA = [r, g, b, Math.round(255 * a * alpha)];
  rgbaCache.set(key, out);
  return out;
}

/** The palette's CSS colours as RGBA tuples (the same values, one parse). */
export function paletteRGBA(dark: boolean) {
  const p = palette(dark);
  return {
    paper: rgba(p.paper),
    network: rgba(p.network),
    graticule: rgba(p.graticule),
    flow: rgba(p.flow),
    flowHi: rgba(p.flowHi),
    chord: rgba(p.chord),
    infraLine: rgba(p.infraLine),
    infraHsr: rgba(p.infraHsr),
    infraConv: rgba(p.infraConv),
    dot: rgba(p.dot),
    dotEdge: rgba(p.dotEdge),
    label: rgba(p.label),
    labelHalo: rgba(p.labelHalo),
    origin: rgba(p.origin),
    outline: rgba(p.outline),
    dashLine: rgba(p.dashLine),
    landFill: rgba(p.landFill),
    /** Dashed Qiongzhou ferry crossing (hard-coded in the Canvas network layer). */
    ferry: rgba(dark ? "#38BDF8" : "#0284C7"),
  };
}
export type PaletteRGBA = ReturnType<typeof paletteRGBA>;
