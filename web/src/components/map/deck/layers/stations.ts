/* Station layers: city dots (size from arrivals, dimming under a selected
   destination), golden arrival ripples, selection / hover rings and the origin
   disc, as ScatterplotLayers. Mirrors the former Canvas drawStations; the
   decisions (radius, growth, alpha, ripple) come from lib/mapModel
   stationStates, so both renderers agree.

   ScatterplotLayer strokes are centred on `radius` (C17), as Canvas strokes
   are centred on `r`, so getRadius = r and getLineWidth = the Canvas
   lineWidth. The origin's diamond is drawn on the label overlay. No module
   state shared with the entry bundle (C23).

   A "box" skin draws every marker here (dots, ripples, rings, the origin) as
   a square of the circle's area (BoxLayer, markerRadius); the dots' r stays
   the circle radius. */
import type { Layer } from "@deck.gl/core";
import type { CityPointVM } from "../../../../types";
import { dotPlaces, rgba, splitRadius, stationZoomK } from "../../../../lib";
import type { MapStyle, RGBA, StationState } from "../../../../lib";
import type { Closeup } from "../../closeup";
import { markerLayer, markerRadius } from "../BoxLayer";

interface StationDot {
  c: CityPointVM;
  pos: [number, number];
  /** Drawn radius in px: base radius times the zoom growth. */
  r: number;
  fill: RGBA;
  line: RGBA;
  /** Edge stroke width in px (the style's marker.edgeWidth). */
  lw: number;
}

interface Ring {
  pos: [number, number];
  r: number;
  w: number;
  col: RGBA;
}

export interface Ripple {
  pos: [number, number];
  r: number;
  col: RGBA;
}

const withAlpha = (c: RGBA, a: number): RGBA => [c[0], c[1], c[2], Math.round(c[3] * a)];

/** Where city `c`'s dot(s) are drawn: one, or one per station while it splits. */
const placesOf = (c: CityPointVM, cu: Closeup | null | undefined) =>
  dotPlaces([c.pt[0], c.pt[1]], cu?.byCity.get(c.zh), cu?.k ?? 0);

/** Dots in Canvas paint order (lit cities only): with a destination selected
    the dimmed cities first, then the full-opacity ones on top; otherwise
    `states` order. A city that splits into its stations draws one dot per
    station, sharing the city's area. */
export function stationDots(states: StationState[], style: MapStyle, hasDest: boolean, cu?: Closeup | null): StationDot[] {
  const edge = style.ink.dotEdge.rgba;
  const lw = style.marker.edgeWidth;
  const mk = (s: StationState): StationDot[] => {
    const fill = withAlpha(rgba(style.enc.nodeColor.color(s.c.fastest, style.pal)), s.alpha);
    const line = withAlpha(edge, s.alpha);
    return placesOf(s.c, cu).map((p) => ({ c: s.c, pos: p.pos, r: splitRadius(s.r0 * s.kd, p.f), fill, line, lw }));
  };
  const min = style.marker.minRadius;
  // Small markers drop out (marker.minRadius) unless they belong to a selected destination's view.
  const lit = states.filter((s) => s.lit && (min <= 0 || (hasDest && s.alpha === 1) || s.r0 * s.kd >= min));
  if (!hasDest) return lit.flatMap(mk);
  const out: StationDot[] = [];
  for (const s of lit) if (s.alpha < 1) out.push(...mk(s));
  for (const s of lit) if (s.alpha === 1) out.push(...mk(s));
  return out;
}

const RIPPLE_GROW = 0.8;
const RIPPLE_MIN = 3;

/** Golden arrival ripples, sized to the circle as it is at that moment (its
    radius grows with arrivals while animating): the ring starts at the
    circle's edge and spreads by RIPPLE_GROW of the current radius (at
    least RIPPLE_MIN px, so the smallest circles still show it), alpha
    `1 − frac`. */
export function stationRipples(states: StationState[], style: MapStyle, cu?: Closeup | null): Ripple[] {
  const out: Ripple[] = [];
  for (const s of states) {
    if (!s.ripple) continue;
    for (const p of placesOf(s.c, cu)) out.push(rippleRing(p.pos, splitRadius(s.r0 * s.kd, p.f), s.ripple.frac, style));
  }
  return out;
}

/** One ripple ring for a circle of drawn radius `r` at `frac` (0..1) of its
    life (also the national city circles'). */
export function rippleRing(pos: [number, number], r: number, frac: number, style: MapStyle): Ripple {
  return {
    pos,
    r: r + frac * Math.max(RIPPLE_MIN, r * RIPPLE_GROW),
    col: rgba(style.ink.ripple.css, Math.max(0, 1 - frac)),
  };
}

