/* Station dots and collision-aware city labels. */
import type { Palette } from "../../types";
import {
  getSelCache,
  placeLabels,
  rampColor,
  stationR,
  stationStates,
  stationZoomK,
} from "../../lib";
import type { StationState } from "../../lib";
import type { MapCtx } from "./context";
import { stationT } from "./camera";

export function drawStations(M: MapCtx, ctx: CanvasRenderingContext2D, pal: Palette) {
  const { S, P, X, Y, toLon, toLat, points, activeTimeline } = M;
  const cur = P.current.cur;
  if (!cur) return;
  const { W, H, hover } = S.current;
  const sk = stationT(M);

  const pd = P.current.panelDest;
  const hoveredIdx =
    hover && hover.kind === "station" ? hover.station.idx : -1;
  const states = stationStates(
    {
      points: points(),
      panelDest: pd ?? null,
      hoverIdx: hoveredIdx,
      dark: P.current.dark,
      animEnabled: S.current.animEnabled,
      animTime: S.current.animTime,
      totalMins: activeTimeline()?.totalMins,
      sk,
    },
    getSelCache(P.current, S.current),
  );
  function drawDot(st: StationState) {
    const c = st.c;
    if (
      c.pt[0] < toLon(-30) ||
      c.pt[0] > toLon(W + 30) ||
      c.pt[1] < toLat(H + 30) ||
      c.pt[1] > toLat(-30)
    )
      return;

    const x = X(c.pt[0]),
      y = Y(c.pt[1]),
      r0 = st.r0,
      kd = st.kd,
      r = r0 * kd;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.2832);
    // Dot colour is the fastest-time band — always on, no toggle.
    ctx.fillStyle =
      typeof c.fastest === "number" ? rampColor(c.fastest, pal) : pal.dot;
    ctx.fill();
    ctx.lineWidth = P.current.dark ? 3.0 : 1.5;
    ctx.strokeStyle = pal.dotEdge;
    ctx.stroke();

    // Golden arrival pulse ripple when an allowed train has arrived at this city
    if (st.ripple) {
      const frac = st.ripple.frac;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r + frac * 7 * kd, 0, 6.2832);
      ctx.strokeStyle = P.current.dark ? "#F59E0B" : "#D97706";
      ctx.globalAlpha = Math.max(0, 1 - frac);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
  }

  if (pd) {
    // Dim non-selected, non-hovered city circles
    for (let i = 0; i < states.length; i++) {
      if (states[i].alpha < 1) {
        ctx.globalAlpha = states[i].alpha;
        drawDot(states[i]);
      }
    }
    // Draw selected and hovered station circles at full opacity on top
    ctx.globalAlpha = 1.0;
    for (let i = 0; i < states.length; i++) {
      if (states[i].alpha === 1) drawDot(states[i]);
    }
  } else {
    ctx.globalAlpha = 1.0;
    for (let i = 0; i < states.length; i++) {
      drawDot(states[i]);
    }
  }

  ctx.globalAlpha = 1.0;

  // The origin: solid black disc with white diamond in day mode,
  // or solid paper-white disc with night diamond in night mode.
  const cx = X(cur.o.pt[0]),
    cy = Y(cur.o.pt[1]);
  if (!P.current.dark) {
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, 6.2832);
    ctx.fillStyle = "#111111";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = "#ffffff";
    const s = 4.4;
    ctx.beginPath();
    ctx.rect(-s / 2, -s / 2, s, s);
    ctx.fill();
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, 6.2832);
    ctx.fillStyle = "#EDEDEA";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#1A1B1E";
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = "#1A1B1E";
    const s = 4.4;
    ctx.beginPath();
    ctx.rect(-s / 2, -s / 2, s, s);
    ctx.fill();
    ctx.restore();
  }

  if (P.current.panelDest) {
    const pd = P.current.panelDest;
    ctx.beginPath();
    ctx.arc(X(pd.pt[0]), Y(pd.pt[1]), stationR(pd.trains) * stationZoomK(stationR(pd.trains), sk) + 3.8, 0, 6.2832);
    ctx.strokeStyle = P.current.dark ? "#EDEDEA" : "#111111";
    ctx.lineWidth = 3.0;
    ctx.stroke();
  }
  if (hover && hover.kind === "station") {
    const hc = hover.station;
    ctx.beginPath();
    ctx.arc(X(hc.pt[0]), Y(hc.pt[1]), stationR(hc.trains) * stationZoomK(stationR(hc.trains), sk) + 3.5, 0, 6.2832);
    ctx.strokeStyle = P.current.dark ? "#EDEDEA" : "#111111";
    ctx.lineWidth = 2.0;
    ctx.stroke();
  } else if (hover && hover.kind === "origin") {
    ctx.beginPath();
    ctx.arc(cx, cy, 14.5, 0, 6.2832);
    ctx.strokeStyle = P.current.dark ? "#EDEDEA" : "#111111";
    ctx.lineWidth = 2.0;
    ctx.stroke();
  }
  ctx.globalAlpha = 1.0;
}


/* ---------- labels with collision care ----------
   Placement rules live in lib/labels; this measures and paints. */
export function drawLabels(M: MapCtx, ctx: CanvasRenderingContext2D, pal: Palette) {
  const { S, P, points } = M;
  const cur = P.current.cur;
  if (!cur) return;
  const { W, H, view, fitScale, labelWidthCache } = S.current;
  ctx.textBaseline = "middle";
  const fontOf = (fs: number, weight: string) =>
    weight +
    " " +
    fs +
    "px Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans SC', sans-serif";
  const labels = placeLabels(
    points(),
    view,
    W,
    H,
    (text, fs, weight) => {
      ctx.font = fontOf(fs, weight);
      const cacheKey = text + "|" + fs + "|" + weight;
      let tw = labelWidthCache.get(cacheKey);
      if (tw === undefined) {
        tw = ctx.measureText(text).width;
        labelWidthCache.set(cacheKey, tw);
      }
      return tw;
    },
    {
      origin: { zh: cur.o.zh, en: cur.en, pt: cur.o.pt },
      panelDest: P.current.panelDest ?? null,
      showDest: P.current.showLabels,
      fitScale,
      sk: stationT(M),
    },
  );
  for (let i = 0; i < labels.length; i++) {
    const { box, style, text, x, y, align } = labels[i];
    ctx.font = fontOf(style.fs, style.weight);
    if (style.isBoxed && !P.current.dark) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = "#111111";
    } else if (style.isBoxed && P.current.dark) {
      ctx.fillStyle = "#1A1B1E";
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = "#EDEDEA";
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = "#EDEDEA";
    } else {
      ctx.fillStyle = pal.labelHalo;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = pal.label;
    }
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
  }
}
