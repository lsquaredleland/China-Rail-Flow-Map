/* Renderer-independent map model. Pure functions of the view-model state
   (never the canvas, camera or DOM), so the deck.gl layers and the pick code
   consume the same decisions: which flow sections are
   shown, at what alpha and scale, which chords and which hover target are
   visible, what the isolated train has lit so far.

   Sections are appended per concern; keep each under its own banner. */
import type {
  ActiveTrainVM,
  ChordVM,
  CityPointVM,
  DayTimelineVM,
  DepVM,
  DestVM,
  Direction,
  FlowVM,
  OriginVM,
  PrepTrain,
  SrcVM,
} from "../types";
import { stationR, stationZoomK } from "./palette";
import type { DestWindow } from "./stopEffects";
import { destWindow, stopArrivalTimes, trainShownAt } from "./stopEffects";
import { trainDistAt } from "./timeline";

/** The slice of app state every model function reads. */
export interface ModelState {
  cur: OriginVM | null;
  baseCur: OriginVM | null | undefined;
  dir: Direction;
  animTime: number;
  animEnabled: boolean;
  showInfra: boolean;
  panelDest: CityPointVM | null;
  /** Isolated train code, if any. */
  iso: string | null | undefined;
  dark: boolean;
}

/** Per-selection memo slots (the engine keeps them on its state object;
    tests pass a fresh one). The model reads and fills them. */
export interface ModelCaches {
  destSecCountsCache: {
    cur: OriginVM | null;
    dest: CityPointVM;
    dir: Direction;
    counts: Map<number, number> | null;
  } | null;
  activeDestCache: {
    cur: OriginVM;
    dest: CityPointVM;
    items: { pt: PrepTrain; entries: { sec: number; pos: number }[] }[];
  } | null;
  chordDepCache: { cur: OriginVM; firstDep: Map<number, number> } | null;
}

export function newModelCaches(): ModelCaches {
  return { destSecCountsCache: null, activeDestCache: null, chordDepCache: null };
}

// --- flows ---------------------------------------------------------------

/** A filtered view (class, histogram or train filter) is a subset of the
    full origin `baseCur`; selecting a city alone is not a filter. */
export function isFilteredView(
  cur: OriginVM | null,
  baseCur: OriginVM | null | undefined,
): boolean {
  if (!cur || !baseCur || cur === baseCur) return false;
  return (
    cur.deps.length !== baseCur.deps.length ||
    cur.arrs.length !== baseCur.arrs.length ||
    cur.flows.length !== baseCur.flows.length ||
    cur.maxFlow !== baseCur.maxFlow
  );
}

/** Inbound has no timeline: the animation is outbound-only. */
export function activeTimeline(s: ModelState): DayTimelineVM | undefined {
  return s.cur && s.dir === "out" ? s.cur.timeline : undefined;
}

function flowsOf(s: ModelState): FlowVM[] {
  if (!s.cur) return [];
  return s.dir === "out" ? s.cur.flows : s.cur.inFlows;
}

/** The timeline step at `animTime`. */
export function animStep(tl: DayTimelineVM, animTime: number): number {
  return Math.min(tl.numSteps - 1, Math.max(0, Math.floor(animTime / tl.stepMins)));
}

/** The isolated train's view-model, if one is isolated and present. */
function isolatedTrain(s: ModelState) {
  if (!s.iso || !s.cur) return null;
  return (s.dir === "out" ? s.cur.deps : s.cur.arrs).find((t) => t.code === s.iso) ?? null;
}

