/* Encodings: pure functions that map a pack fact to a visual channel (line
   colour, node colour, node size), registered by name. A skin picks one per
   channel; a new pack column becomes one new entry here, usable by any skin.
   Each takes the facts it reads plus the resolved style's ramp colours (the
   palette, the speed-band ramp), never the raw theme: the thresholds and
   rules live here, the colours in the skin. */
import type { Palette } from "../../types";
import { flowColor, natCityR, rampColor, stationR } from "../palette";

/** What a line-colour encoding may read about one drawn section. */
export interface LineFact {
  /** Trains on the section (as drawn: the pass's count). */
  n: number;
  /** The widest count of the pass the section is drawn in (the ramp's top). */
  maxN: number;
  /** The section index in its DecodedSet; -1 when the colour is memoised per
      count (a `by: "count"` encoding never reads it). */
  s: number;
  /** The section's posted speed limit, km/h (DecodedSet.speed); 0 = untagged. */
  speed: number;
}

/** A skin's colours for the speed bands (SPEED_BANDS order, fastest first),
    and the colour of a section with no posted limit. */
export interface SpeedRamp {
  readonly bands: readonly string[];
  readonly untagged: string;
}

/** What a line-colour encoding may read from the resolved style (MapStyle
    satisfies it). */
export interface LineColorStyle {
  readonly pal: Palette;
  readonly speedBands: SpeedRamp;
}

/** A line-colour encoding. `by` names what the colour depends on, so a layer
    may memoise colours on it: "count" means `color` reads only `n` and `maxN`
    (the per-count colour cache in buildPassData stays valid); "section" means
    it reads the section's own facts (`s`, `speed`), memoised per section. */
export interface LineColorEncoding {
  readonly id: LineColorId;
  readonly by: "count" | "section";
  /** The legend card's title when this encoding is the line colour; absent
      when the card keeps its view title (legendTitle). */
  readonly title?: string;
  /** CSS colour of the section, from the style's ramp colours. */
  color(f: LineFact, st: LineColorStyle): string;
}

/** Posted speed-limit bands, fastest first: band i holds `min[i] <= v` (and
    below the previous band's min); a speed under every min, i.e. 0, is
    untagged. Labels are km/h. */
export const SPEED_BANDS: readonly { readonly min: number; readonly label: string }[] = [
  { min: 300, label: "300+" },
  { min: 250, label: "250–299" },
  { min: 200, label: "200–249" },
  { min: 120, label: "120–199" },
  { min: 1, label: "<120" },
];

/** The SPEED_BANDS index of a posted limit in km/h, or -1 when untagged (0). */
export function speedBand(kmh: number): number {
  for (let i = 0; i < SPEED_BANDS.length; i++) if (kmh >= SPEED_BANDS[i].min) return i;
  return -1;
}

/** A node-colour encoding: the fill of a city marker. */
export interface NodeColorEncoding {
  readonly id: NodeColorId;
  /** CSS colour for a city whose fastest train takes `fastest` minutes
      (undefined when it has none). */
  color(fastest: number | undefined, pal: Palette): string;
}

/** A node-size encoding: a radius scale, a city marker's base radius in CSS
    px at the national fit (before the zoom growth, stationZoomK) for the
    count the view gives it. A box marker of the same count has the same area
    (boxSide). */
export interface NodeSizeEncoding {
  readonly id: NodeSizeId;
  radius(n: number): number;
}

export type LineColorId = "volume" | "speedLimit";
export type NodeColorId = "timeBand" | "flat";
export type NodeSizeId = "stationRadius" | "natCityRadius";

/** Line colour by name. */
export const LINE_COLOR: Readonly<Record<LineColorId, LineColorEncoding>> = {
  /** Trains per day: the palette's flowStops ramp on t = sqrt(n / maxN). */
  volume: { id: "volume", by: "count", color: (f, st) => flowColor(f.n, f.maxN, st.pal) },
  /** The section's posted speed limit through the skin's band ramp
      (SPEED_BANDS); `speedBands.untagged` when it has none. */
  speedLimit: {
    id: "speedLimit",
    by: "section",
    title: "Section speed limit",
    color: (f, st) => {
      const b = speedBand(f.speed);
      return b < 0 ? st.speedBands.untagged : st.speedBands.bands[b];
    },
  },
};

/** Node colour by name. */
export const NODE_COLOR: Readonly<Record<NodeColorId, NodeColorEncoding>> = {
  /** Fastest travel time from the origin through the palette's time bands;
      `pal.dot` for a city with no timed train. */
  timeBand: {
    id: "timeBand",
    color: (fastest, pal) => (typeof fastest === "number" ? rampColor(fastest, pal) : pal.dot),
  },
  /** One flat ink for every city (the national view's circles). */
  flat: { id: "flat", color: (_fastest, pal) => pal.dot },
};

/** Node size by name: radius scales, named for the scale, not the count. */
export const NODE_SIZE: Readonly<Record<NodeSizeId, NodeSizeEncoding>> = {
  /** Origin view (stationR, clamped 2..26 px): the count is CityPointVM.trains,
      the trains from (to) the origin that call at the city. */
  stationRadius: { id: "stationRadius", radius: stationR },
  /** National view (natCityR, a strong n^0.35 compression): the count is the
      city's departures + arrivals per day. */
  natCityRadius: { id: "natCityRadius", radius: natCityR },
};

/** The side of a square with the area of a circle of radius r: r * sqrt(pi),
    so a box marker reads the same count as the circle it replaces. */
const SQRT_PI = Math.sqrt(Math.PI);
export const boxSide = (r: number): number => r * SQRT_PI;
