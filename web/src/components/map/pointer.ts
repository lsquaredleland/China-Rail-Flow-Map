/* Pointer input: drag-pan, pinch-zoom, hover picking and tap selection. */
import type { PointerEvent as ReactPointerEvent } from "react";
import type { MapCtx, Pt } from "./context";
import { scheduleDraw, draw } from "./render";
import { zoomAt } from "./camera";
import { hideTooltip, pick, sameHit, showTooltip } from "./interaction";

function localPos(M: MapCtx, e: ReactPointerEvent): Pt {
  const r = M.canvasRef.current!.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

export function onPointerDown(M: MapCtx, e: ReactPointerEvent) {
  const canvas = M.canvasRef.current;
  if (!canvas) return;
  canvas.setPointerCapture(e.pointerId);
  const p = localPos(M, e);
  const st = M.S.current;
  st.pointers.set(e.pointerId, p);
  if (st.pointers.size === 1) {
    st.dragStart = p;
    st.moved = 0;
  }
  if (st.pointers.size === 2) {
    const pts = Array.from(st.pointers.values());
    st.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }
  canvas.classList.add("dragging");
}

export function onPointerMove(M: MapCtx, e: ReactPointerEvent) {
  const canvas = M.canvasRef.current;
  if (!canvas) return;
  const st = M.S.current;
  const p = localPos(M, e);
  if (st.pointers.has(e.pointerId)) {
    const prev = st.pointers.get(e.pointerId)!;
    st.pointers.set(e.pointerId, p);
    if (st.pointers.size === 1 && st.dragStart) {
      const dx = p.x - prev.x,
        dy = p.y - prev.y;
      st.moved += Math.abs(dx) + Math.abs(dy);
      if (st.moved > 3) {
        st.view.tx += dx;
        st.view.ty += dy;
        st.interacted = true;
        hideTooltip(M);
        if (st.hover) st.hover = null;
        scheduleDraw(M);
      }
    } else if (st.pointers.size === 2) {
      const pts = Array.from(st.pointers.values());
      const nd = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      };
      if (st.pinchDist > 0) zoomAt(M, mid.x, mid.y, nd / st.pinchDist);
      st.pinchDist = nd;
      st.moved = 99;
    }
    return;
  }
  if (e.pointerType === "mouse" && M.P.current.cur) {
    const hit = pick(M, p.x, p.y);
    if (!sameHit(hit, st.hover)) {
      st.hover = hit;
      draw(M);
    }
    if (hit) showTooltip(M, hit, p.x, p.y);
    else if (!st.pinned) hideTooltip(M);
    canvas.style.cursor = hit ? "pointer" : "grab";
  }
}

export function endPointer(M: MapCtx, e: ReactPointerEvent) {
  const canvas = M.canvasRef.current;
  if (!canvas) return;
  const { S, P } = M;
  const st = S.current;
  const wasTap = st.pointers.size === 1 && !!st.dragStart && st.moved <= 5;
  const p = localPos(M, e);
  st.pointers.delete(e.pointerId);
  if (st.pointers.size === 0) {
    canvas.classList.remove("dragging");
    if (wasTap && P.current.cur) {
      const hit = pick(M, p.x, p.y);
      st.hover = hit;
      if (hit && hit.kind === "station") {
        // A tap/click on a destination pins the detail panel instead of
        // the floating tooltip; another destination updates it.
        P.current.onSelectDest(hit.station);
        hideTooltip(M);
      } else if (hit && hit.kind === "train") {
        P.current.onSelectTrain?.(hit.train.code);
        hideTooltip(M);
      } else if (hit) {
        st.pinned = true;
        showTooltip(M, hit, p.x, p.y);
      } else {
        hideTooltip(M);
        P.current.onSelectDest(null);
      }
      draw(M);
    }
    st.dragStart = null;
    st.moved = 0;
    st.pinchDist = 0;
  }
}

export function onPointerLeave(M: MapCtx) {
  const st = M.S.current;
  if (!st.pinned) {
    st.hover = null;
    hideTooltip(M);
    draw(M);
  }
}