/* Exact per-train section counts for a selected station. */
export function getDestSectionCounts(
  s: ModelState,
  caches: ModelCaches,
): Map<number, number> | null {
  const dest = s.panelDest;
  const cur = s.cur;
  if (!dest || !cur) return null;
  const c = caches.destSecCountsCache;
  if (c && c.cur === cur && c.dest === dest && c.dir === s.dir) return c.counts;

  if (s.dir === "out") {
    if (cur.o.dep_secs && cur.o.dep_secs.length > 0) {
      const d = dest as DestVM;
      const secCounts = new Map<number, number>();
      const calls = d.calls || [];
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        if (!call.dep || !call.dep.secs) continue;
        const secs = call.dep.secs;
        const lim = Math.min(secs.length, call.secCnt);
        const seen = new Set<number>();
        for (let k = 0; k < lim; k++) {
          if (seen.has(secs[k])) continue;
          seen.add(secs[k]);
          secCounts.set(secs[k], (secCounts.get(secs[k]) || 0) + 1);
        }
      }
      caches.destSecCountsCache = { cur, dest, dir: "out", counts: secCounts };
      return secCounts;
    }
  } else {
    if (cur.o.arr_secs && cur.o.arr_secs.length > 0) {
      const src = dest as SrcVM;
      const secCounts = new Map<number, number>();
      const inCalls = src.inCalls || [];
      for (let i = 0; i < inCalls.length; i++) {
        const call = inCalls[i];
        if (!call.arr || !call.arr.secs) continue;
        const secs = call.arr.secs;
        const startK = Math.max(0, secs.length - call.secCnt);
        const seen = new Set<number>();
        for (let k = startK; k < secs.length; k++) {
          if (seen.has(secs[k])) continue;
          seen.add(secs[k]);
          secCounts.set(secs[k], (secCounts.get(secs[k]) || 0) + 1);
        }
      }
      caches.destSecCountsCache = { cur, dest, dir: "in", counts: secCounts };
      return secCounts;
    }
  }
  caches.destSecCountsCache = { cur, dest, dir: s.dir, counts: null };
  return null;
}

/* Trains of the selected destination that have already entered each
   section at minute tMins. */
export function getActiveDestSectionCounts(
  s: ModelState,
  caches: ModelCaches,
  tMins: number,
): Map<number, number> {
  const counts = new Map<number, number>();
  const cur = s.cur;
  const dest = s.panelDest;
  const tl = activeTimeline(s);
  if (!dest || !cur || !tl || s.dir !== "out") return counts;

  // Per-selection: each call's sections (once each, first entry) with their
  // route position on the train's PrepTrain, so the frame loop only calls
  // trainDistAt and compares distances.
  if (
    !caches.activeDestCache ||
    caches.activeDestCache.cur !== cur ||
    caches.activeDestCache.dest !== dest
  ) {
    const items: NonNullable<ModelCaches["activeDestCache"]>["items"] = [];
    const calls = (dest as DestVM).calls || [];
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const dep = c.dep;
      if (!dep) continue;
      const pt = tl.getPrepTrain(dep.code);
      if (!pt) continue;
      const lim = Math.min(pt.secs.length, c.secCnt);
      const seen = new Set<number>();
      const entries: { sec: number; pos: number }[] = [];
      for (let k = 0; k < lim; k++) {
        if (seen.has(pt.secs[k])) continue;
        seen.add(pt.secs[k]);
        entries.push({ sec: pt.secs[k], pos: pt.secStarts[k] });
      }
      items.push({ pt, entries });
    }
    caches.activeDestCache = { cur, dest, items };
  }
  for (const it of caches.activeDestCache.items) {
    const d = trainDistAt(it.pt, tMins);
    for (const e of it.entries) {
      if (e.pos > d) break;
      counts.set(e.sec, (counts.get(e.sec) || 0) + 1);
    }
  }
  return counts;
}

export interface FlowItem {
  s: number;
  n: number;
}

/** One stroke pass, in paint order. `maxN` normalises the colour ramp;
    widths come from `n` and the camera at draw time. `pickable` marks the
    pass whose sections hover can hit (context passes never are). */
export interface FlowPass {
  role: "all" | "context" | "focus";
  items: FlowItem[];
  alpha: number;
  maxN: number;
  pickable: boolean;
}

/** Alpha of the flows an isolated train fades to (origin and national views). */
export const isoFlowAlpha = (dark: boolean) => (dark ? 0.06 : 0.08);

/** The flow passes for the current state, in paint order:
    - isolated train: one faded context pass (the corridor is separate,
      see isolatedCorridor);
    - destination selected: faded context (the full origin when filtered,
      else all flows at their current width) + the exact city-pair flow;
    - filtered view: faded base flows + the filtered flows;
    - otherwise one pass at alpha 1.
    While the animation runs the items are the trains that have entered
    each section by the current step; at or past totalMins they equal the
    static flows. */
