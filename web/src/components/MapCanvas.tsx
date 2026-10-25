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
import { resize, updateScaleBar, zoomAt } from "./map/camera";
import { hideTooltip } from "./map/interaction";
import { endPointer, onPointerDown, onPointerLeave, onPointerMove } from "./map/pointer";
import { draw } from "./map/render";

export type { AnimListener, AnimState, MapApi } from "./map/context";

/* The map itself: a custom Canvas 2D renderer (no tiles, no libraries).
   React owns the surrounding UI state; the camera, hover and pointer
   bookkeeping live in the shared MapCtx (./map/context), and drawing is
   imperative — one draw() pass per frame request, composed from the layer
   modules in ./map, exactly as a hand-rolled canvas map wants. */
const MapCanvas = forwardRef<MapApi, Props>(function MapCanvas(props, apiRef) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const scaleWrapRef = useRef<HTMLDivElement | null>(null);
  const scaleLabelRef = useRef<HTMLDivElement | null>(null);
  const scaleBarRef = useRef<HTMLDivElement | null>(null);
  const viewReportTimerRef = useRef<number | null>(null);
  const [switching, setSwitching] = useState(false);

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

  useImperativeHandle(apiRef, () => createMapApi(M), [M]);

  /* ---------- lifecycle ---------- */
  useEffect(() => {
    return () => {
      if (M.S.current.animRafId !== null) {
        cancelAnimationFrame(M.S.current.animRafId);
        M.S.current.animRafId = null;
      }
    };
  }, [M]);
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
      draw(M);
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

  // Toggle / theme / direction / selected-station changes just need a redraw.
  useEffect(() => {
    draw(M);
    notifyAnimListeners(M);
  }, [
    M,
    props.showNetwork,
    props.showLabels,
    props.showInfra,
    props.showOutline,
    props.outline,
    props.dark,
    props.direction,
    props.panelDest,
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
      {(!cur || inLoading || loadError) && (
        <div id="loading" style={cur ? { pointerEvents: "none" } : undefined}>
          {loadError
            ? "The timetable data could not be loaded (" + loadError + ")."
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

export default MapCanvas;
