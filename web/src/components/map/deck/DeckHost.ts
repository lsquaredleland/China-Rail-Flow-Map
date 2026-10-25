/* The deck.gl renderer (origin view and national mode), as an imperative module (C23): no React, no
   JSX, and no module state shared with the entry bundle (this file is the
   root of a separate lazy esbuild graph, so anything it imports from src/ is
   duplicated). Everything it needs comes in through MapCtx.

   DOM inside #mapwrap (host):
     canvas#deckcv   deck.gl, pointer-events: none, below
     canvas#map      transparent: label overlay and the pointer / wheel target
                     (D17), never touched here except by labelsOverlay.
   The camera stays S.current.view; deck is controlled (controller: false) and
   gets viewToViewState(view) on every render(). */
import { Deck, OrthographicView } from "@deck.gl/core";
import type { Layer, PickingInfo } from "@deck.gl/core";
import { getSelCache, isTrainShown, palette, stationStates, stationT, viewToViewState } from "../../../lib";
import type { MapCtx } from "../context";
import { drawLabelsOverlay } from "./labelsOverlay";
import { backdropLayers } from "./layers/backdrop";
import { PICK_PREFIX, flowLayers } from "./layers/flows";
import { stationLayers } from "./layers/stations";
import { nationalFrame, nationalLayers, nationalTimeline } from "./layers/national";
import { shownTrains, trainLayers } from "./layers/trains";

export interface PickRectOptions {
  /** Left / top of the box, CSS px. */
  x: number;
  y: number;
  width: number;
  height: number;
  layerIds?: string[];
}

export interface DeckHandle {
  /** setProps(viewState, layers) + a synchronous redraw, then labels + frame tail. */
  render(): void;
  /** Every distinct object with a visible pixel in the box, from ONE picking pass
      (deck's pickMultipleObjects peels one object per pass: far too slow for hover). */
  pickRect(opts: PickRectOptions): PickingInfo[];
  /** Re-measures the deck canvas after S.W / S.H / S.DPR changed. */
  resize(): void;
  destroy(): void;
}

export interface DeckStats {
  /** onAfterRender count, across re-creations. */
  afterRenders: number;
  /** True once two consecutive frames drew the same layer-id set with no pipeline compile pending (C22). */
  settled: boolean;
  /** Deck re-creations after a WebGL context loss (C18). */
  recreated: number;
  errors: string[];
  /** National mode: dots in the last frame, the timeline build time and
      the performance.now() of the first rendered frame with dots (M7n). */
  natDots: number;
  natBuildMs: number;
  natFirstFrameAt: number;
}

/* The slice of Deck used here; layerManager / device are protected in the typings. */
interface DeckInternals {
  isInitialized: boolean;
  layerManager?: { getLayers(): { id: string }[] };
  setProps(p: object): void;
  redraw(reason?: string): void;
  finalize(): void;
  pickObjects(o: PickRectOptions & { maxObjects?: number | null }): PickingInfo[];
  _updateCanvasSize?: () => void;
  getViewports(): { width: number; height: number }[];
  deckPicker?: PickerInternals | null;
}

/* The slice of DeckPicker used by dropDepthPickBuffer. */
interface PickerInternals {
  device: { isTextureFormatRenderable(format: string): boolean };
  _resizeBuffer(canvasContext?: unknown): void;
}

/* deck 9.4.0's DeckPicker allocates, besides the rgba8unorm picking framebuffer, an rgba32float
   "depth" framebuffer the size of the drawing buffer. It only serves pickZ, which this app never
   uses, and costs 16 B per device pixel (42 MB at DPR 2 and 95 MB at DPR 3, 1280x800). deck has
   no option to skip it, so its creation is declined by reporting rgba32float as non-renderable
   for the one call that would make it (deck guards every use with `if (this.depthFBO)`). */
