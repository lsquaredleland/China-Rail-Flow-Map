import type { ReactNode, RefObject } from "react";
import type {
  ActiveTrainVM,
  CityPointVM,
  DecodedAtlas,
  DecodedOutline,
  DecodedSet,
  DayTimelineVM,
  Direction,
  DistUnit,
  NatLayer,
  NationalEntriesPack,
  NationalFlowsPack,
  NationalIndexPack,
  NationalTimeline,
  NationalTrainsData,
  FlowVM,
  Hit,
  OriginVM,
  PrepTrain,
} from "../../types";
import { flowWidth, isFilteredView as isFilteredViewOf } from "../../lib";
import type { DestWindow, NatFilter } from "../../lib";
import type { LegendHandle } from "../Legend";
import type { DeckHandle } from "./deck/DeckHost";
import type { NationalCityDots } from "./deck/layers/national";

export interface AnimState {
  time: number; // minutes from midnight (0 up to totalMins)
  totalMins: number; // total duration until all trains arrive (e.g. 1440, 2880, 4320)
  totalDays: number; // number of 24h days needed for complete journeys
  isPlaying: boolean;
  speed: number; // seconds per 24h cycle (e.g. 15, 30, 60), default 30
  departed: number;
  arrived: number;
  total: number;
  enabled: boolean;
  /** National mode (D13): the clock spans one day and wraps; `departed` is `running`. */
  national: boolean;
  /** Distinct trains on the line at `time` in national mode (0 otherwise). */
  running: number;
}
export type AnimListener = (state: AnimState) => void;