export function flowPasses(s: ModelState, caches: ModelCaches): FlowPass[] {
  const cur = s.cur;
  if (!cur) return [];
  const flows = flowsOf(s);
  const baseCur = s.baseCur || cur;
  const out = s.dir === "out";
  const baseFlows = out ? baseCur.flows : baseCur.inFlows;
  const baseMaxN = out ? baseCur.maxFlow : baseCur.maxInFlow;
  const maxN = out ? cur.maxFlow : cur.maxInFlow;
  const filtered = isFilteredView(cur, s.baseCur);
  const timeline = activeTimeline(s);
  const isAnimated = s.animEnabled && !!timeline;
  const step = isAnimated && timeline ? animStep(timeline, s.animTime) : 0;
  // A filtered view keeps the full origin's scale, so its bands stay
  // proportional to the faded full-origin context drawn underneath.
  const curMaxN = filtered
    ? baseMaxN
    : isAnimated && timeline
      ? timeline.maxFlowSteps[step] || maxN
      : maxN;
  const effectiveMaxN = Math.max(1, curMaxN);

  let activeFlows: FlowItem[];
  if (isAnimated && timeline) {
    if (s.animTime >= timeline.totalMins) {
      // At or beyond totalMins, all journeys have completed: show 100% completed network
      activeFlows = flows;
    } else {
      activeFlows = [];
      for (let i = 0; i < flows.length; i++) {
        const f = flows[i];
        const n = timeline.secFlowSteps.get(f.s)?.[step] ?? 0;
        if (n > 0) activeFlows.push({ s: f.s, n });
      }
      activeFlows.sort((a, b) => b.n - a.n);
    }
  } else {
    activeFlows = flows;
  }

  const ctxAlpha = s.dark ? 0.16 : 0.18;
  if (isolatedTrain(s)) {
    return [
      {
        role: "context",
        items: activeFlows,
        alpha: isoFlowAlpha(s.dark),
        maxN: effectiveMaxN,
        pickable: false,
      },
    ];
  }
  const destSecCounts = getDestSectionCounts(s, caches);
  if (destSecCounts) {
    const passes: FlowPass[] = [
      {
        role: "context",
        items: filtered ? baseFlows : activeFlows,
        alpha: ctxAlpha,
        maxN: effectiveMaxN,
        pickable: false,
      },
    ];
    if (destSecCounts.size > 0) {
      const subFlows: FlowItem[] = [];
      if (isAnimated && timeline && s.animTime < timeline.totalMins) {
        const activeCounts = getActiveDestSectionCounts(s, caches, s.animTime);
        // Capped by the section's current total (as on main).
        const activeN = new Map<number, number>();
        for (const af of activeFlows) activeN.set(af.s, af.n);
        for (const [sec, destN] of activeCounts.entries()) {
          const subN = Math.min(activeN.get(sec) ?? 0, destN);
          if (subN > 0) subFlows.push({ s: sec, n: subN });
        }
      } else {
        for (let i = 0; i < flows.length; i++) {
          const f = flows[i];
          const subN = Math.min(f.n, destSecCounts.get(f.s) || 0);
          if (subN > 0) subFlows.push({ s: f.s, n: subN });
        }
      }
      subFlows.sort((a, b) => b.n - a.n);
      passes.push({ role: "focus", items: subFlows, alpha: 1, maxN: effectiveMaxN, pickable: true });
    }
    return passes;
  }
  if (filtered) {
    return [
      { role: "context", items: baseFlows, alpha: ctxAlpha, maxN: effectiveMaxN, pickable: false },
      { role: "focus", items: activeFlows, alpha: 1, maxN: effectiveMaxN, pickable: true },
    ];
  }
  return [{ role: "all", items: activeFlows, alpha: 1, maxN: effectiveMaxN, pickable: true }];
}

