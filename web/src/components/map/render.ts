/* One frame: composes the layers in paint order. */
import {
  palette as makePalette,
} from "../../lib";
import type { MapCtx } from "./context";
import { drawBackdrop } from "./backdrop";
import { scheduleViewReport, stationT, updateScaleBar } from "./camera";
import { drawChords, drawFlows, drawHighlightSeg, drawInfra, getDestSectionCounts } from "./flows";
import { drawLabels, drawStations } from "./stations";
import { drawTrains } from "./trains";


/* Debug query ?layers=backdrop: draw only the backdrop and labels, in both
   renderers (parity runs of P1b.1). Removed in P1c.2. */
const BACKDROP_ONLY = new URLSearchParams(location.search).get("layers") === "backdrop";

export function draw(M: MapCtx) {
  const { S, P, canvasRef } = M;
  const atlas = P.current.atlas;
  const cur = P.current.cur;
  const canvas = canvasRef.current;
  if (!atlas || !cur || !canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const st = S.current;
  const pal = makePalette(P.current.dark);
  ctx.setTransform(st.DPR, 0, 0, st.DPR, 0, 0);
  drawBackdrop(M, ctx, canvas, pal);
  if (BACKDROP_ONLY) {
    drawLabels(M, ctx, pal);
    frameTail(M);
    return;
  }
  const destSecCounts = getDestSectionCounts(M);
  // Chords are drawn UNDER the routed flows: a dashed leg shows only
  // where a gap in the flow coverage lets it peek out, and is hidden
  // beneath the flows where lines bunch up around a busy origin.
  // There is no inbound chord data: dashed legs exist outbound only.
  if (P.current.direction === "out")
    drawChords(
      M,
      ctx,
      pal,
      st.hover && st.hover.kind === "chord" ? st.hover.chord : null,
      !!P.current.panelDest,
    );
  drawFlows(M, ctx, pal, destSecCounts);
  // The Infrastructure overlay is superimposed on the flows (below
  // the hover highlight, dots and labels).
  if (P.current.showInfra) drawInfra(M, ctx, pal, destSecCounts);
  if (st.animEnabled) drawTrains(M, ctx, pal);
  if (st.hover && st.hover.kind === "seg")
    drawHighlightSeg(
      M,
      ctx,
      pal,
      st.hover.s,
      st.hover.subN !== undefined ? st.hover.subN : st.hover.n,
    );
  drawStations(M, ctx, pal);
  drawLabels(M, ctx, pal);
  frameTail(M);
}

/* The end of every frame (either renderer): Legend, scale bar, view report. */
export function frameTail(M: MapCtx) {
  const { S, P } = M;
  const st = S.current;
  const pal = makePalette(P.current.dark);
  if (P.current.legendRef.current)
    P.current.legendRef.current.draw(
      pal,
      st.view.scale / st.fitScale,
      true,
      P.current.showInfra,
      st.animEnabled,
      stationT(M),
    );
  updateScaleBar(M);
  // Only a moved view re-arms the debounce: the animation loop draws
  // every frame and would otherwise keep postponing the URL update.
  const vk = st.view.scale + "|" + st.view.tx + "|" + st.view.ty;
  if (vk !== st.viewKey) {
    st.viewKey = vk;
    scheduleViewReport(M);
  }
}


export function scheduleDraw(M: MapCtx) {
  const { S } = M;
  const st = S.current;
  if (st.rafPending) return;
  st.rafPending = true;
  requestAnimationFrame(() => {
    st.rafPending = false;
    M.render();
  });
}
