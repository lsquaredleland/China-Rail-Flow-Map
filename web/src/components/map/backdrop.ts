/* Backdrop layer: paper, outline, graticule and the base network. Cached
   as an offscreen canvas (see drawBackdrop) so pan/zoom frames and the
   animation clock never repaint it. */
import type {
  Palette,
} from "../../types";
import { isFerrySection } from "../../lib";
import type { MapCtx } from "./context";
import { inViewBB, traceInto } from "./flows";

export function drawOutline(M: MapCtx, ctx: CanvasRenderingContext2D, pal: Palette) {
  const { S, P } = M;
  const outline = P.current.outline;
  if (!outline) return;
  const { rings, lines } = outline;

  // 1. Boundary rings (PRC mainland, Taiwan, Hainan, islands)
  if (rings && rings.len.length > 0) {
    ctx.fillStyle = pal.landFill;
    ctx.strokeStyle = pal.outline;
    ctx.lineWidth = Math.max(0.65, S.current.view.scale * 0.015);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([]);
    ctx.beginPath();
    for (let i = 0; i < rings.len.length; i++) {
      if (
        inViewBB(
          M,
          rings.bb[i * 4],
          rings.bb[i * 4 + 1],
          rings.bb[i * 4 + 2],
          rings.bb[i * 4 + 3],
          0.2,
        )
      ) {
        traceInto(M, ctx, rings.pts, rings.off[i], rings.len[i]);
        ctx.closePath();
      }
    }
    ctx.fill();
    ctx.stroke();
  }

  // 2. Open boundary lines & Nine-dash line in the South China Sea
  if (lines && lines.len.length > 0) {
    ctx.strokeStyle = pal.outline;
    const lw = Math.max(0.65, S.current.view.scale * 0.015);
    const dashLw = Math.max(1.0, S.current.view.scale * 0.02);

    for (let i = 0; i < lines.len.length; i++) {
      if (
        !inViewBB(
          M,
          lines.bb[i * 4],
          lines.bb[i * 4 + 1],
          lines.bb[i * 4 + 2],
          lines.bb[i * 4 + 3],
          0.2,
        )
      )
        continue;

      const isNineDash = lines.len[i] <= 4;
      ctx.beginPath();
      if (isNineDash) {
        ctx.lineWidth = dashLw;
        ctx.lineCap = "butt";
        ctx.setLineDash([Math.max(6, dashLw * 2.2), Math.max(4, dashLw * 1.8)]);
      } else {
        ctx.lineWidth = lw;
        ctx.lineCap = "round";
        ctx.setLineDash([]);
      }
      traceInto(M, ctx, lines.pts, lines.off[i], lines.len[i]);
      ctx.stroke();
    }
    ctx.lineCap = "round";
    ctx.setLineDash([]);
  }
}


export function drawGraticule(M: MapCtx, ctx: CanvasRenderingContext2D, pal: Palette) {
  const { S, X, Y, toLon, toLat } = M;
  const { W, H } = S.current;
  ctx.strokeStyle = pal.graticule;
  ctx.lineWidth = 0.5;
  const lonL = Math.floor(toLon(0) / 5) * 5,
    lonR = toLon(W);
  const latB = Math.floor(toLat(H) / 5) * 5,
    latT = toLat(0);
  ctx.beginPath();
  for (let lon = lonL; lon <= lonR; lon += 5) {
    ctx.moveTo(X(lon), 0);
    ctx.lineTo(X(lon), H);
  }
  for (let lat = latB; lat <= latT; lat += 5) {
    ctx.moveTo(0, Y(lat));
    ctx.lineTo(W, Y(lat));
  }
  ctx.stroke();
}