/** What the isolated train has lit so far: whole sections (`rev` = drawn
    end to start) and, while it is mid-route, the section it is on cut at
    its position (`end`). Or, for a train without routed sections, its
    dashed-leg chord: whole, or a straight line to the train's position
    (`to`). Empty when nothing is lit yet. */
interface IsolatedCorridor {
  color: string;
  secs: { s: number; rev: boolean; end?: { lon: number; lat: number } }[];
  chord?: { chord: ChordVM; to?: { lon: number; lat: number } };
}

export function isolatedCorridor(
  s: ModelState,
  trainsAt: (tl: DayTimelineVM, t: number) => ActiveTrainVM[],
): IsolatedCorridor | null {
  const cur = s.cur;
  const isoTrain = isolatedTrain(s);
  if (!cur || !isoTrain) return null;
  const timeline = activeTimeline(s);
  const isoPt = timeline?.getPrepTrain(isoTrain.code);
  const isoSecs = isoPt ? isoPt.secs : isoTrain.secs;
  const isHs = isoTrain.cls === "G" || isoTrain.cls === "D" || isoTrain.cls === "C";
  const out: IsolatedCorridor = { color: isHs ? "#F59E0B" : "#06B6D4", secs: [] };
  const animTime = s.animTime;
  const depMins = isoTrain.depMins >= 0 ? isoTrain.depMins : 0;
  const dur = isoTrain.dur > 0 ? isoTrain.dur : 1;
  const arrMins = depMins + dur;
  const isProgressive = s.animEnabled && !!timeline && animTime < timeline.totalMins;

  if (isoSecs && isoSecs.length > 0) {
    const ptSecRevs = isoPt?.secRevs;
    const rev = (i: number) => (ptSecRevs ? ptSecRevs[i] === 1 : false);
    if (!isProgressive || animTime >= arrMins) {
      for (let i = 0; i < isoSecs.length; i++) out.secs.push({ s: isoSecs[i], rev: rev(i) });
    } else if (animTime >= depMins) {
      const curTr = trainsAt(timeline!, animTime).find((t) => t.code === isoTrain.code);
      const totalDist = isoPt?.totalDist || 1;
      const targetDist =
        curTr && curTr.curDist !== undefined
          ? curTr.curDist
          : Math.min(1.0, Math.max(0.0, (animTime - depMins) / dur)) * totalDist;
      const secStarts = isoPt?.secStarts;
      let curSecIdx = 0;
      if (secStarts) {
        while (curSecIdx < isoSecs.length - 1 && secStarts[curSecIdx + 1] <= targetDist) {
          curSecIdx++;
        }
      } else {
        curSecIdx = Math.min(
          isoSecs.length - 1,
          Math.floor((targetDist / totalDist) * isoSecs.length),
        );
      }
      for (let i = 0; i < curSecIdx; i++) out.secs.push({ s: isoSecs[i], rev: rev(i) });
      out.secs.push({
        s: isoSecs[curSecIdx],
        rev: rev(curSecIdx),
        end: curTr ? { lon: curTr.lon, lat: curTr.lat } : undefined,
      });
    }
    return out;
  }
  const destIdx = "tcIdx" in isoTrain ? isoTrain.tcIdx : isoTrain.fcIdx;
  const ch = cur.chords.find((c) => c.b === destIdx);
  if (ch) {
    if (!isProgressive || animTime >= arrMins) {
      out.chord = { chord: ch };
    } else if (animTime >= depMins) {
      const curTr = trainsAt(timeline!, animTime).find((t) => t.code === isoTrain.code);
      if (curTr) out.chord = { chord: ch, to: { lon: curTr.lon, lat: curTr.lat } };
    }
  }
  return out;
}

/** Infrastructure overlay passes, in paint order. Each pass strokes the
    listed sections (conventional rail first, then high-speed on top at
    draw time) at `alpha`. */
export interface InfraPass {
  alpha: number;
  sections: FlowVM[];
}

