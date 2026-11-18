/* Encodings: pure functions that map a pack fact to a visual channel (line
   colour, node colour, node size), registered by name. A skin picks one per
   channel; a new pack column becomes one new entry here, usable by any skin.
   Each takes the facts it reads plus the resolved MapStyle (for its ramp
   colours), never the raw theme. */
import type { Palette } from "../../types";
import { flowColor, natCityR, rampColor, stationR } from "../palette";

/** What a line-colour encoding may read about one drawn section. */
export interface LineFact {
  /** Trains on the section (as drawn: the pass's count). */
  n: number;
  /** The widest count of the pass the section is drawn in (the ramp's top). */
  maxN: number;
}

/** A line-colour encoding. `by` names what the colour depends on, so a layer
    may memoise colours on it: "count" means `color` reads only `n` and `maxN`
    (today's per-count colour cache in buildPassData stays valid). A
    per-section encoding (speedLimit, P2) will add `"section"`. */
export interface LineColorEncoding {
  readonly id: LineColorId;
  readonly by: "count";
  /** CSS colour of the section, from the style's palette. */
  color(f: LineFact, pal: Palette): string;
}

/** A node-colour encoding: the fill of a city marker. */
export interface NodeColorEncoding {
  readonly id: NodeColorId;
  /** CSS colour for a city whose fastest train takes `fastest` minutes
      (undefined when it has none). */
  color(fastest: number | undefined, pal: Palette): string;
}

/** A node-size encoding: a city marker's base radius in CSS px at the
    national fit, before the zoom growth (stationZoomK). */
export interface NodeSizeEncoding {
  readonly id: NodeSizeId;
  radius(n: number): number;
}

export type LineColorId = "volume";
export type NodeColorId = "timeBand" | "flat";
export type NodeSizeId = "directTrains" | "callsAtCity";

/** Line colour by name. */
export const LINE_COLOR: Readonly<Record<LineColorId, LineColorEncoding>> = {
  /** Trains per day: the palette's flowStops ramp on t = sqrt(n / maxN). */
  volume: { id: "volume", by: "count", color: (f, pal) => flowColor(f.n, f.maxN, pal) },
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

/** Node size by name. */
export const NODE_SIZE: Readonly<Record<NodeSizeId, NodeSizeEncoding>> = {
  /** Origin view: direct trains to / from the origin (stationR). */
  directTrains: { id: "directTrains", radius: stationR },
  /** National view: departures + arrivals per day at the city (natCityR). */
  callsAtCity: { id: "callsAtCity", radius: natCityR },
};
