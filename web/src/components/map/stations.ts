/* Station dots and collision-aware city labels. */
import type {
  CityPointVM,
  Palette,
} from "../../types";
import {
  rampColor,
  stationR,
  stationZoomK,
} from "../../lib";
import type { MapCtx } from "./context";
import { stationT } from "./camera";
import { getAllowedTrainCodes, getSelCache } from "./trains";

export function drawStations(M: MapCtx, ctx: CanvasRenderingContext2D, pal: Palette) {
  const { S, P, X, Y, toLon, toLat, points, activeTimeline } = M;
  const cur = P.current.cur;
  if (!cur) return;
  const { W, H, hover } = S.current;
  const pts = points();
  const sk = stationT(M);

  const timeline = activeTimeline();
  const isAnimated = S.current.animEnabled && !!timeline;

  const sel = getSelCache(M);
  function drawDot(c: CityPointVM) {
    if (
      c.pt[0] < toLon(-30) ||
      c.pt[0] > toLon(W + 30) ||
      c.pt[1] < toLat(H + 30) ||
      c.pt[1] > toLat(-30)
    )
      return;

    const allowedCodes = getAllowedTrainCodes(M);
    const cityArrTimes = allowedCodes
      ? sel?.cityTimes.get(c.idx) ?? null
      : c.arrTimes || null;
    const totalCityTrains = allowedCodes
      ? cityArrTimes
        ? cityArrTimes.length
        : 0
      : c.trains;

    // Dynamic city circle sizing: circle grows only when an allowed train arrives at this city
    let effectiveTrains = totalCityTrains;
    let recentArrival = false;
    let pulseDt = 0;
    if (isAnimated && timeline) {
      const t = S.current.animTime;
      if (t >= timeline.totalMins) {
        // Finished: all trips completed
        effectiveTrains = totalCityTrains;
      } else if (cityArrTimes && cityArrTimes.length > 0) {
        let count = 0;
        for (let k = 0; k < cityArrTimes.length; k++) {
          if (cityArrTimes[k] <= t) count++;
          else break;
        }
        effectiveTrains = count;
        if (count > 0) {
          const lastArr = cityArrTimes[count - 1];
          const dt = t - lastArr;
          if (dt >= 0 && dt <= 20) {
            recentArrival = true;
            pulseDt = dt;
          }
        }
      } else {
        effectiveTrains = 0;
      }
    }

    const x = X(c.pt[0]),
      y = Y(c.pt[1]),
      r0 = stationR(effectiveTrains),
      kd = stationZoomK(r0, sk),
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

    // Golden arrival pulse ripple when an allowed train has arrived at this city (never outside allowed trains)
    if (recentArrival && isAnimated && (!allowedCodes || totalCityTrains > 0)) {
      const frac = pulseDt / 20;
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

  const pd = P.current.panelDest;
  const hoveredIdx =
    hover && hover.kind === "station" ? hover.station.idx : -1;

  if (pd) {
    // Dim non-selected, non-hovered city circles
    ctx.globalAlpha = P.current.dark ? 0.16 : 0.18;
    for (let i = 0; i < pts.length; i++) {
      const c = pts[i];
      if (c.idx !== pd.idx && c.idx !== hoveredIdx) {
        drawDot(c);
      }
    }
    // Draw selected and hovered station circles at full opacity on top
    ctx.globalAlpha = 1.0;
    let drawnPd = false;
    for (let i = 0; i < pts.length; i++) {
      const c = pts[i];
      if (c.idx === pd.idx) drawnPd = true;
      if (c.idx === pd.idx || c.idx === hoveredIdx) {
        drawDot(c);
      }
    }
    if (!drawnPd) drawDot(pd);
  } else {
    ctx.globalAlpha = 1.0;
    for (let i = 0; i < pts.length; i++) {
      drawDot(pts[i]);
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
   Labels are off by default; the origin's own name is always drawn.
   When labels are on, the candidate set stays sparse: at the national
   view only the top ~22 destinations by trains/day, plus every
   substantial route terminus (5+ trains ending there) — and the
   collision pass, not the candidate list, decides which of those
   actually appear, so the result is never a wall of names. Zooming
   in admits progressively smaller cities; every candidate still has
   to win a collision-free spot, and unplaced termini get smaller /
   stepped-out last tries. */
export function drawLabels(M: MapCtx, ctx: CanvasRenderingContext2D, pal: Palette) {
  const { S, P, X, Y, points } = M;
  const cur = P.current.cur;
  if (!cur) return;
  const { W, H, view, fitScale, labelWidthCache } = S.current;
  const showDest = P.current.showLabels;
  const sk = stationT(M);
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  ctx.textBaseline = "middle";
  function hits(box: { x: number; y: number; w: number; h: number }) {
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      if (
        box.x < p.x + p.w &&
        box.x + box.w > p.x &&
        box.y < p.y + p.h &&
        box.y + box.h > p.y
      )
        return true;
    }
    return false;
  }
  interface LabelStyle {
    fs: number;
    weight: string;
    pad: number;
    off: number;
    far?: boolean;
    isBoxed?: boolean;
  }
  function place(
    c: { zh: string; en: string; pt: [number, number] },
    style: LabelStyle,
  ): boolean {
    const x = X(c.pt[0]),
      y = Y(c.pt[1]);
    if (x < -90 || x > W + 90 || y < -30 || y > H + 30) return false;
    const text = c.en + " · " + c.zh;
    const fs = style.fs;
    ctx.font =
      style.weight +
      " " +
      fs +
      "px Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans SC', sans-serif";
    const cacheKey = text + "|" + fs + "|" + style.weight;
    let tw = labelWidthCache.get(cacheKey);
    if (tw === undefined) {
      tw = ctx.measureText(text).width;
      labelWidthCache.set(cacheKey, tw);
    }
    const r = style.off;
    const dyD = r + fs * 0.72;
    let offs: { dx: number; dy: number; align: CanvasTextAlign }[];
    if (style.far) {
      // Last-resort ring: labels for termini whose dot is a few pixels
      // from a big neighbour's dot (Hong Kong beside Shenzhen) — the
      // label steps ~30 px out into open space, still collision-checked.
      const R = 30;
      offs = [
        { dx: R * 0.75, dy: R * 0.75, align: "left" },
        { dx: R * 0.75, dy: -R * 0.75, align: "left" },
        { dx: -R * 0.75, dy: R * 0.75, align: "right" },
        { dx: -R * 0.75, dy: -R * 0.75, align: "right" },
        { dx: R, dy: 0, align: "left" },
        { dx: -R, dy: 0, align: "right" },
        { dx: 0, dy: R, align: "center" },
        { dx: 0, dy: -R, align: "center" },
      ];
    } else {
      offs = [
        { dx: r + 4, dy: 0, align: "left" },
        { dx: -(r + 4), dy: 0, align: "right" },
        { dx: 0, dy: -(r + fs * 0.75), align: "center" },
        { dx: 0, dy: r + fs * 0.75, align: "center" },
        { dx: r + 3, dy: dyD, align: "left" },
        { dx: r + 3, dy: -dyD, align: "left" },
        { dx: -(r + 3), dy: dyD, align: "right" },
        { dx: -(r + 3), dy: -dyD, align: "right" },
      ];
    }
    for (let i = 0; i < offs.length; i++) {
      const o = offs[i];
      const bx =
        o.align === "left"
          ? x + o.dx
          : o.align === "right"
            ? x + o.dx - tw
            : x + o.dx - tw / 2;
      const box = {
        x: bx - 1.5 - style.pad,
        y: y + o.dy - fs * 0.62 - style.pad * 0.4,
        w: tw + 3 + style.pad * 2,
        h: fs * 1.24 + style.pad * 0.8,
      };
      if (box.x < 2 || box.x + box.w > W - 2) continue;
      if (hits(box)) continue;
      placed.push(box);
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
      ctx.textAlign = o.align;
      ctx.fillText(text, x + o.dx, y + o.dy);
      return true;
    }
    return false;
  }
  // The origin first, so its label always wins a spot — and it is the
  // only label drawn while destination labels are toggled off.
  place(
    { zh: cur.o.zh, en: cur.en, pt: cur.o.pt },
    { fs: 13, weight: "700", pad: 5, off: 13, isBoxed: true },
  );
  if (P.current.panelDest) {
    const pd = P.current.panelDest;
    place(
      { zh: pd.zh, en: pd.en, pt: pd.pt },
      { fs: 12.5, weight: "700", pad: 5, off: stationR(pd.trains) * stationZoomK(stationR(pd.trains), sk) + 5, isBoxed: true },
    );
  }
  if (!showDest) return;
  // Candidate set by zoom (points are already sorted by trains/day).
  // "Termini" here are route ends in the current direction: trains
  // ending at the city outbound, starting there inbound.
  const all = points();
  const ratio = view.scale / fitScale;
  const cands: CityPointVM[] = [];
  let j: number;
  let c: CityPointVM;
  if (ratio < 2) {
    for (j = 0; j < all.length && cands.length < 22; j++)
      cands.push(all[j]);
    // Every substantial terminus joins the candidates, however far
    // down the trains list it sits — whether it is actually drawn is
    // decided by the collision pass, not by a candidate cap, so a
    // terminus in open country (Beijing) is never crowded out by
    // candidates that were only ever going to collide near the origin.
    for (j = 0; j < all.length; j++) {
      c = all[j];
      if (c.endpoint >= 5 && cands.indexOf(c) === -1) cands.push(c);
    }
  } else if (ratio < 5) {
    for (j = 0; j < all.length; j++) {
      c = all[j];
      if (c.trains >= 15 || (c.endpoint >= 1 && c.trains >= 6))
        cands.push(c);
    }
  } else if (ratio < 14) {
    for (j = 0; j < all.length; j++) {
      c = all[j];
      if (c.trains >= 5 || (c.endpoint >= 1 && c.trains >= 3))
        cands.push(c);
    }
  } else {
    cands.push(...all);
  }
  // Within a size tier, termini go first, and the most squeezed
  // terminus of the tier goes before its neighbours (Hong Kong's dot
  // sits ~5 px from Shenzhen's at national scale).
  function tier(c2: CityPointVM) {
    return c2.trains >= 50 ? 0 : c2.trains >= 20 ? 1 : 2;
  }
  cands.sort((a, b) => {
    const ta = tier(a),
      tb = tier(b);
    if (ta !== tb) return ta - tb;
    const ea = a.endpoint >= 1 ? 0 : 1,
      eb = b.endpoint >= 1 ? 0 : 1;
    if (ea !== eb) return ea - eb;
    if (ea === 0 && a.nn !== b.nn) return a.nn - b.nn;
    return b.trains - a.trains;
  });
  const unplacedTermini: CityPointVM[] = [];
  for (let k = 0; k < cands.length; k++) {
    const t = cands[k];
    let ok: boolean;
    if (t.trains >= 50)
      ok = place(t, { fs: 14, weight: "700", pad: 4, off: stationR(t.trains) * stationZoomK(stationR(t.trains), sk) + 2 });
    else if (t.trains >= 20)
      ok = place(t, { fs: 12, weight: "600", pad: 2.5, off: stationR(t.trains) * stationZoomK(stationR(t.trains), sk) + 2 });
    else if (t.trains >= 5)
      ok = place(t, { fs: 11, weight: "600", pad: 2, off: stationR(t.trains) * stationZoomK(stationR(t.trains), sk) + 2 });
    else ok = place(t, { fs: 11, weight: "", pad: 2, off: stationR(t.trains) * stationZoomK(stationR(t.trains), sk) + 2 });
    if (!ok && t.endpoint >= 1) unplacedTermini.push(t);
  }
  // Candidates that lost every spot at full size and end routes get
  // two last tries a touch smaller, the second stepped ~30 px out
  // into open space — a terminus label matters more than its size.
  for (let k = 0; k < unplacedTermini.length; k++) {
    const u = unplacedTermini[k];
    if (
      !place(u, { fs: 10.5, weight: "600", pad: 1.2, off: stationR(u.trains) * stationZoomK(stationR(u.trains), sk) + 1.5 })
    ) {
      place(u, {
        fs: 10.5,
        weight: "600",
        pad: 1.2,
        off: stationR(u.trains) * stationZoomK(stationR(u.trains), sk) + 1.5,
        far: true,
      });
    }
  }
}