export function infraPasses(s: ModelState, caches: ModelCaches): InfraPass[] {
  if (!s.cur) return [];
  const flows = flowsOf(s);
  const destSecCounts = getDestSectionCounts(s, caches);
  const connected = (sec: number) => (destSecCounts ? destSecCounts.has(sec) : false);
  const subset = (want: boolean) => flows.filter((f) => connected(f.s) === want);
  if (s.iso) return [{ alpha: s.dark ? 0.08 : 0.1, sections: subset(false) }];
  if (destSecCounts) {
    const passes: InfraPass[] = [{ alpha: s.dark ? 0.18 : 0.2, sections: subset(false) }];
    if (destSecCounts.size > 0) passes.push({ alpha: 1, sections: subset(true) });
    return passes;
  }
  return [{ alpha: 1, sections: flows }];
}

/** How the dashed chords are drawn and gated. `forPick` is the hover
    variant (also time-gated in a filtered view, where drawing is not). */
interface ChordPlan {
  alpha: number;
  isolated: boolean;
  gated: boolean;
  firstDep: Map<number, number> | null;
  isoTrain: DepVM | undefined;
}

export function chordPlan(s: ModelState, caches: ModelCaches, forPick = false): ChordPlan | null {
  const cur = s.cur;
  if (!cur) return null;
  const isIsolated = Boolean(s.iso);
  // In a filtered view every chord is faded context (as on main), not gated by time.
  const filtered = isFilteredView(cur, s.baseCur);
  const alpha = isIsolated
    ? s.dark ? 0.05 : 0.08
    : s.panelDest || filtered
      ? s.dark ? 0.16 : 0.18
      : 1;
  const isAnimated = s.animEnabled && !s.showInfra && (forPick || !filtered);
  const timeline = activeTimeline(s);
  const gated = isAnimated && !!timeline && s.animTime < timeline.totalMins;
  const isoTrain = gated && isIsolated ? cur.deps?.find((t) => t.code === s.iso) : undefined;
  // Per origin view: the first departure towards each chord's terminus.
  let firstDep: Map<number, number> | null = null;
  if (gated && !isIsolated) {
    const c = caches.chordDepCache;
    if (c && c.cur === cur) {
      firstDep = c.firstDep;
    } else {
      firstDep = new Map();
      for (const d of cur.deps || []) {
        const prev = firstDep.get(d.tcIdx);
        if (prev === undefined || d.depMins < prev) firstDep.set(d.tcIdx, d.depMins);
      }
      caches.chordDepCache = { cur, firstDep };
    }
  }
  return { alpha, isolated: isIsolated, gated, firstDep, isoTrain };
}

/** A chord is visible only after its first departure (or, isolated, only
    the isolated train's own leg once it has left). */
export function chordVisible(plan: ChordPlan, ch: ChordVM, animTime: number): boolean {
  if (!plan.gated) return true;
  if (plan.isolated) {
    return !(!plan.isoTrain || plan.isoTrain.tcIdx !== ch.b || animTime < plan.isoTrain.depMins);
  }
  const dep = plan.firstDep!.get(ch.b);
  return !(dep === undefined || animTime < dep);
}

/** Static flows that hover can hit: while a city pair is selected only its
    sections; while animating only sections with trains on them (for an
    isolated train, those it has reached). */