/** Camera/tooltip controls the toolbar drives through a ref. */
export interface MapApi {
  fitCountry: () => void;
  fitHome: () => void;
  zoomCenter: (factor: number) => void;
  refreshTooltip: () => void;
  clearStationHover: () => void;
  selectDestByZh: (zh: string) => void;
  panZoomTo: (lon: number, lat: number, scale: number) => void;
  setTime: (tMins: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  setSpeed: (secPerDay: number) => void;
  setAnimEnabled: (enabled: boolean) => void;
  getAnimState: () => AnimState;
  subscribeAnim: (listener: AnimListener) => () => void;
}

export interface Props {
  atlas: DecodedAtlas | null;
  outline?: DecodedOutline | null;
  showOutline?: boolean;
  baseCur?: OriginVM | null;
  cur: OriginVM | null;
  direction: Direction;
  dark: boolean;
  showNetwork: boolean;
  showLabels: boolean;
  /** Infrastructure overlay: the proportional flows stay as they are
      and every flow section's track geometry is stroked again on top
      as one uniform thin line in the theme's ink tone. */
  showInfra: boolean;
  distUnit: DistUnit;
  panelDest: CityPointVM | null;
  loadError: string | null;
  /** True while the lazily-fetched inbound map file is still in
      flight: the map shows the standard loading affordance over the
      canvas. */
  inLoading: boolean;
  /** National mode (D13, map-only): every national train, no origin state drawn. */
  national?: boolean;
  /** The national trains file and its schedules, once loaded. */
  nationalTrains?: NationalTrainsData | null;
  /** National mode: trains (A), the day's flows (B), or both (A+B). */
  nationalLayer?: NatLayer;
  /** The national flows file (B) and its entry ticks (A+B), once loaded. */
  nationalFlows?: NationalFlowsPack | null;
  nationalEntries?: NationalEntriesPack | null;
  /** The national filters (class, hour, distance, duration, train code) that
      the flows, city circles and dots follow; `nationalIndex` answers all but
      the class filter once loaded. */
  nationalFilter?: NatFilter;
  nationalIndex?: NationalIndexPack | null;
  onSelectDest: (d: CityPointVM | null) => void;
  selectedTrainCode?: string | null;
  onSelectTrain?: (code: string | null) => void;
  isolatedTrainCode?: string | null;
  onSelectIsolatedTrain?: (code: string | null) => void;
  legendRef: RefObject<LegendHandle | null>;
  initialCamera?: { lon: number; lat: number; zoom?: number; scale?: number } | null;
  onViewChange?: (view: {
    lon: number;
    lat: number;
    zoom: number;
    scale: number;
  }) => void;
  children?: ReactNode;
}

export interface View {
  scale: number;
  tx: number;
  ty: number;
}

export interface Pt {
  x: number;
  y: number;
}

/* Engine state (the vanilla module-level variables, kept in one object). */
function createMapState() {
  return {
    view: { scale: 10, tx: 0, ty: 0 } as View,
    fitScale: 10,
    viewKey: "",
    W: 0,
    H: 0,
    DPR: 1,
    interacted: false,
    initialViewApplied: false,
    hover: null as Hit | null,
    pinned: false,
    pointers: new Map<number, Pt>(),
    dragStart: null as Pt | null,
    moved: 0,
    pinchDist: 0,
    rafPending: false,
    lastTip: null as { hit: Hit; x: number; y: number } | null,
    labelWidthCache: new Map<string, number>(),
    destSecCountsCache: null as {
      cur: OriginVM | null;
      dest: CityPointVM;
      dir: Direction;
      counts: Map<number, number> | null;
    } | null,
    activeDestCache: null as {
      cur: OriginVM;
      dest: CityPointVM;
      items: { pt: PrepTrain; entries: { sec: number; pos: number }[] }[];
    } | null,
    selCache: null as {
      cur: OriginVM;
      panelDest: CityPointVM | null;
      iso: string | null;
      dir: Direction;
      allowedCodes: Set<string> | null;
      win: DestWindow | null;
      cityTimes: Map<number, number[]>;
    } | null,
    activeTrainsMemo: null as {
      tl: DayTimelineVM;
      t: number;
      list: ActiveTrainVM[];
    } | null,
    chordDepCache: null as { cur: OriginVM; firstDep: Map<number, number> } | null,
    animTime: 360,
    /* National mode: trains in the timeline and dots in the last frame (set by the deck host). */
    natN: 0,
    natRunning: 0,
    /* The last national frame's dots for picking (CPU scan, P2.3). */
    natPick: null as { tl: NationalTimeline; count: number; buf: Float32Array; qOf: Int32Array; m: number } | null,
    /* The last national frame's flow counts per section, for hover. */
    natCounts: null as ArrayLike<number> | null,
    /* The last national frame's city circles, for hover. */
    natCities: null as NationalCityDots | null,
    /** Origin-view cities not yet lit by the animation (null when not animating). */
    unlitCities: null as Set<number> | null,
    animPlaying: false,
    animSpeed: 30,
    animEnabled: false,
    animListeners: new Set<AnimListener>(),
    lastRafTimestamp: null as number | null,
    animRafId: null as number | null,
  };
}
export type MapState = ReturnType<typeof createMapState>;

/* Everything the layer modules share: the latest props (`P`), the engine
   state (`S`), the DOM refs and the camera / view-model helpers. One stable
   object per MapCanvas, so every layer is a plain function of `(M, ...)`
   and nothing closes over a stale render. */
export interface MapCtx {
  P: { current: Props };
  S: { current: MapState };
  wrapRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  tooltipRef: RefObject<HTMLDivElement | null>;
  scaleWrapRef: RefObject<HTMLDivElement | null>;
  scaleLabelRef: RefObject<HTMLDivElement | null>;
  scaleBarRef: RefObject<HTMLDivElement | null>;
  viewReportTimerRef: { current: number | null };
  X: (lon: number) => number;
  Y: (lat: number) => number;
  toLon: (px: number) => number;
  toLat: (py: number) => number;
  widthOf: (n: number) => number;
  points: () => CityPointVM[];
  flowsList: () => FlowVM[];
  activeTimeline: () => DayTimelineVM | undefined;
  activeTrainsAt: (tl: DayTimelineVM, t: number) => ActiveTrainVM[];
  isFilteredView: () => boolean;
  flowsSet: () => DecodedSet | null;
  /* The single way to request a frame. MapCanvas installs it (the deck host's
     render once mounted); until then it is a no-op. */
  render: () => void;
  /* What every frame ends with: the Legend, the scale bar and the debounced
     view report. Installed by MapCanvas; the lazily loaded deck host calls it
     instead of importing map/ modules. */
  frameTail: () => void;
  /* Tells the deck host the canvas size / DPR changed (resize() calls it just
     before the render() that follows). Installed by MapCanvas. */
  syncRendererSize: () => void;
  /* The deck renderer's handle while it is mounted (the host sets and clears
     it); interaction.ts pick() asks it for GPU candidates. */
  deck?: DeckHandle;
}

type MapRefs = Pick<
  MapCtx,
  | "wrapRef"
  | "canvasRef"
  | "tooltipRef"
  | "scaleWrapRef"
  | "scaleLabelRef"
  | "scaleBarRef"
  | "viewReportTimerRef"
>;

export function createMapCtx(P: MapCtx["P"], refs: MapRefs): MapCtx {
  const S = { current: createMapState() };
  return {
    P,
    S,
    ...refs,
    render: () => {},
    frameTail: () => {},
    syncRendererSize: () => {},
    /* ---------- camera helpers ---------- */
    X: (lon) => lon * S.current.view.scale + S.current.view.tx,
    Y: (lat) => -lat * S.current.view.scale + S.current.view.ty,
    toLon: (px) => (px - S.current.view.tx) / S.current.view.scale,
    toLat: (py) => (S.current.view.ty - py) / S.current.view.scale,
    widthOf: (n) => flowWidth(n, S.current.view.scale, S.current.fitScale),

    /* ---------- direction-aware views of the current origin ---------- */
    points: () => {
      const cur = P.current.cur;
      if (!cur) return [];
      return P.current.direction === "out" ? cur.dests : cur.srcs;
    },
    flowsList: () => {
      const cur = P.current.cur;
      if (!cur) return [];
      return P.current.direction === "out" ? cur.flows : cur.inFlows;
    },
    // Inbound has no timeline: the animation is outbound-only. National mode
    // has none either: its clock is one day (1440) and wraps.
    activeTimeline: () => {
      const cur = P.current.cur;
      return cur && P.current.direction === "out" && !P.current.national ? cur.timeline : undefined;
    },
    // The dots at minute t, computed once per frame however many passes ask.
    activeTrainsAt: (tl, t) => {
      const m = S.current.activeTrainsMemo;
      if (m && m.tl === tl && m.t === t) return m.list;
      const list = tl.getActiveTrains(t);
      S.current.activeTrainsMemo = { tl, t, list };
      return list;
    },
    /* A filtered view (class, histogram or train filter) is a subset of the
       full origin `baseCur`; selecting a city alone is not a filter. */
    isFilteredView: () => isFilteredViewOf(P.current.cur, P.current.baseCur),
    flowsSet: () => {
      const atlas = P.current.atlas;
      if (!atlas) return null;
      return P.current.direction === "out" ? atlas.sec : atlas.inSec;
    },
  };
}