export function drawNetwork(M: MapCtx, ctx: CanvasRenderingContext2D, pal: Palette) {
  const { S, P } = M;
  const atlas = P.current.atlas;
  if (!atlas) return;
  const { pts, off, len, bb } = atlas.net;
  ctx.strokeStyle = pal.network;
  const netScaleW = Math.min(2.5, Math.max(0.45, S.current.view.scale * 0.008));
  ctx.lineWidth = netScaleW;

  const isFerry = (i: number) => isFerrySection(bb, i);

  // Solid track network (including overland tracks of ferry corridor)
  ctx.setLineDash([]);
  ctx.beginPath();
  for (let i = 0; i < len.length; i++) {
    if (!inViewBB(M, bb[i * 4], bb[i * 4 + 1], bb[i * 4 + 2], bb[i * 4 + 3], 0.3)) continue;
    if (isFerry(i)) {
      traceInto(M, ctx, pts, off[i], len[i], "landOnly");
    } else {
      traceInto(M, ctx, pts, off[i], len[i]);
    }
  }
  ctx.stroke();

  // Dashed ferry crossing line across Qiongzhou strait (maritime water blue, open-water only)
  const ferryW = Math.min(3.5, Math.max(0.75, S.current.view.scale * 0.01));
  ctx.strokeStyle = P.current.dark ? "#38BDF8" : "#0284C7";
  ctx.lineWidth = ferryW;
  ctx.lineCap = "butt";
  ctx.setLineDash([Math.max(12, ferryW * 3.0), Math.max(8, ferryW * 2.0)]);
  ctx.beginPath();
  for (let i = 0; i < len.length; i++) {
    if (!isFerry(i)) continue;
    if (inViewBB(M, bb[i * 4], bb[i * 4 + 1], bb[i * 4 + 2], bb[i * 4 + 3], 0.3)) {
      traceInto(M, ctx, pts, off[i], len[i], "waterOnly");
    }
  }
  ctx.stroke();
  ctx.lineCap = "round";
  ctx.setLineDash([]);
}


/* The static backdrop (paper, outline, graticule, network) depends only
   on the view, canvas size, DPR, palette, layer toggles and the data
   objects. While animating (or hovering) none of that changes, so after
   one frame with an unchanged key it is rendered once to an offscreen
   canvas and blitted. A changing key (pan/zoom) draws directly, with no
   extra cost. */
export function paintBackdrop(M: MapCtx, ctx: CanvasRenderingContext2D, pal: Palette) {
  const { S, P } = M;
  const st = S.current;
  ctx.fillStyle = pal.paper;
  ctx.fillRect(0, 0, st.W, st.H);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (P.current.showOutline) drawOutline(M, ctx, pal);
  drawGraticule(M, ctx, pal);
  if (P.current.showNetwork) drawNetwork(M, ctx, pal);
}

export function drawBackdrop(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  pal: Palette,
) {
  const { S, P, bgRef } = M;
  const st = S.current;
  const bg = bgRef.current;
  const key = [
    st.view.scale,
    st.view.tx,
    st.view.ty,
    st.W,
    st.H,
    st.DPR,
    canvas.width,
    canvas.height,
    P.current.dark ? 1 : 0,
    P.current.showOutline ? 1 : 0,
    P.current.showNetwork ? 1 : 0,
  ].join("|");
  const atlas = P.current.atlas;
  const outline = P.current.outline;
  if (bg.key !== key || bg.atlas !== atlas || bg.outline !== outline) {
    bg.key = key;
    bg.atlas = atlas;
    bg.outline = outline;
    bg.layer = null;
    bg.state = null;
    paintBackdrop(M, ctx, pal);
    return;
  }
  if (!bg.layer) {
    const layer = document.createElement("canvas");
    layer.width = canvas.width;
    layer.height = canvas.height;
    const lctx = layer.getContext("2d");
    if (!lctx) {
      paintBackdrop(M, ctx, pal);
      return;
    }
    lctx.setTransform(st.DPR, 0, 0, st.DPR, 0, 0);
    paintBackdrop(M, lctx, pal);
    // The later layers inherit whatever stroke/fill state the backdrop
    // left on the context; carry it over so a blitted frame is
    // pixel-identical to a drawn one.
    bg.state = {
      lineWidth: lctx.lineWidth,
      strokeStyle: lctx.strokeStyle,
      fillStyle: lctx.fillStyle,
      lineCap: lctx.lineCap,
      lineJoin: lctx.lineJoin,
      lineDash: lctx.getLineDash(),
      globalAlpha: lctx.globalAlpha,
    };
    bg.layer = layer;
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bg.layer, 0, 0);
  ctx.restore();
  if (bg.state) {
    ctx.lineWidth = bg.state.lineWidth;
    ctx.strokeStyle = bg.state.strokeStyle;
    ctx.fillStyle = bg.state.fillStyle;
    ctx.lineCap = bg.state.lineCap;
    ctx.lineJoin = bg.state.lineJoin;
    ctx.setLineDash(bg.state.lineDash);
    ctx.globalAlpha = bg.state.globalAlpha;
  }
}
