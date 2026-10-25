/* The deck.gl origin renderer, as an imperative module (C23): no React, no
   JSX, and no module state shared with the entry bundle (this file is the
   root of a separate lazy esbuild graph, so anything it imports from src/ is
   duplicated). Everything it needs comes in through MapCtx.

   DOM inside #mapwrap (host):
     canvas#deckcv   deck.gl, pointer-events: none, below
     canvas#map      the Canvas renderer's element, transparent: label overlay
                     and the pointer / wheel target (D17), never touched here
                     except by labelsOverlay.
   The camera stays S.current.view; deck is controlled (controller: false) and
   gets viewToViewState(view) on every render(). */
import { Deck, OrthographicView } from "@deck.gl/core";
import type { Layer, PickingInfo } from "@deck.gl/core";
import { palette, viewToViewState } from "../../../lib";
import type { MapCtx } from "../context";
import { drawLabelsOverlay } from "./labelsOverlay";
import { backdropLayers } from "./layers/backdrop";
import { flowLayers } from "./layers/flows";

export interface PickOptions {
  x: number;
  y: number;
  radius?: number;
  layerIds?: string[];
  depth?: number;
}

export interface DeckHandle {
  /** setProps(viewState, layers) + a synchronous redraw, then labels + frame tail. */
  render(): void;
  pick(opts: PickOptions): PickingInfo | null;
  pickMultiple(opts: PickOptions): PickingInfo[];
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
}

/* The slice of Deck used here; layerManager / device are protected in the typings. */
interface DeckInternals {
  isInitialized: boolean;
  layerManager?: { getLayers(): { id: string }[] };
  setProps(p: object): void;
  redraw(reason?: string): void;
  finalize(): void;
  pickObject(o: PickOptions): PickingInfo | null;
  pickMultipleObjects(o: PickOptions): PickingInfo[];
  _updateCanvasSize?: () => void;
}

const NOTICE_TEXT = "Map paused — tap to resume";

/* Debug query ?layers= (both renderers; removed in P1c.2): "backdrop" builds
   only the backdrop; "flows" adds chords, flows, infra and the hover highlight
   (no stations or trains, which land in P1b.3). */
const LAYERS = new URLSearchParams(location.search).get("layers");
const GPU_TIME = new URLSearchParams(location.search).get("gputime") === "1";

function buildLayers(M: MapCtx): Layer[] {
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
  if (LAYERS === "backdrop") return layers;
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
    // trains: P1b.3
    layers.push(...over);
    // stations: P1b.3
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
  const stats: DeckStats = (w.__deckStats = { afterRenders: 0, settled: false, recreated: 0, errors: [] });

  let canvas: HTMLCanvasElement;
  let deck: DeckInternals;
  let destroyed = false;
  let lost = false; // a loss is pending recovery
  let layerSig = ""; // layer-id set of the last render()
  let sigStreak = 0; // consecutive afterRenders with that set
  let settleRaf = 0;
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
      useDevicePixels: Math.min(3, window.devicePixelRatio || 1),
      deviceProps: GPU_TIME ? { debugGPUTime: true } : {},
      pickingRadius: 14,
      layers: [],
      onLoad: () => {
        if (cv === canvas) render(); // the device initialises asynchronously; draw once it is up
      },
      onError: (err: Error) => {
        stats.errors.push(String(err && err.message));
      },
      onAfterRender: () => {
        stats.afterRenders++;
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
    const layers = buildLayers(M);
    const sig = layers.map((l) => l.id).join("|");
    if (sig !== layerSig) {
      layerSig = sig;
      sigStreak = 0;
      stats.settled = false;
    }
    deck.setProps({ viewState: viewToViewState(st.view, st.W, st.H), layers });
    deck.redraw("render"); // synchronous, like draw(M) on Canvas (C22)
    drawLabelsOverlay(M);
    M.frameTail();
    if (!stats.settled) settleLoop(60);
  }

  create();
  const handle: DeckHandle = {
    render,
    pick: (opts) => (lost || destroyed ? null : deck.pickObject(opts)),
    pickMultiple: (opts) => (lost || destroyed ? [] : deck.pickMultipleObjects(opts)),
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
    },
  };
  w.__deckHost = handle;
  return handle;
}
