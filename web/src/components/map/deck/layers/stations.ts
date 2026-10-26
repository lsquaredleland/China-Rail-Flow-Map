/* Station layers: city dots (size from arrivals, dimming under a selected
   destination), golden arrival ripples, selection / hover rings and the origin
   disc, as ScatterplotLayers. Mirrors the former Canvas drawStations; the
   decisions (radius, growth, alpha, ripple) come from lib/mapModel
   stationStates, so both renderers agree.

   ScatterplotLayer strokes are centred on `radius` (C17), as Canvas strokes
   are centred on `r`, so getRadius = r and getLineWidth = the Canvas
   lineWidth. The origin's diamond is drawn on the label overlay. No module
   state shared with the entry bundle (C23). */
import type { Layer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { CityPointVM, Palette } from "../../../../types";
import { rampColor, rgba, stationR, stationZoomK } from "../../../../lib";
import type { RGBA, StationState } from "../../../../lib";

export interface StationDot {
  c: CityPointVM;
  pos: [number, number];
  /** Drawn radius in px: base radius times the zoom growth. */
  r: number;
  fill: RGBA;
  line: RGBA;
  /** Edge stroke width in px (Canvas: 3.0 dark, 1.5 light). */
  lw: number;
}

export interface Ring {
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

/** Dots in Canvas paint order (lit cities only): with a destination selected
    the dimmed cities first, then the full-opacity ones on top; otherwise
    `states` order. */
export function stationDots(states: StationState[], pal: Palette, dark: boolean, hasDest: boolean): StationDot[] {
  const edge = rgba(pal.dotEdge);
  const lw = dark ? 3.0 : 1.5;
  const mk = (s: StationState): StationDot => {
    const fill = rgba(typeof s.c.fastest === "number" ? rampColor(s.c.fastest, pal) : pal.dot);
    return {
      c: s.c,
      pos: [s.c.pt[0], s.c.pt[1]],
      r: s.r0 * s.kd,
      fill: withAlpha(fill, s.alpha),
      line: withAlpha(edge, s.alpha),
      lw,
    };
  };
  const lit = states.filter((s) => s.lit);
  if (!hasDest) return lit.map(mk);
  const out: StationDot[] = [];
  for (const s of lit) if (s.alpha < 1) out.push(mk(s));
  for (const s of lit) if (s.alpha === 1) out.push(mk(s));
  return out;
}

const RIPPLE_GROW = 0.8;
const RIPPLE_MIN = 3;

/** Golden arrival ripples, sized to the circle as it is at that moment (its
    radius grows with arrivals while animating): the ring starts at the
    circle's edge and spreads by RIPPLE_GROW of the current radius (at
    least RIPPLE_MIN px, so the smallest circles still show it), alpha
    `1 − frac`. */
export function stationRipples(states: StationState[], dark: boolean): Ripple[] {
  const out: Ripple[] = [];
  const gold = dark ? "#F59E0B" : "#D97706";
  for (const s of states) {
    if (!s.ripple) continue;
    const frac = s.ripple.frac;
    const r = s.r0 * s.kd;
    out.push({
      pos: [s.c.pt[0], s.c.pt[1]],
      r: r + frac * Math.max(RIPPLE_MIN, r * RIPPLE_GROW),
      col: rgba(gold, Math.max(0, 1 - frac)),
    });
  }
  return out;
}

/** Selected-destination ring, hovered station ring, hovered origin ring. */
export function stationRings(opts: {
  panelDest: CityPointVM | null;
  hoverStation: CityPointVM | null;
  hoverOrigin: boolean;
  originPt: [number, number];
  sk: number;
  dark: boolean;
}): Ring[] {
  const ink = rgba(opts.dark ? "#EDEDEA" : "#111111");
  const rings: Ring[] = [];
  const grown = (c: CityPointVM) => stationR(c.trains) * stationZoomK(stationR(c.trains), opts.sk);
  const pd = opts.panelDest;
  if (pd) rings.push({ pos: [pd.pt[0], pd.pt[1]], r: grown(pd) + 3.8, w: 3, col: ink });
  const hc = opts.hoverStation;
  if (hc) rings.push({ pos: [hc.pt[0], hc.pt[1]], r: grown(hc) + 3.5, w: 2, col: ink });
  else if (opts.hoverOrigin) rings.push({ pos: opts.originPt, r: 14.5, w: 2, col: ink });
  return rings;
}

export interface StationLayerInput {
  states: StationState[];
  pal: Palette;
  dark: boolean;
  hasDest: boolean;
  originPt: [number, number];
  panelDest: CityPointVM | null;
  hoverStation: CityPointVM | null;
  hoverOrigin: boolean;
  sk: number;
  /** Changes whenever the states can have changed (clock, view zoom, selection, hover, theme). */
  key: string;
  /** Changes with the origin / direction (positions). */
  posKey: string;
}

export function stationLayers(inp: StationLayerInput): Layer[] {
  const { dark, key } = inp;
  const dots = stationDots(inp.states, inp.pal, dark, inp.hasDest);
  const ripples = stationRipples(inp.states, dark);
  const rings = stationRings({
    panelDest: inp.panelDest,
    hoverStation: inp.hoverStation,
    hoverOrigin: inp.hoverOrigin,
    originPt: inp.originPt,
    sk: inp.sk,
    dark,
  });
  const common = { radiusUnits: "pixels", lineWidthUnits: "pixels", stroked: true } as const;
  return [
    new ScatterplotLayer<StationDot>({
      ...common,
      id: "stations",
      data: dots,
      filled: true,
      getPosition: (d) => d.pos,
      getRadius: (d) => d.r,
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
    new ScatterplotLayer<Ripple>({
      ...common,
      id: "ripples",
      data: ripples,
      filled: false,
      getPosition: (d) => d.pos,
      getRadius: (d) => d.r,
      getLineWidth: 1.5,
      getLineColor: (d) => d.col,
      pickable: false,
      updateTriggers: { getPosition: key, getRadius: key, getLineColor: key },
    }),
    new ScatterplotLayer({
      ...common,
      id: "origin",
      data: [0],
      filled: true,
      getPosition: () => inp.originPt,
      getRadius: 9,
      getLineWidth: 1.5,
      getFillColor: dark ? [237, 237, 234, 255] : [17, 17, 17, 255],
      getLineColor: dark ? [26, 27, 30, 255] : [255, 255, 255, 255],
      pickable: true,
      updateTriggers: { getPosition: inp.posKey, getFillColor: dark, getLineColor: dark },
    }),
    new ScatterplotLayer<Ring>({
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
