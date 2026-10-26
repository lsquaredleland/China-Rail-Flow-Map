/* National city circles and their labels: the busiest cities by the day's
   totals (or growing with the clock), the label candidates and the circle
   layers. Memo keys: see ./index.ts. */
import type { Layer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { DecodedAtlas, NationalFlowsPack, NationalIndexPack } from "../../../../../types";
import { natCityEvents, natCityEventsAt, natCityR, natCityTier, palette, rgba, stationZoomK } from "../../../../../lib";
import type { LabelPoint, NatCityEvents } from "../../../../../lib";
import { rippleRing } from "../stations";
import type { Ripple } from "../stations";
import type { NatView } from "./timeline";

/* ---------- national city circles ---------- */

export interface NationalCityDots {
  /** `city_table` index, position, departures, arrivals and drawn radius (px) of each circle. */
  idx: number[];
  pos: [number, number][];
  dep: Uint32Array;
  arr: Uint32Array;
  r: number[];
  /** Per circle, how far (0..1) through its 20-minute golden ripple it is, or
      -1 for none; empty when the circles are not growing with the clock. */
  ripple: number[];
}

/** The ripple lasts this many minutes after a stop event (the origin view's). */
export const NAT_RIPPLE_MIN = 20;

/** The growing circles' input: the selected trains' event minutes per city and
    the clock's minute. A city is drawn from its first event on, sized by the
    events so far (departures + arrivals, all of them at 24:00). */
interface NatGrowth {
  ev: NatCityEvents;
  t: number;
}

/** The per-city event minutes of a view's selection, built once per view. */
const eventsMemo = new WeakMap<NatView, NatCityEvents | null>();
export function natViewEvents(view: NatView, nf: NationalFlowsPack | null, ix: NationalIndexPack | null): NatCityEvents | null {
  if (!nf) return null;
  let ev = eventsMemo.get(view);
  if (ev === undefined) {
    ev = natCityEvents(nf, ix, view.sel);
    eventsMemo.set(view, ev);
  }
  return ev;
}

/* The cities with trains, busiest first (ties by city id), per counts object. */
const rankMemo = new WeakMap<object, number[]>();
function ranked(c: { idx: number[]; dep: Uint32Array; arr: Uint32Array }): number[] {
  let r = rankMemo.get(c);
  if (!r) {
    r = [];
    for (let i = 0; i < c.idx.length; i++) if (c.dep[i] + c.arr[i] > 0) r.push(i);
    r.sort((a, b) => c.dep[b] + c.arr[b] - (c.dep[a] + c.arr[a]) || c.idx[a] - c.idx[b]);
    rankMemo.set(c, r);
  }
  return r;
}

/** A circle per city sized by departures + arrivals under the filters, on
    the radius scale `natCityR` and the origin dots' zoom growth (`stationT`).
    Only the busiest `natCityTier(.., zoom)` cities (by the day's totals, so
    the set does not change with the clock) are drawn (and so pickable).
    Cities with no trains are left out. With `growth` the size is the events
    so far and a city with none yet is left out too, with a ripple when its
    last event was within 20 minutes. Null when the pack carries no `cities`. */
export function nationalCityDots(
  atlas: DecodedAtlas,
  nf: NationalFlowsPack,
  c: { idx: number[]; dep: Uint32Array; arr: Uint32Array },
  stationT: number,
  zoom: number,
  growth: NatGrowth | null = null,
): NationalCityDots | null {
  if (!nf.cities) return null;
  const order = ranked(c);
  const k = natCityTier(order.length, zoom);
  const out: NationalCityDots = { idx: [], pos: [], dep: new Uint32Array(k), arr: new Uint32Array(k), r: [], ripple: [] };
  let n = 0;
  for (let j = 0; j < k; j++) {
    const i = order[j];
    let size = c.dep[i] + c.arr[i];
    let ripple = -1;
    if (growth) {
      const { ev, t } = growth;
      size = natCityEventsAt(ev, i, t);
      if (size === 0) continue;
      const dt = t - ev.minutes[ev.off[i] + size - 1];
      if (dt >= 0 && dt <= NAT_RIPPLE_MIN) ripple = dt / NAT_RIPPLE_MIN;
    }
    const r0 = natCityR(size);
    out.idx.push(c.idx[i]);
    out.pos.push(atlas.data.city_table[c.idx[i]].pt);
    out.dep[n] = c.dep[i];
    out.arr[n] = c.arr[i];
    n++;
    out.r.push(r0 * stationZoomK(r0, stationT));
    if (growth) out.ripple.push(ripple);
  }
  if (n < k) {
    out.dep = out.dep.slice(0, n);
    out.arr = out.arr.slice(0, n);
  }
  return out;
}

/** The label layout was tuned on an origin's per-city train counts (size
    tiers at 50 / 20 / 5 trains); a national city's departures + arrivals are
    about this many times larger, so labels see its count divided by this. */
export const LABEL_TRAINS_PER_UNIT = 10;

/** The drawn cities as label candidates, busiest first (same tiering as the
    circles, so only visible cities are named). Memoised per circle set. */
const labelMemo = new WeakMap<NationalCityDots, LabelPoint[]>();
export function nationalLabelPoints(atlas: DecodedAtlas | null | undefined, d: NationalCityDots): LabelPoint[] {
  let pts = labelMemo.get(d);
  if (!pts && atlas) {
    pts = d.idx.map((idx, i) => {
      const c = atlas.data.city_table[idx];
      return {
        idx,
        zh: c.zh,
        en: c.en,
        pt: c.pt,
        trains: Math.round((d.dep[i] + d.arr[i]) / LABEL_TRAINS_PER_UNIT),
      };
    });
    labelMemo.set(d, pts);
  }
  return pts ?? [];
}

/** The city circles, biggest first so small ones stay on top: a translucent
    fill (so the flows show through) and a thin stroke; the hovered city
    (`hoverIdx`, a `city_table` index) is opaque with a ring. */
export function nationalCityLayers(d: NationalCityDots, dark: boolean, hoverIdx = -1): Layer[] {
  const pal = palette(dark);
  const order = d.idx.map((_, i) => i).sort((a, b) => d.r[b] - d.r[a]);
  const layers: Layer[] = [
    new ScatterplotLayer<number>({
      id: "nat-cities",
      data: order,
      getPosition: (i: number) => d.pos[i],
      getRadius: (i: number) => d.r[i],
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      stroked: true,
      filled: true,
      // The city view's dot colours and edge rule (1.5 px day, 3 px night), thinner on the smallest circles.
      getFillColor: rgba(pal.dot, dark ? 0.4 : 0.35),
      getLineColor: rgba(pal.dotEdge),
      getLineWidth: (i: number) => Math.min(dark ? 3 : 1.5, 0.3 * d.r[i]),
      pickable: false,
      updateTriggers: { getPosition: [d], getRadius: [d], getLineWidth: [d, dark] },
    }),
  ];
  const rip: Ripple[] = [];
  for (let i = 0; i < d.ripple.length; i++) {
    if (d.ripple[i] >= 0) rip.push(rippleRing(d.pos[i], d.r[i], d.ripple[i], dark));
  }
  if (rip.length) {
    layers.push(
      new ScatterplotLayer<Ripple>({
        id: "nat-city-ripples",
        data: rip,
        getPosition: (r: Ripple) => r.pos,
        getRadius: (r: Ripple) => r.r,
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        stroked: true,
        filled: false,
        getLineWidth: 1.5,
        getLineColor: (r: Ripple) => r.col,
        pickable: false,
        updateTriggers: { getPosition: [rip], getRadius: [rip], getLineColor: [rip] },
      }),
    );
  }
  const h = hoverIdx >= 0 ? d.idx.indexOf(hoverIdx) : -1;
  if (h >= 0) {
    layers.push(
      new ScatterplotLayer<number>({
        id: "nat-city-hover",
        data: [h],
        getPosition: (i: number) => d.pos[i],
        getRadius: (i: number) => d.r[i],
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        stroked: true,
        filled: true,
        getFillColor: rgba(pal.dot, 1),
        getLineColor: rgba(pal.dotEdge),
        getLineWidth: 2,
        pickable: false,
        updateTriggers: { getPosition: [d], getRadius: [d] },
      }),
    );
  }
  return layers;
}
