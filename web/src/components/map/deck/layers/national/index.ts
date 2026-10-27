/* National-mode layers (D13 map-only mode), split by concern:

     ./timeline.ts  the timeline, the filter selection, keep masks, the isolated train
     ./trains.ts    the dots, tails, dwell rings, emphasis rings and the isolated run
     ./flows.ts     the flows (B / A+B), the section highlight, the infrastructure overlay
     ./cities.ts    the city circles, their growth and the label candidates

   Module-level memos (each is private to this chunk, C23) and what invalidates it:

     timeline.ts  built       (atlas, trains file) identity
                  viewMemo    (atlas, flows pack, index pack, filter key)
                  keepMemo    (timeline, selection) identity
                  isoMemo     (timeline, train code)
     trains.ts    pool        timeline identity (buffers regrow with it)
                  corridorMemo  WeakMap timeline -> train row -> sampled path
     flows.ts     dayMemo     (flows pack, view key, theme)
                  atMemo      (day pass, entries pack, entry tick)
                  infraMemo   WeakMap by the drawn counts array
     cities.ts    eventsMemo  WeakMap by the view
                  rankMemo    WeakMap by the counts object
                  labelMemo   WeakMap by the drawn circle set */
import type { Layer } from "@deck.gl/core";
import { isoFlowAlpha, stationT } from "../../../../../lib";
import type { NatFilter } from "../../../../../lib";
import type { MapCtx } from "../../../context";
import type { DeckStats } from "../../DeckHost";
import { nationalCityDots, nationalCityLayers, natViewEvents } from "./cities";
import { nationalFlowLayers, nationalHighlight, nationalInfraLayers } from "./flows";
import { nationalIsolated, nationalKeep, nationalTimeline, natView } from "./timeline";
import { nationalCorridor, nationalFrame, nationalLayers, nationalRings } from "./trains";

export * from "./cities";
export * from "./flows";
export * from "./timeline";
export * from "./trains";

const NO_FILTER: NatFilter = { classes: [], hours: [], distBins: [], durBins: [], trainCodes: [], unit: "km" };

/** The national view's layers over the backdrop (D13 map-only mode): the national flows
    (B / A+B), the city circles and every national train; no origin flows, stations,
    selection or isolation. Also refreshes the national fields of the shared state and stats. */
export function nationalBuildLayers(M: MapCtx, stats: DeckStats): Layer[] {
  const { P, S } = M;
  const atlas = P.current.atlas;
  if (!atlas) return [];
  const layers: Layer[] = [];
  const st = S.current;
  const { flows: withFlows, trains: withTrains } = P.current.nationalLayers ?? { flows: true, trains: false };
  const nf = P.current.nationalFlows;
  const filter = P.current.nationalFilter ?? NO_FILTER;
  const view = natView(atlas, nf ?? null, P.current.nationalIndex ?? null, filter);
  stats.natFlows = 0;
  st.natCities = null;
  st.natCounts = null;
  st.natLoop = null;
  // An isolated train: its run and its dot over the faded flows, as in the origin view (circles step aside).
  const isoCode = P.current.isolatedTrainCode;
  const tlAll = isoCode ? nationalTimeline(atlas, P.current.nationalTrains) : null;
  const iso = isoCode && tlAll ? nationalIsolated(atlas, tlAll.tl, isoCode) : null;
  if (iso && tlAll) st.natLoop = { start: tlAll.tl.start[iso.q], dur: tlAll.tl.end[iso.q] - tlAll.tl.start[iso.q] };
  const flowAlpha = iso ? isoFlowAlpha(P.current.dark) : 1;
  if (withFlows && nf && (!withTrains || P.current.nationalEntries)) {
    // A+B: cumulative since 00:00 (D7), by entry tick (the file's sub-minute step, so sections
    // light up smoothly with the clock); 24:00 is the day's totals. The entry ticks know only
    // the class, so an index filter draws the day's totals.
    const tpm = P.current.nationalEntries?.ticks_per_min ?? 1;
    const minute = withTrains && !view.indexed ? Math.min(1440, Math.floor(Math.max(0, st.animTime) * tpm) / tpm) : null;
    const fl = nationalFlowLayers({
      atlas,
      nf,
      ne: P.current.nationalEntries ?? null,
      minute,
      classes: filter.classes,
      view,
      dark: P.current.dark,
      scale: st.view.scale,
      fitScale: st.fitScale,
      alpha: flowAlpha,
    });
    layers.push(...fl.layers);
    stats.natFlows = fl.sections;
    st.natCounts = fl.counts;
    if (fl.updateMs > 0) {
      stats.natFlowsMs = fl.updateMs;
      stats.natFlowsUpdates++;
    }
  }
  // The infrastructure overlay over the flows (as in the origin view), under the circles.
  if (withFlows && nf && P.current.showInfra) layers.push(...nationalInfraLayers(atlas, view.counts, P.current.dark, flowAlpha));
  if (iso && tlAll) layers.push(...nationalCorridor(tlAll.tl, atlas, iso.q));
  if (!iso && withFlows && nf) {
    // The city circles ride with the flows (day totals, whatever the clock).
    // With the clock running (flows + trains) the circles grow as the trains stop there.
    const ev = withTrains ? natViewEvents(view, nf, P.current.nationalIndex ?? null) : null;
    const growth = ev ? { ev, t: Math.min(1440, Math.max(0, st.animTime)) } : null;
    st.natCities = nationalCityDots(atlas, nf, view.cities, stationT(st.view, st.fitScale), st.view.scale / st.fitScale, growth);
    const hv = st.hover;
    if (hv && hv.kind === "seg") layers.push(...nationalHighlight(atlas, hv.s, hv.n, st.view.scale, st.fitScale, P.current.dark));
    if (st.natCities) layers.push(...nationalCityLayers(st.natCities, P.current.dark, hv && hv.kind === "natCity" ? hv.idx : -1));
  }
  const built = withTrains ? nationalTimeline(atlas, P.current.nationalTrains) : null;
  if (!built) {
    st.natN = st.natRunning = stats.natDots = 0;
    st.natPick = null;
    return layers;
  }
  const keep = iso ? iso.keep : nationalKeep(built.tl, view.sel);
  const f = nationalFrame(built.tl, atlas, ((st.animTime % 1440) + 1440) % 1440, st.view.scale, keep);
  let kept = built.tl.n;
  if (keep) {
    kept = 0;
    for (let q = 0; q < keep.length; q++) kept += keep[q];
  }
  st.natN = kept;
  st.natRunning = f.running;
  stats.natBuildMs = built.ms;
  stats.natDots = f.count;
  st.natPick = { tl: built.tl, count: f.count, buf: f.pos, qOf: f.qOf, m: ((st.animTime % 1440) + 1440) % 1440 };
  layers.push(...nationalLayers(f, !st.animPlaying, !!iso));
  layers.push(
    ...nationalRings(f, built.tl, atlas, {
      hover: st.hover && st.hover.kind === "train" ? st.hover.train.code : null,
      selected: P.current.selectedTrainCode,
      isolated: iso ? isoCode : null,
    }),
  );
  return layers;
}