/** Selected-destination ring, hovered station ring, hovered origin ring. */
export function stationRings(opts: {
  panelDest: CityPointVM | null;
  hoverStation: CityPointVM | null;
  hoverOrigin: boolean;
  originPt: [number, number];
  /** The origin's dot(s): `originPt`, or one per station while it splits. */
  originPlaces?: [number, number][];
  sk: number;
  style: MapStyle;
  closeup?: Closeup | null;
}): Ring[] {
  const ink = opts.style.ink.ring.rgba;
  const rings: Ring[] = [];
  const size = opts.style.enc.nodeSize;
  const grown = (c: CityPointVM) => size.radius(c.trains) * stationZoomK(size.radius(c.trains), opts.sk);
  // The gap to the marker stays `extra` px whatever its shape.
  const mr = (r: number) => markerRadius(opts.style, r);
  const around = (c: CityPointVM, extra: number, w: number) => {
    for (const p of placesOf(c, opts.closeup)) rings.push({ pos: p.pos, r: mr(splitRadius(grown(c), p.f)) + extra, w, col: ink });
  };
  const pd = opts.panelDest;
  if (pd) around(pd, 3.8, 3);
  const hc = opts.hoverStation;
  if (hc) around(hc, 3.5, 2);
  else if (opts.hoverOrigin) for (const pos of opts.originPlaces ?? [opts.originPt]) rings.push({ pos, r: mr(9) + 5.5, w: 2, col: ink });
  return rings;
}

interface StationLayerInput {
  states: StationState[];
  style: MapStyle;
  hasDest: boolean;
  originPt: [number, number];
  /** The origin's dot(s): one per station while the origin splits (no sizing: each is the origin disc). */
  originPlaces: [number, number][];
  panelDest: CityPointVM | null;
  hoverStation: CityPointVM | null;
  hoverOrigin: boolean;
  sk: number;
  closeup: Closeup | null;
  /** Changes whenever the states can have changed (clock, view zoom, selection, hover, theme). */
  key: string;
  /** Changes with the origin / direction (positions). */
  posKey: string;
}

export function stationLayers(inp: StationLayerInput): Layer[] {
  const { style, key } = inp;
  const dots = stationDots(inp.states, style, inp.hasDest, inp.closeup);
  const ripples = stationRipples(inp.states, style, inp.closeup);
  const rings = stationRings({
    panelDest: inp.panelDest,
    hoverStation: inp.hoverStation,
    hoverOrigin: inp.hoverOrigin,
    originPt: inp.originPt,
    originPlaces: inp.originPlaces,
    sk: inp.sk,
    style,
    closeup: inp.closeup,
  });
  const common = { radiusUnits: "pixels", lineWidthUnits: "pixels", stroked: true } as const;
  const Marker = markerLayer(style);
  const mr = (r: number) => markerRadius(style, r);
  return [
    new Marker<StationDot>({
      ...common,
      id: "stations",
      data: dots,
      filled: true,
      getPosition: (d) => d.pos,
      getRadius: (d) => mr(d.r),
      getFillColor: (d) => d.fill,
      getLineColor: (d) => d.line,
      getLineWidth: (d) => d.lw,
      pickable: true,
      updateTriggers: {
        getPosition: inp.posKey + "|" + key,
        getRadius: key,
        getFillColor: key,
        getLineColor: key,
        getLineWidth: key,
      },
    }),
    new Marker<Ripple>({
      ...common,
      id: "ripples",
      data: ripples,
      filled: false,
      getPosition: (d) => d.pos,
      getRadius: (d) => mr(d.r),
      getLineWidth: 1.5,
      getLineColor: (d) => d.col,
      pickable: false,
      updateTriggers: { getPosition: key, getRadius: key, getLineColor: key },
    }),
    new Marker<[number, number]>({
      ...common,
      id: "origin",
      data: inp.originPlaces,
      filled: true,
      getPosition: (d) => d,
      getRadius: mr(9),
      getLineWidth: 1.5,
      getFillColor: style.ink.originFill.rgba,
      getLineColor: style.ink.originEdge.rgba,
      pickable: true,
      updateTriggers: { getPosition: inp.posKey + "|" + key, getFillColor: style.key, getLineColor: style.key },
    }),
    new Marker<Ring>({
      ...common,
      id: "rings",
      data: rings,
      filled: false,
      getPosition: (d) => d.pos,
      getRadius: (d) => d.r,
      getLineWidth: (d) => d.w,
      getLineColor: (d) => d.col,
      pickable: false,
      updateTriggers: { getPosition: key, getRadius: key, getLineWidth: key, getLineColor: key },
    }),
  ];
}
