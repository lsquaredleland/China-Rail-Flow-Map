/* Train layer: the moving dots and their selection / isolation filters. */
import type {
  CityPointVM,
  DestVM,
  Palette,
  SrcVM,
} from "../../types";
import type { MapCtx } from "./context";

export function computeAllowedTrainCodes(M: MapCtx): Set<string> | null {
  const { P } = M;
  const iso = P.current.isolatedTrainCode;
  const cur = P.current.cur;
  if (iso) {
    // Intersected with the active filter: a filtered-out train stays hidden.
    const rows = !cur ? [] : P.current.direction === "out" ? cur.deps : cur.arrs;
    return new Set(rows.some((t) => t.code === iso) ? [iso] : []);
  }
  const pd = P.current.panelDest;
  if (!pd || !cur) return null;

  const allowed = new Set<string>();
  if (P.current.direction === "out") {
    const dest = cur.dests.find((d) => d.idx === pd.idx) || (pd as DestVM);
    if (dest && dest.calls) {
      for (let i = 0; i < dest.calls.length; i++) {
        const c = dest.calls[i];
        if (c.dep && c.dep.code) {
          allowed.add(c.dep.code);
        }
      }
    }
  } else {
    const src = cur.srcs.find((s) => s.idx === pd.idx) || (pd as SrcVM);
    if (src && src.inCalls) {
      for (let i = 0; i < src.inCalls.length; i++) {
        const c = src.inCalls[i];
        if (c.arr && c.arr.code) {
          allowed.add(c.arr.code);
        }
      }
    }
  }
  return allowed;
}


export function computeCityAllowedArrivalTimes(
  M: MapCtx,
  c: CityPointVM,
  allowedCodes: Set<string>,
): number[] {
  const { P } = M;
  if (P.current.direction === "out") {
    const dest = c as DestVM;
    const calls = dest?.calls;
    if (!calls || calls.length === 0) return [];
    const times: number[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (call.dep && allowedCodes.has(call.dep.code)) {
        const m =
          call.arrMins !== undefined
            ? call.arrMins
            : call.dayOff * 1440 +
              parseInt(call.arr.slice(0, 2), 10) * 60 +
              parseInt(call.arr.slice(3, 5), 10);
        if (typeof m === "number" && !isNaN(m) && m >= 0) {
          times.push(m);
        }
      }
    }
    times.sort((a, b) => a - b);
    return times;
  } else {
    const src = c as SrcVM;
    const inCalls = src?.inCalls;
    if (!inCalls || inCalls.length === 0) return [];
    const times: number[] = [];
    for (let i = 0; i < inCalls.length; i++) {
      const call = inCalls[i];
      if (call.arr && allowedCodes.has(call.arr.code)) {
        if (call.boardMins !== undefined && call.boardMins >= 0) {
          const tDep = call.arr.depMins >= 0 ? call.arr.depMins : 0;
          const tArr = tDep + (call.arr.dur > 0 ? call.arr.dur : 1);
          let unrolled: number = call.boardMins;
          for (let d = 0; d <= 4; d++) {
            const testT = d * 1440 + call.boardMins;
            if (testT >= tDep - 1 && testT <= tArr + 1) {
              unrolled = testT;
              break;
            }
          }
          times.push(unrolled);
        }
      }
    }
    times.sort((a, b) => a - b);
    return times;
  }
}


/* Per-selection cache: the allowed train set and each city's sorted arrival
   times, rebuilt only when the origin, panel city, isolated train or
   direction changes (not per frame, not per dot). */
export function getSelCache(M: MapCtx): NonNullable<typeof S.current.selCache> | null {
  const { S, P, points } = M;
  const cur = P.current.cur;
  if (!cur) return null;
  const panelDest = P.current.panelDest ?? null;
  const iso = P.current.isolatedTrainCode ?? null;
  const dir = P.current.direction;
  const c = S.current.selCache;
  if (c && c.cur === cur && c.panelDest === panelDest && c.iso === iso && c.dir === dir) {
    return c;
  }
  const allowedCodes = computeAllowedTrainCodes(M);
  const cityTimes = new Map<number, number[]>();
  if (allowedCodes) {
    const pts = points();
    for (let i = 0; i < pts.length; i++) {
      cityTimes.set(pts[i].idx, computeCityAllowedArrivalTimes(M, pts[i], allowedCodes));
    }
  }
  const next = { cur, panelDest, iso, dir, allowedCodes, cityTimes };
  S.current.selCache = next;
  return next;
}

export function getAllowedTrainCodes(M: MapCtx) {
  return getSelCache(M)?.allowedCodes ?? null;
}