export function dropDepthPickBuffer(picker: PickerInternals | null | undefined): void {
  if (!picker) return;
  if (typeof picker._resizeBuffer !== "function" || typeof picker.device?.isTextureFormatRenderable !== "function") {
    // A deck upgrade renamed or removed the private hook: keep deck's default buffers.
    console.warn("deck picker has no _resizeBuffer; the pickZ depth buffer is not dropped");
    return;
  }
  const { device } = picker;
  const resize = picker._resizeBuffer.bind(picker);
  picker._resizeBuffer = (canvasContext) => {
    const real = device.isTextureFormatRenderable;
    device.isTextureFormatRenderable = (f) => f !== "rgba32float" && real.call(device, f);
    try {
      resize(canvasContext);
    } finally {
      device.isTextureFormatRenderable = real;
    }
  };
}

const NOTICE_TEXT = "Map paused — tap to resume";

const GPU_TIME = typeof location !== "undefined" && new URLSearchParams(location.search).get("gputime") === "1";

/** Drawing-buffer DPR: up to 3; D8 caps it at 2 in national mode on a
    low-memory (deviceMemory <= 4, Chrome only) or touch device. */
function devicePixels(M: MapCtx): number {
  const dpr = window.devicePixelRatio || 1;
  if (!M.P.current.national) return Math.min(3, dpr);
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const weak = (mem !== undefined && mem <= 4) || navigator.maxTouchPoints > 0;
  return Math.min(weak ? 2 : 3, dpr);
}

function buildLayers(M: MapCtx, stats: DeckStats): Layer[] {
  const { P, S } = M;
  const atlas = P.current.atlas;
  if (!atlas) return [];
  const layers: Layer[] = backdropLayers({
    atlas,
    outline: P.current.outline ?? null,
    showOutline: !!P.current.showOutline,
    showNetwork: P.current.showNetwork,
    dark: P.current.dark,
    scale: S.current.view.scale,
  });
  if (P.current.national) {
    // D13 map-only mode: the backdrop and every national train; no origin
    // flows, stations, selection or isolation.
    const st = S.current;
    const built = nationalTimeline(atlas, P.current.nationalTrains);
    if (!built) {
      st.natN = st.natRunning = stats.natDots = 0;
      return layers;
    }
    const f = nationalFrame(built.tl, atlas, ((st.animTime % 1440) + 1440) % 1440, st.view.scale);
    st.natN = built.tl.n;
    st.natRunning = stats.natDots = f.count;
    stats.natBuildMs = built.ms;
    layers.push(...nationalLayers(f, !st.animPlaying));
    return layers;
  }
  const set = M.flowsSet();
  const cur = P.current.cur;
  if (set && cur) {
    const st = S.current;
    const { under, over } = flowLayers({
      set,
      ms: {
        cur,
        baseCur: P.current.baseCur,
        dir: P.current.direction,
        animTime: st.animTime,
        animEnabled: st.animEnabled,
        showInfra: P.current.showInfra,
        panelDest: P.current.panelDest,
        iso: P.current.isolatedTrainCode,
        dark: P.current.dark,
      },
      caches: st,
      dark: P.current.dark,
      scale: st.view.scale,
      fitScale: st.fitScale,
      hover: st.hover,
      activeTrainsAt: M.activeTrainsAt,
      chords: cur.chords,
    });
    layers.push(...under);
    if (st.animEnabled) {
      const tl = M.activeTimeline();
      const active = tl ? M.activeTrainsAt(tl, st.animTime) : [];
      const iso = P.current.isolatedTrainCode;
      const shown = shownTrains(active, (code) => isTrainShown(P.current, st, st.animTime, code), iso);
      layers.push(
        ...trainLayers({
          trains: shown,
          scale: st.view.scale,
          isolatedCode: iso,
          selectedCode: P.current.selectedTrainCode,
          hoveredCode: st.hover && st.hover.kind === "train" ? st.hover.train.code : null,
          animTime: st.animTime,
        }),
      );
    }
    layers.push(...over);
    const sk = stationT(st.view, st.fitScale);
    const dark = P.current.dark;
    const pd = P.current.panelDest ?? null;
    const hover = st.hover;
    const states = stationStates(
      {
        points: M.points(),
        panelDest: pd,
        hoverIdx: hover && hover.kind === "station" ? hover.station.idx : -1,
        dark,
        animEnabled: st.animEnabled,
        animTime: st.animTime,
        totalMins: M.activeTimeline()?.totalMins,
        sk,
      },
      getSelCache(P.current, st),
    );
    layers.push(
      ...stationLayers({
        states,
        pal: palette(dark),
        dark,
        hasDest: !!pd,
        originPt: [cur.o.pt[0], cur.o.pt[1]],
        panelDest: pd,
        hoverStation: hover && hover.kind === "station" ? hover.station : null,
        hoverOrigin: !!hover && hover.kind === "origin",
        sk,
        key: [dark, Math.round(sk * 1000), st.animEnabled ? st.animTime : -1, pd?.idx, hover?.kind, hover && hover.kind === "station" ? hover.station.idx : -1, P.current.cur?.o.zh, P.current.direction].join("|"),
        posKey: (cur.o.zh ?? "") + "|" + P.current.direction,
      }),
    );
  }
  return layers;
}

