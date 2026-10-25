/* City labels and the origin diamond, drawn with Canvas 2D onto the existing
   transparent `#map` canvas (D5): the same text engine and `placeLabels` as
   the Canvas renderer (map/stations.ts drawLabels), so placement is identical;
   glyph anti-aliasing is softer on a transparent canvas (C21). The canvas
   also stays the pointer-capturing element (D17). */
import { palette, placeLabels, stationT } from "../../../lib";
import type { MapCtx } from "../context";

const fontOf = (fs: number, weight: string) =>
  weight +
  " " +
  fs +
  "px Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans SC', sans-serif";

/** Clears the overlay and draws labels + origin diamond for the current view. */
export function drawLabelsOverlay(M: MapCtx) {
  const { S, P, canvasRef, points } = M;
  const canvas = canvasRef.current;
  const cur = P.current.cur;
  if (!canvas || !cur) return;
  const st = S.current;
  const w = Math.round(st.W * st.DPR);
  const h = Math.round(st.H * st.DPR);
  // resize() already sizes the canvas; assigning width clears it, so only on a mismatch.
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dark = P.current.dark;
  const pal = palette(dark);
  ctx.setTransform(st.DPR, 0, 0, st.DPR, 0, 0);
  ctx.clearRect(0, 0, st.W, st.H);
  ctx.textBaseline = "middle";
  const labels = placeLabels(
    points(),
    st.view,
    st.W,
    st.H,
    (text, fs, weight) => {
      ctx.font = fontOf(fs, weight);
      const key = text + "|" + fs + "|" + weight;
      let tw = st.labelWidthCache.get(key);
      if (tw === undefined) {
        tw = ctx.measureText(text).width;
        st.labelWidthCache.set(key, tw);
      }
      return tw;
    },
    {
      origin: { zh: cur.o.zh, en: cur.en, pt: cur.o.pt },
      panelDest: P.current.panelDest ?? null,
      showDest: P.current.showLabels,
      fitScale: st.fitScale,
      sk: stationT(st.view, st.fitScale),
    },
  );
  for (const { box, style, text, x, y, align } of labels) {
    ctx.font = fontOf(style.fs, style.weight);
    if (style.isBoxed) {
      ctx.fillStyle = dark ? "#1A1B1E" : "#ffffff";
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = dark ? "#EDEDEA" : "#111111";
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = dark ? "#EDEDEA" : "#111111";
    } else {
      ctx.fillStyle = pal.labelHalo;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = pal.label;
    }
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
  }
  // The origin's diamond; its disc is a deck layer (P1b.3).
  const cx = M.X(cur.o.pt[0]);
  const cy = M.Y(cur.o.pt[1]);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = dark ? "#1A1B1E" : "#ffffff";
  ctx.fillRect(-2.2, -2.2, 4.4, 4.4);
  ctx.restore();
}
