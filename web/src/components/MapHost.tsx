import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { OriginVM } from "../types";
import { createMapCtx } from "./map/context";
import type { MapApi, Props } from "./map/context";
import { createMapApi } from "./map/api";
import { notifyAnimListeners } from "./map/anim";
import { frameTail, resize, updateScaleBar, zoomAt } from "./map/camera";
import { hideTooltip } from "./map/interaction";
import { endPointer, onPointerDown, onPointerLeave, onPointerMove } from "./map/pointer";
import { loadDeck } from "./map/deck/load";
import type { DeckHandle } from "./map/deck/DeckHost";
import { RELOAD_NOTICE, onStaleReload } from "../staleReload";

export type { AnimListener, AnimState, MapApi } from "./map/context";

/* True when this browser can create a WebGL2 context (the probe context is released at once). */
function hasWebGL2(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

/* The map's React host (no tiles). React owns the surrounding UI state; the
   camera, hover and pointer bookkeeping live in the shared MapCtx
   (./map/context), and drawing is imperative: the lazily loaded deck.gl host
   (./map/deck/DeckHost, mounted below) renders one frame per request.
   <canvas id="map"> is the labels overlay and the pointer / wheel target. */
const MapHost = forwardRef<MapApi, Props>(function MapHost(props, apiRef) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const scaleWrapRef = useRef<HTMLDivElement | null>(null);
  const scaleLabelRef = useRef<HTMLDivElement | null>(null);
  const scaleBarRef = useRef<HTMLDivElement | null>(null);
  const viewReportTimerRef = useRef<number | null>(null);
  const [switching, setSwitching] = useState(false);
  // The lazy deck chunk is fetched after mount; the handle is its imperative host.
  const deckRef = useRef<DeckHandle | null>(null);
  const [deckState, setDeckState] = useState<"loading" | "ready" | "error" | "nowebgl">("loading");
  // A deploy replaced the data files under this tab: the page reloads itself.
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    onStaleReload(() => setReloading(true));
    return () => onStaleReload(null);
  }, []);

  // Latest props, readable from the imperative engine.
  const P = useRef(props);
  P.current = props;

  // The shared engine context: built once, every ref in it is stable.
  const mRef = useRef<ReturnType<typeof createMapCtx> | null>(null);
  if (!mRef.current) {
    mRef.current = createMapCtx(P, {
      wrapRef,
      canvasRef,
      tooltipRef,
      scaleWrapRef,
      scaleLabelRef,
      scaleBarRef,
      viewReportTimerRef,
    });
  }
  const M = mRef.current;
  // One dispatch per frame request: the deck host once mounted, else nothing.
  M.render = () => deckRef.current?.render();
  M.frameTail = () => frameTail(M);
  M.syncRendererSize = () => deckRef.current?.resize();

  useImperativeHandle(apiRef, () => createMapApi(M), [M]);

  // Test/measurement handle for web/tools (screenshots, perf): the engine
  // context and a synchronous draw. App.tsx cannot expose M (it lives
  // here), so this sits next to the other window.__* debug handles. It only
  // exposes objects already reachable from the page; nothing reads it.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__M = M;
    w.__draw = () => M.render();
  }, [M]);

  /* ---------- lifecycle ---------- */
  useEffect(() => {
    return () => {
      if (M.S.current.animRafId !== null) {
        cancelAnimationFrame(M.S.current.animRafId);
        M.S.current.animRafId = null;
      }
    };
  }, [M]);
  // Mount the lazily loaded host (imperative, no React in the chunk). deck.gl 9 needs WebGL2 and
  // there is no Canvas fallback (D9): without it the chunk is not even fetched, a notice shows
  // over the map, and the panels and tables keep working.
  useEffect(() => {
    if (!hasWebGL2()) {
      setDeckState("nowebgl");
      return;
    }
    let cancelled = false;
    let h: DeckHandle | undefined;
    loadDeck()
      .then((m) => {
        const wrap = wrapRef.current;
        if (cancelled || !wrap) return;
        h = m.mountDeck(M, wrap, () => {
          if (!cancelled) setDeckState("error");
        });
        deckRef.current = h;
        setDeckState("ready");
        M.render();
      })
      .catch(() => {
        // loadDeck has already started the one recovery reload for a stale chunk.
        if (!cancelled) setDeckState("error");
      });
    return () => {
      cancelled = true;
      deckRef.current = null;
      h?.destroy();
    };
  }, [M]);
  // The deck canvas fades with the overlay canvas on an origin switch.
  useEffect(() => {
    document.getElementById("deckcv")?.classList.toggle("switching", switching);
  }, [switching]);
  // Wheel zoom needs a non-passive listener (React attaches passive ones).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomAt(
        M,
        e.clientX - r.left,
        e.clientY - r.top,
        Math.exp(-e.deltaY * 0.0016),
      );
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      if (viewReportTimerRef.current) clearTimeout(viewReportTimerRef.current);
    };
  }, [M]);

  useEffect(() => {
    // Folding / unfolding, rotation and browser-chrome changes reach
    // the page through several channels and not always promptly;
    // listen to all of them (plus a ResizeObserver on the wrap, which
    // fires for any layout change) and coalesce bursts into one
    // resize on the next frame, so the canvas never stays stuck at a
    // stale folded size.
    let raf = 0;
    const onResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        resize(M);
      });
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    const vv = window.visualViewport;
    if (vv) vv.addEventListener("resize", onResize);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && wrapRef.current) {
      ro = new ResizeObserver(onResize);
      ro.observe(wrapRef.current);
    }
    resize(M);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      if (vv) vv.removeEventListener("resize", onResize);
      if (ro) ro.disconnect();
    };
  }, [M]);

  // A new origin: reset the camera to the national fit and fade in.
  // A rebuild of the SAME origin (the inbound half merging in) only
  // redraws — the camera, hover and fade belong to origin switches.
  const curRef = useRef<OriginVM | null>(null);
  useEffect(() => {
    if (!props.cur || props.cur === curRef.current) return;
    if (curRef.current && props.cur.o === curRef.current.o) {
      curRef.current = props.cur;
      M.render();
      notifyAnimListeners(M);
      return;
    }
    const isFirstOrigin = curRef.current === null;
    curRef.current = props.cur;
    const st = M.S.current;
    st.hover = null;
    hideTooltip(M);
    st.interacted = false;
    if (!isFirstOrigin) {
      st.initialViewApplied = true;
    }
    resize(M);
    notifyAnimListeners(M);
    setSwitching(true);
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setSwitching(false)),
    );
    return () => cancelAnimationFrame(raf);
  }, [M, props.cur]);

  // Entering national mode fits the country (the flows and city circles are
  // sized against that fit), unless the view was set by the URL or by the
  // user; once per entry, when the atlas and the first origin exist.
  const natFitted = useRef(false);
  useEffect(() => {
    if (!props.national) {
      natFitted.current = false;
      return;
    }
    if (natFitted.current || !props.atlas || !props.cur) return;
    natFitted.current = true;
    if (M.S.current.interacted) return;
    // Later resizes then keep the country fit instead of the opening regional view.
    M.S.current.initialViewApplied = true;
    resize(M); // not interacted: refits the country and resizes the renderer
  }, [M, props.national, props.atlas, props.cur]);

  // Entering / leaving national mode keeps the camera (S.current.view); the
  // national clock is one day, so a day-2 origin time folds into it, and a
  // hover from the other mode is dropped.
  useEffect(() => {
    const st = M.S.current;
    if (props.national) st.animTime = ((st.animTime % 1440) + 1440) % 1440;
    st.hover = null;
    hideTooltip(M);
    M.render();
    notifyAnimListeners(M);
  }, [M, props.national, props.nationalTrains]);

  // Toggle / theme / direction / selected-station changes just need a redraw.
  useEffect(() => {
    M.render();
    notifyAnimListeners(M);
  }, [
    M,
    props.zoomClarity,
    props.showNetwork,
    props.showLabels,
    props.showInfra,
    props.showOutline,
    props.outline,
    props.dark,
    props.direction,
    props.panelDest,
    props.nationalLayers,
    props.nationalFlows,
    props.nationalEntries,
    props.nationalFilter,
    props.nationalIndex,
    props.isolatedTrainCode,
    props.selectedTrainCode,
  ]);

  // The scale bar's round distance follows the km/mi switcher.
  useEffect(() => {
    updateScaleBar(M);
  }, [M, props.distUnit]);

  const { cur, loadError, inLoading, children } = props;

  return (
    <div id="mapwrap" ref={wrapRef}>
      <canvas
        id="map"
        ref={canvasRef}
        className={switching ? "switching" : undefined}
        onPointerDown={(e) => onPointerDown(M, e)}
        onPointerMove={(e) => onPointerMove(M, e)}
        onPointerUp={(e) => endPointer(M, e)}
        onPointerCancel={(e) => endPointer(M, e)}
        onPointerLeave={() => onPointerLeave(M)}
      />
      {(!cur || inLoading || loadError || reloading || deckState !== "ready") && (
        <div id="loading" className={cur ? "is-passive" : undefined}>
          {reloading
            ? RELOAD_NOTICE
            : loadError
            ? "The timetable data could not be loaded (" + loadError + ")."
            : deckState === "nowebgl"
            ? "This map needs WebGL2, which is not available in this browser. The tables and panels still work."
            : deckState === "error"
            ? "The map renderer could not be loaded. Please reload the page."
            : deckState === "loading" && cur
            ? "Loading the map renderer…"
            : "Unfolding the timetable…"}
        </div>
      )}
      <div id="tooltip" role="status" ref={tooltipRef}></div>
      <div
        id="scalebar"
        ref={scaleWrapRef}
        aria-hidden="true"
        style={{ display: "none" }}
      >
        <div className="sb-label" ref={scaleLabelRef}></div>
        <div className="sb-bar" ref={scaleBarRef}></div>
      </div>
      {children}
    </div>
  );
});

export default MapHost;