export function drawTrains(M: MapCtx, ctx: CanvasRenderingContext2D, _pal: Palette) {
  const { S, P, X, Y, activeTimeline, activeTrainsAt, tailGradRef } = M;
  const cur = P.current.cur;
  if (!cur) return;
  const timeline = activeTimeline();
  if (!timeline) return;

  const activeTrains = activeTrainsAt(timeline, S.current.animTime);
  const isolatedCode = P.current.isolatedTrainCode;
  if (!activeTrains || activeTrains.length === 0) return;

  const allowedCodes = getAllowedTrainCodes(M);
  const { W, H } = S.current;
  const tailLen = 12;

  for (let i = 0; i < activeTrains.length; i++) {
    const tr = activeTrains[i];
    if (allowedCodes && !allowedCodes.has(tr.code)) {
      continue;
    }
    const isIsolated = isolatedCode === tr.code;
    if (isolatedCode && !isIsolated) {
      continue;
    }
    ctx.globalAlpha = tr.onChord ? 0.45 : 1.0;

    const px = X(tr.lon);
    const py = Y(tr.lat);
    if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;

    const isHighSpeed = tr.cls === "G" || tr.cls === "D" || tr.cls === "C";
    const isConv =
      tr.cls === "Z" || tr.cls === "T" || tr.cls === "K" || tr.cls === "S";

    const glowColor = isHighSpeed
      ? "#F59E0B"
      : isConv
        ? "#06B6D4"
        : "#E2E8F0";

    // Tail vector pointing backwards from the movement direction
    // screen vx = cos(heading), vy = -sin(heading) due to equirectangular latitude inversion
    const vx = Math.cos(tr.heading);
    const vy = -Math.sin(tr.heading);
    const isDwelling = Boolean(tr.isDwelling);
    const speedFrac =
      tr.speedFrac !== undefined ? tr.speedFrac : isDwelling ? 0 : 1;
    const baseTailLen = isIsolated ? 22 : tailLen;
    const actualTailLen = isDwelling || tr.onChord
      ? 0
      : Math.round(baseTailLen * speedFrac);
    if (actualTailLen > 0) {
      // One cached gradient per (colour, length) in the train's local
      // frame (tail along -x, head at the origin); the train's position
      // and heading come from the transform, so no per-train, per-frame
      // createLinearGradient.
      const gkey = glowColor + actualTailLen;
      let grad = tailGradRef.current.get(gkey);
      if (!grad) {
        grad = ctx.createLinearGradient(-actualTailLen, 0, 0, 0);
        grad.addColorStop(0, "rgba(255, 255, 255, 0)");
        grad.addColorStop(1, glowColor);
        tailGradRef.current.set(gkey, grad);
      }
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.atan2(vy, vx));
      ctx.beginPath();
      ctx.moveTo(-actualTailLen, 0);
      ctx.lineTo(0, 0);
      ctx.strokeStyle = grad;
      ctx.lineWidth = isIsolated ? 3.5 : 2.5;
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.restore();
    }

    // Outer glow
    ctx.beginPath();
    ctx.arc(px, py, isIsolated ? 5.5 : 4, 0, 6.2832);
    ctx.fillStyle = glowColor;
    ctx.fill();

    // Inner white core
    ctx.beginPath();
    ctx.arc(px, py, isIsolated ? 2.8 : 2, 0, 6.2832);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    // Station dwelling ring indicator (passengers boarding)
    if (isDwelling) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, isIsolated ? 8.5 : 6.5, 0, 6.2832);
      ctx.strokeStyle = glowColor;
      ctx.lineWidth = 1.3;
      ctx.globalAlpha = 0.85;
      ctx.stroke();
      ctx.restore();
    }

    // If hovered (while paused), selected, or isolated, draw prominent indicator ring and code tag
    const isHovered =
      S.current.hover &&
      S.current.hover.kind === "train" &&
      S.current.hover.train.code === tr.code;
    const isSelected = P.current.selectedTrainCode === tr.code;

    if (isHovered || isSelected || isIsolated) {
      ctx.beginPath();
      ctx.arc(px, py, isIsolated ? 9 : 7, 0, 6.2832);
      ctx.strokeStyle = isIsolated ? glowColor : "#FFFFFF";
      ctx.lineWidth = isIsolated ? 2.5 : 2.0;
      ctx.stroke();

      ctx.font = "bold 10px monospace";
      const tagText = isIsolated ? `${tr.code} · ${tr.progressPct}%` : tr.code;
      const tagMetrics = ctx.measureText(tagText);
      const tagW = tagMetrics.width + 8;
      const tagH = 16;
      const tagX = px - tagW / 2;
      const tagY = py - 18;

      ctx.fillStyle = "rgba(15, 23, 42, 0.90)";
      ctx.beginPath();
      ctx.roundRect(tagX, tagY, tagW, tagH, 3);
      ctx.fill();
      ctx.strokeStyle = glowColor;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = "#FFFFFF";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tagText, px, tagY + tagH / 2);
    }
  }
  ctx.globalAlpha = 1.0;
}