export function pickableFlows(s: ModelState, caches: ModelCaches): FlowVM[] {
  const cur = s.cur;
  if (!cur) return [];
  const flows = flowsOf(s);
  const destSecCounts = getDestSectionCounts(s, caches);
  const isAnimated = s.animEnabled && !s.showInfra;
  const timeline = activeTimeline(s);
  const running = isAnimated && !!timeline && s.animTime < timeline.totalMins;
  const step = isAnimated && timeline ? animStep(timeline, s.animTime) : 0;

  let activeDestCounts: Map<number, number> | null = null;
  if (destSecCounts && running) {
    activeDestCounts = getActiveDestSectionCounts(s, caches, s.animTime);
  }

  let activeIsoSecs: Set<number> | null = null;
  if (s.iso && running) {
    activeIsoSecs = new Set<number>();
    const isoTrain = isolatedTrain(s);
    const isoPt = isoTrain ? timeline!.getPrepTrain(isoTrain.code) : undefined;
    if (isoTrain && isoPt && s.animTime >= isoTrain.depMins) {
      const targetDist = trainDistAt(isoPt, s.animTime);
      const secStarts = isoPt.secStarts;
      let curSecIdx = 0;
      while (curSecIdx < isoPt.secs.length - 1 && secStarts[curSecIdx + 1] <= targetDist) {
        curSecIdx++;
      }
      for (let j = 0; j <= curSecIdx; j++) activeIsoSecs.add(isoPt.secs[j]);
    }
  }

  const out: FlowVM[] = [];
  for (const f of flows) {
    // When a city pair is selected, restrict segment picking ONLY to sections that belong to the city pair
    if (destSecCounts && (destSecCounts.get(f.s) ?? 0) <= 0) continue;
    if (running) {
      if (activeDestCounts) {
        if ((activeDestCounts.get(f.s) ?? 0) <= 0) continue;
      } else if (activeIsoSecs !== null) {
        if (!activeIsoSecs.has(f.s)) continue;
      } else if ((timeline!.secFlowSteps.get(f.s)?.[step] ?? 0) <= 0) continue;
    }
    out.push(f);
  }
  return out;
}

/** Chords that hover can hit (the caller skips them when inbound or when
    a city pair is selected). */
export function pickableChords(s: ModelState, caches: ModelCaches): ChordVM[] {
  const cur = s.cur;
  const plan = chordPlan(s, caches, true);
  if (!cur || !plan) return [];
  return cur.chords.filter((ch) => chordVisible(plan, ch, s.animTime));
}

/** The hovered section's highlight: the train count to size it by (the
    selected pair's own count where it has one), or null when the section
    is not on show at the current animation time. */
export function highlightSegN(
  s: ModelState,
  caches: ModelCaches,
  sIdx: number,
  n: number,
): number | null {
  const cur = s.cur;
  if (!cur) return null;
  const timeline = activeTimeline(s);
  if (s.animEnabled && !s.showInfra && timeline && s.animTime < timeline.totalMins) {
    if (s.iso) {
      const isoTrain = (s.dir === "out" ? cur.deps : cur.arrs)?.find((t) => t.code === s.iso);
      if (!isoTrain || !isoTrain.secs || !isoTrain.secs.includes(sIdx) || s.animTime < isoTrain.depMins) {
        return null;
      }
      // Only a section the isolated train has already reached.
      const isoPt = timeline.getPrepTrain(isoTrain.code);
      if (isoPt) {
        const d = trainDistAt(isoPt, s.animTime);
        let reached = false;
        for (let k = 0; k < isoPt.secs.length && isoPt.secStarts[k] <= d; k++) {
          if (isoPt.secs[k] === sIdx) {
            reached = true;
            break;
          }
        }
        if (!reached) return null;
      }
    } else if (s.panelDest) {
      if ((getActiveDestSectionCounts(s, caches, s.animTime).get(sIdx) ?? 0) <= 0) return null;
    } else if ((timeline.secFlowSteps.get(sIdx)?.[animStep(timeline, s.animTime)] ?? 0) <= 0) {
      return null;
    }
  }
  const destSecCounts = getDestSectionCounts(s, caches);
  const subN = destSecCounts ? destSecCounts.get(sIdx) : undefined;
  return subN !== undefined && subN > 0 ? subN : n;
}

// --- stations ---------------------------------------------------------------

/** The selection inputs every station / train rule reads. */
export interface SelInput {
  cur: OriginVM | null;
  panelDest: CityPointVM | null;
  isolatedTrainCode?: string | null;
  direction: Direction;
}

/** Per-selection cache: the allowed train set and each city's sorted arrival
    times, rebuilt only when the origin, panel city, isolated train or
    direction changes (not per frame, not per dot). */
export interface SelCache {
  cur: OriginVM;
  panelDest: CityPointVM | null;
  iso: string | null;
  dir: Direction;
  allowedCodes: Set<string> | null;
  win: DestWindow | null;
  cityTimes: Map<number, number[]>;
}

const pointsOf = (s: SelInput): CityPointVM[] =>
  !s.cur ? [] : s.direction === "out" ? s.cur.dests : s.cur.srcs;