/** True when every model of every layer has finished linking its pipeline
    (luma compiles asynchronously, so a new layer type's first frame can be empty). */
function pipelinesReady(deck: DeckInternals): boolean {
  try {
    for (const layer of deck.layerManager?.getLayers() ?? []) {
      const models = (layer as unknown as { getModels?: () => { pipeline?: { linkStatus?: string } }[] }).getModels?.() ?? [];
      for (const m of models) if (m.pipeline && m.pipeline.linkStatus === "pending") return false;
    }
  } catch {
    // introspection only; treat as ready
  }
  return true;
}

export function mountDeck(M: MapCtx, host: HTMLDivElement): DeckHandle {
  const w = window as unknown as { __deckStats?: DeckStats; __deck?: Deck; __deckHost?: DeckHandle };
  const stats: DeckStats = (w.__deckStats = { afterRenders: 0, settled: false, recreated: 0, errors: [], natDots: 0, natBuildMs: 0, natFirstFrameAt: 0 });

  let canvas: HTMLCanvasElement;
  let deck: DeckInternals;
  let destroyed = false;
  let lost = false; // a loss is pending recovery
  let layerSig = ""; // layer-id set of the last render()
  let sigStreak = 0; // consecutive afterRenders with that set
  let settleRaf = 0;
  let dpr = devicePixels(M); // useDevicePixels of the current Deck
  let notice: HTMLDivElement | null = null;

  const showNotice = () => {
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "deck-notice";
      notice.setAttribute("role", "button");
      notice.tabIndex = 0;
      notice.textContent = NOTICE_TEXT;
      const resume = () => recreate();
      notice.addEventListener("click", resume);
      notice.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") resume();
      });
      host.appendChild(notice);
    }
    notice.style.display = "";
  };
  const hideNotice = () => {
    if (notice) notice.style.display = "none";
  };

  function create() {
    const cv = document.createElement("canvas");
    cv.id = "deckcv";
    cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none";
    host.insertBefore(cv, M.canvasRef.current ?? host.firstChild);
    canvas = cv;
    // luma registers webglcontextlost without preventDefault, and deck 9.4.0's
    // onError never sees a loss (C18): own listeners, so the browser may restore.
    cv.addEventListener("webglcontextlost", (e) => {
      if (cv !== canvas || destroyed) return;
      e.preventDefault();
      lost = true;
      stats.settled = false;
      showNotice();
    });
    cv.addEventListener("webglcontextrestored", () => {
      if (cv === canvas) recreate();
    });
    const { S } = M;
    const st = S.current;
    deck = new Deck({
      canvas: cv,
      width: null,
      height: null,
      views: [new OrthographicView({ id: "map", flipY: false })],
      viewState: viewToViewState(st.view, st.W || 1, st.H || 1),
      controller: false,
      useDevicePixels: (dpr = devicePixels(M)),
      deviceProps: GPU_TIME ? { debugGPUTime: true } : {},
      pickingRadius: 14,
      // Picking proxies exist for the picking passes only.
      layerFilter: ({ layer, isPicking }: { layer: Layer; isPicking: boolean }) => isPicking || !layer.id.startsWith(PICK_PREFIX),
      layers: [],
      onLoad: () => {
        dropDepthPickBuffer(deck.deckPicker);
        if (cv === canvas) render(); // the device initialises asynchronously; draw once it is up
      },
      // luma re-measures the canvas from a ResizeObserver, later than resize(M) runs; redraw when
      // deck's viewport actually changes so the per-axis zoom in render() uses the new size.
      onResize: () => {
        if (cv === canvas) render();
      },
      onError: (err: Error) => {
        stats.errors.push(String(err && err.message));
      },
      onAfterRender: () => {
        stats.afterRenders++;
        if (stats.natDots > 0 && !stats.natFirstFrameAt && M.P.current.national) stats.natFirstFrameAt = performance.now();
        const sig = deck.layerManager?.getLayers().map((l) => l.id).join("|") ?? "";
        sigStreak = sig === layerSig ? sigStreak + 1 : 1;
        stats.settled = sigStreak >= 2 && pipelinesReady(deck);
      },
    } as ConstructorParameters<typeof Deck>[0]) as unknown as DeckInternals;
    w.__deck = deck as unknown as Deck;
  }

  /* At most once per loss: `lost` is the guard, cleared by the first caller
     (restored event or tap), so the other path is a no-op. */
  function recreate() {
    if (destroyed || !lost) return;
    lost = false;
    try {
      deck.finalize();
    } catch {
      // the context is gone; nothing to release
    }
    canvas.remove();
    create();
    stats.recreated++;
    hideNotice();
    render();
  }

  /** Redraws until `settled` (a new layer type's pipeline may compile asynchronously). */
  function settleLoop(n: number) {
    cancelAnimationFrame(settleRaf);
    if (destroyed || lost || stats.settled || n <= 0) return;
    settleRaf = requestAnimationFrame(() => {
      if (destroyed || lost) return;
      deck.redraw("settle");
      settleLoop(n - 1);
    });
  }

  function render() {
    if (destroyed || lost) return;
    const { S, P } = M;
    const st = S.current;
    if (!P.current.atlas || !P.current.cur || !deck.isInitialized) return;
    canvas.style.background = palette(P.current.dark).paper;
    const layers = buildLayers(M, stats);
    const sig = layers.map((l) => l.id).join("|");
    if (sig !== layerSig) {
      layerSig = sig;
      sigStreak = 0;
      stats.settled = false;
    }
    // The world is laid out in S.W x S.H (the #mapwrap rect, fractional, border
    // included) on a rounded bitmap that the browser stretches into the CSS box; deck's viewport is
    // the rounded drawing buffer. A per-axis zoom of viewport/(S.W, S.H) reproduces that mapping
    // exactly (P1b.5: removes the up to 0.5 px vertical offset). target is unchanged.
    const vs = viewToViewState(st.view, st.W, st.H);
    const vp = deck.getViewports()[0];
    const zoom: number | [number, number] = vp ? [vs.zoom + Math.log2(vp.width / st.W), vs.zoom + Math.log2(vp.height / st.H)] : vs.zoom;
    const dp = devicePixels(M);
    if (dp !== dpr) {
      dpr = dp; // D8: entering / leaving national mode on a weak device
      deck.setProps({ useDevicePixels: dp });
    }
    deck.setProps({ viewState: { ...vs, zoom }, layers });
    deck.redraw("render"); // synchronous (C22)
    drawLabelsOverlay(M);
    M.frameTail();
    if (!stats.settled) settleLoop(60);
  }

  create();
  const handle: DeckHandle = {
    render,
    pickRect: (opts) => (lost || destroyed || !deck.isInitialized ? [] : deck.pickObjects(opts)),
    resize() {
      if (destroyed || lost) return;
      // luma owns the drawing buffer and re-measures from a ResizeObserver
      // (async, then redraws by itself); pull the CSS size into deck now so the
      // render() that follows already projects with it.
      deck._updateCanvasSize?.();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(settleRaf);
      try {
        deck.finalize();
      } catch {
        // already lost
      }
      canvas.remove();
      notice?.remove();
      if ((w.__deck as unknown) === deck) delete w.__deck;
      if (w.__deckHost === handle) delete w.__deckHost;
      if (M.deck === handle) M.deck = undefined;
    },
  };
  w.__deckHost = handle;
  M.deck = handle;
  return handle;
}