/* The outbound destination's per-train window (null: no destination, or
   inbound, which has no animation). */
function computeDestWindow(s: SelInput): DestWindow | null {
  const { cur, panelDest: pd } = s;
  if (!cur || !pd || s.direction !== "out") return null;
  const dest = (cur.dests.find((d) => d.idx === pd.idx) || pd) as DestVM;
  return dest.calls ? destWindow(dest.calls) : null;
}

function computeAllowedTrainCodes(s: SelInput): Set<string> | null {
  const { cur } = s;
  const iso = s.isolatedTrainCode;
  if (iso) {
    // Intersected with the active filter: a filtered-out train stays hidden.
    const rows = !cur ? [] : s.direction === "out" ? cur.deps : cur.arrs;
    return new Set(rows.some((t) => t.code === iso) ? [iso] : []);
  }
  const pd = s.panelDest;
  if (!pd || !cur) return null;

  const allowed = new Set<string>();
  if (s.direction === "out") {
    const dest = cur.dests.find((d) => d.idx === pd.idx) || (pd as DestVM);
    if (dest && dest.calls) {
      for (let i = 0; i < dest.calls.length; i++) {
        const c = dest.calls[i];
        if (c.dep && c.dep.code) {
          allowed.add(c.dep.code);
        }
      }
    }
  } else {
    const src = cur.srcs.find((x) => x.idx === pd.idx) || (pd as SrcVM);
    if (src && src.inCalls) {
      for (let i = 0; i < src.inCalls.length; i++) {
        const c = src.inCalls[i];
        if (c.arr && c.arr.code) {
          allowed.add(c.arr.code);
        }
      }
    }
  }
  return allowed;
}

function computeCityAllowedArrivalTimes(
  direction: Direction,
  c: CityPointVM,
  allowedCodes: Set<string>,
  win: DestWindow | null,
): number[] {
  if (direction === "out") {
    const calls = (c as DestVM)?.calls;
    if (!calls || calls.length === 0) return [];
    return stopArrivalTimes(calls, allowedCodes, win);
  } else {
    const src = c as SrcVM;
    const inCalls = src?.inCalls;
    if (!inCalls || inCalls.length === 0) return [];
    const times: number[] = [];
    for (let i = 0; i < inCalls.length; i++) {
      const call = inCalls[i];
      if (call.arr && allowedCodes.has(call.arr.code)) {
        if (call.boardMins !== undefined && call.boardMins >= 0) {
          const tDep = call.arr.depMins >= 0 ? call.arr.depMins : 0;
          const tArr = tDep + (call.arr.dur > 0 ? call.arr.dur : 1);
          let unrolled: number = call.boardMins;
          for (let d = 0; d <= 4; d++) {
            const testT = d * 1440 + call.boardMins;
            if (testT >= tDep - 1 && testT <= tArr + 1) {
              unrolled = testT;
              break;
            }
          }
          times.push(unrolled);
        }
      }
    }
    times.sort((a, b) => a - b);
    return times;
  }
}

/** The selection cache for `s`. `memo.selCache` is the caller-owned slot:
    returned as is while the selection is unchanged, replaced otherwise. */
export function getSelCache(
  s: SelInput,
  memo: { selCache: SelCache | null },
): SelCache | null {
  const cur = s.cur;
  if (!cur) return null;
  const panelDest = s.panelDest ?? null;
  const iso = s.isolatedTrainCode ?? null;
  const dir = s.direction;
  const c = memo.selCache;
  if (c && c.cur === cur && c.panelDest === panelDest && c.iso === iso && c.dir === dir) {
    return c;
  }
  const allowedCodes = computeAllowedTrainCodes(s);
  const win = computeDestWindow(s);
  const cityTimes = new Map<number, number[]>();
  if (allowedCodes) {
    const pts = pointsOf(s);
    for (let i = 0; i < pts.length; i++) {
      cityTimes.set(pts[i].idx, computeCityAllowedArrivalTimes(dir, pts[i], allowedCodes, win));
    }
  }
  const next: SelCache = { cur, panelDest, iso, dir, allowedCodes, win, cityTimes };
  memo.selCache = next;
  return next;
}

/** The single visible-train rule: dots, hit-testing and counters ask this;
    stop effects derive from the same set (lib/stopEffects). */
export function isTrainShown(
  s: SelInput,
  memo: { selCache: SelCache | null },
  animTime: number,
  code: string,
): boolean {
  const sel = getSelCache(s, memo);
  return trainShownAt(code, animTime, sel?.allowedCodes ?? null, sel?.win ?? null);
}

export interface StationInput {
  points: CityPointVM[];
  panelDest: CityPointVM | null;
  /** idx of the hovered station, -1 when none. */
  hoverIdx: number;
  dark: boolean;
  animEnabled: boolean;
  animTime: number;
  /** Total minutes of the active timeline; undefined when there is none. */
  totalMins: number | undefined;
  /** stationT of the current zoom. */
  sk: number;
}

export interface StationState {
  c: CityPointVM;
  idx: number;
  /** Base radius (grows with arrivals while animating). */
  r0: number;
  /** Zoom factor on the radius; the drawn radius is r0 * kd. */
  kd: number;
  /** 1, or 0.16 / 0.18 (dark / light) for non-selected cities when a
      destination is selected. */
  alpha: number;
  /** Golden arrival ripple (frac 0..1 of its 20-minute life). */
  ripple?: { frac: number };
  /** Drawn at all: while animating, a city lights up only once a shown
      train has stopped there (the selected destination always is). */
  lit: boolean;
}

/** One entry per city, in draw order of `points` (the selected destination is
    appended when it is not one of them). */
export function stationStates(s: StationInput, sel: SelCache | null): StationState[] {
  const { panelDest: pd } = s;
  const timeline = s.totalMins !== undefined;
  const isAnimated = s.animEnabled && timeline;
  const allowedCodes = sel?.allowedCodes ?? null;
  const dim = s.dark ? 0.16 : 0.18;

  function one(c: CityPointVM): StationState {
    const cityArrTimes = allowedCodes
      ? sel?.cityTimes.get(c.idx) ?? null
      : c.arrTimes || null;
    const totalCityTrains = allowedCodes
      ? cityArrTimes
        ? cityArrTimes.length
        : 0
      : c.trains;

    // Dynamic city circle sizing: circle grows only when an allowed train arrives at this city
    let effectiveTrains = totalCityTrains;
    let recentArrival = false;
    let pulseDt = 0;
    if (isAnimated) {
      const t = s.animTime;
      if (t >= (s.totalMins as number)) {
        // Finished: all trips completed
        effectiveTrains = totalCityTrains;
      } else if (cityArrTimes && cityArrTimes.length > 0) {
        let count = 0;
        for (let k = 0; k < cityArrTimes.length; k++) {
          if (cityArrTimes[k] <= t) count++;
          else break;
        }
        effectiveTrains = count;
        if (count > 0) {
          const lastArr = cityArrTimes[count - 1];
          const dt = t - lastArr;
          if (dt >= 0 && dt <= 20) {
            recentArrival = true;
            pulseDt = dt;
          }
        }
      } else {
        effectiveTrains = 0;
      }
    }
    const r0 = stationR(effectiveTrains);
    const st: StationState = {
      c,
      idx: c.idx,
      r0,
      kd: stationZoomK(r0, s.sk),
      alpha: pd && c.idx !== pd.idx && c.idx !== s.hoverIdx ? dim : 1,
      lit: !isAnimated || effectiveTrains > 0 || (!!pd && c.idx === pd.idx),
    };
    // Ripple only for an allowed train's arrival (never outside allowed trains).
    if (recentArrival && isAnimated && (!allowedCodes || totalCityTrains > 0)) {
      st.ripple = { frac: pulseDt / 20 };
    }
    return st;
  }

  const out: StationState[] = [];
  let hasPd = false;
  for (let i = 0; i < s.points.length; i++) {
    if (pd && s.points[i].idx === pd.idx) hasPd = true;
    out.push(one(s.points[i]));
  }
  if (pd && !hasPd) out.push(one(pd));
  return out;
}
