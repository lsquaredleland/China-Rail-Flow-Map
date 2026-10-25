/* Flow layer: routed section flows, the infrastructure overlay, dashed
   chords and the hover highlight, plus the section-tracing helpers. */
import type {
  ChordVM,
  DestVM,
  Palette,
  PrepTrain,
  SrcVM,
} from "../../types";
import {
  flowColor,
  trainDistAt,
} from "../../lib";
import type { MapCtx } from "./context";

/* Infrastructure overlay: each flow section's track geometry stroked
   once more at this fixed screen-space width, in CSS px — the canvas
   transform scales it by the device pixel ratio like everything else,
   and it never grows with zoom, so the superimposed centreline stays a
   crisp hairline tracing every corridor at any scale. */
const INFRA_WIDTH = 1.25;


/* ---------- drawing ---------- */
export function inViewBB(
  M: MapCtx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  marginDeg: number,
): boolean {
  const { S, toLon, toLat } = M;
  const { W, H } = S.current;
  const m = marginDeg || 0;
  const lonL = toLon(-40) - m,
    lonR = toLon(W + 40) + m;
  const latB = toLat(H + 40) - m,
    latT = toLat(-40) + m;
  return x1 >= lonL && x0 <= lonR && y1 >= latB && y0 <= latT;
}

// Append one polyline (flat coords, offset in floats) to the current path,
// skipping points that land on (nearly) the same pixel as the previous one.
// Optional waterMode isolates open-water ferry crossings from overland track.
export function traceInto(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  arr: ArrayLike<number>,
  off: number,
  count: number,
  waterMode?: "landOnly" | "waterOnly",
  isRev: boolean = false,
) {
  const { X, Y } = M;
  if (!waterMode) {
    let lx = -1e9,
      ly = -1e9,
      started = false;
    const step = isRev ? -1 : 1;
    const startIdx = isRev ? count - 1 : 0;
    const endIdx = isRev ? -1 : count;
    for (let i = startIdx; i !== endIdx; i += step) {
      const x = X(arr[off + i * 2]),
        y = Y(arr[off + i * 2 + 1]);
      const dx = x - lx,
        dy = y - ly;
      if (started && dx * dx + dy * dy < 0.42 && i !== (isRev ? 0 : count - 1)) continue;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
      lx = x;
      ly = y;
    }
    return;
  }

  let lx = -1e9,
    ly = -1e9,
    started = false;
  const step = isRev ? -1 : 1;
  const startIdx = isRev ? count - 1 : 0;
  const endIdx = isRev ? -1 : count;
  for (let i = startIdx; i !== endIdx; i += step) {
    const lon = arr[off + i * 2];
    const lat = arr[off + i * 2 + 1];

    if (i !== startIdx) {
      const prevLon = arr[off + (i - step) * 2];
      const prevLat = arr[off + (i - step) * 2 + 1];
      const isWaterCross =
        ((prevLat < 20.10 && lat > 20.18) || (prevLat > 20.18 && lat < 20.10)) &&
        prevLon > 109.9 && prevLon < 110.4 &&
        lon > 109.9 && lon < 110.4;

      if (waterMode === "landOnly" && isWaterCross) {
        started = false;
      } else if (waterMode === "waterOnly") {
        if (isWaterCross) {
          ctx.moveTo(X(prevLon), Y(prevLat));
          ctx.lineTo(X(lon), Y(lat));
        }
        continue;
      }
    }

    if (waterMode === "waterOnly") continue;

    const x = X(lon),
      y = Y(lat);
    const dx = x - lx,
      dy = y - ly;
    if (started && dx * dx + dy * dy < 0.42 && i !== (isRev ? 0 : count - 1)) continue;
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
    lx = x;
    ly = y;
  }
}

export function tracePartialSec(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  arr: ArrayLike<number>,
  off: number,
  count: number,
  endLon: number,
  endLat: number,
  isRev: boolean = false,
) {
  const { X, Y } = M;
  if (count <= 0) return;
  let bestK = 0;
  let bestD2 = 1e9;
  for (let k = 0; k < count; k++) {
    const d2 =
      (arr[off + k * 2] - endLon) ** 2 +
      (arr[off + k * 2 + 1] - endLat) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestK = k;
    }
  }
  let lx = -1e9,
    ly = -1e9,
    started = false;
  if (!isRev) {
    for (let i = 0; i <= bestK; i++) {
      const x = X(arr[off + i * 2]),
        y = Y(arr[off + i * 2 + 1]);
      const dx = x - lx,
        dy = y - ly;
      if (started && dx * dx + dy * dy < 0.42 && i !== bestK) continue;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
      lx = x;
      ly = y;
    }
  } else {
    for (let i = count - 1; i >= bestK; i--) {
      const x = X(arr[off + i * 2]),
        y = Y(arr[off + i * 2 + 1]);
      const dx = x - lx,
        dy = y - ly;
      if (started && dx * dx + dy * dy < 0.42 && i !== bestK) continue;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
      lx = x;
      ly = y;
    }
  }
  if (!started) {
    ctx.moveTo(X(endLon), Y(endLat));
  } else {
    ctx.lineTo(X(endLon), Y(endLat));
  }
}

/* ---------- exact per-train section counts for a selected station ---------- */
export function getDestSectionCounts(M: MapCtx): Map<number, number> | null {
  const { S, P } = M;
  const dest = P.current.panelDest;
  const cur = P.current.cur;
  if (!dest || !cur) return null;
  const st = S.current;
  if (
    st.destSecCountsCache &&
    st.destSecCountsCache.cur === cur &&
    st.destSecCountsCache.dest === dest &&
    st.destSecCountsCache.dir === P.current.direction
  ) {
    return st.destSecCountsCache.counts;
  }

  if (P.current.direction === "out") {
    if (cur.o.dep_secs && cur.o.dep_secs.length > 0) {
      const d = dest as DestVM;
      const secCounts = new Map<number, number>();
      const calls = d.calls || [];
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        if (!c.dep || !c.dep.secs) continue;
        const secs = c.dep.secs;
        const lim = Math.min(secs.length, c.secCnt);
        const seen = new Set<number>();
        for (let k = 0; k < lim; k++) {
          if (seen.has(secs[k])) continue;
          seen.add(secs[k]);
          secCounts.set(secs[k], (secCounts.get(secs[k]) || 0) + 1);
        }
      }
      st.destSecCountsCache = { cur, dest, dir: "out", counts: secCounts };
      return secCounts;
    }
  } else {
    if (cur.o.arr_secs && cur.o.arr_secs.length > 0) {
      const s = dest as SrcVM;
      const secCounts = new Map<number, number>();
      const inCalls = s.inCalls || [];
      for (let i = 0; i < inCalls.length; i++) {
        const c = inCalls[i];
        if (!c.arr || !c.arr.secs) continue;
        const secs = c.arr.secs;
        const startK = Math.max(0, secs.length - c.secCnt);
        const seen = new Set<number>();
        for (let k = startK; k < secs.length; k++) {
          if (seen.has(secs[k])) continue;
          seen.add(secs[k]);
          secCounts.set(secs[k], (secCounts.get(secs[k]) || 0) + 1);
        }
      }
      st.destSecCountsCache = { cur, dest, dir: "in", counts: secCounts };
      return secCounts;
    }
  }
  st.destSecCountsCache = { cur, dest, dir: P.current.direction, counts: null };
  return null;
}


export function getActiveDestSectionCounts(M: MapCtx, tMins: number): Map<number, number> {
  const { S, P, activeTimeline } = M;
  const counts = new Map<number, number>();
  const cur = P.current.cur;
  const dest = P.current.panelDest;
  const tl = activeTimeline();
  if (!dest || !cur || !tl || P.current.direction !== "out") return counts;

  // Per-selection: each call's sections (once each, first entry) with their
  // route position on the train's PrepTrain, so the frame loop only calls
  // trainDistAt and compares distances.
  const st = S.current;
  if (!st.activeDestCache || st.activeDestCache.cur !== cur || st.activeDestCache.dest !== dest) {
    const items: NonNullable<typeof st.activeDestCache>["items"] = [];
    const calls = (dest as DestVM).calls || [];
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const dep = c.dep;
      if (!dep) continue;
      const pt = tl.getPrepTrain(dep.code);
      if (!pt) continue;
      const lim = Math.min(pt.secs.length, c.secCnt);
      const seen = new Set<number>();
      const entries: { sec: number; pos: number }[] = [];
      for (let k = 0; k < lim; k++) {
        if (seen.has(pt.secs[k])) continue;
        seen.add(pt.secs[k]);
        entries.push({ sec: pt.secs[k], pos: pt.secStarts[k] });
      }
      items.push({ pt, entries });
    }
    st.activeDestCache = { cur, dest, items };
  }
  for (const it of st.activeDestCache.items) {
    const d = trainDistAt(it.pt, tMins);
    for (const e of it.entries) {
      if (e.pos > d) break;
      counts.set(e.sec, (counts.get(e.sec) || 0) + 1);
    }
  }
  return counts;
}


// Flow sections batched into one stroke per (width, colour) bucket
// (0.25 px width steps). When a station is selected (`destSecCounts`),
// Pass 1 draws all origin flows faded at full trunk width, and Pass 2
// draws the exact city-pair flow on top at its exact train count.
export function drawFlows(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  destSecCounts: Map<number, number> | null,
) {
  const { S, P, X, Y, widthOf, flowsList, activeTimeline, activeTrainsAt, isFilteredView, flowsSet } = M;
  const atlas = P.current.atlas;
  const cur = P.current.cur;
  const set = flowsSet();
  if (!atlas || !cur || !set) return;
  const { pts, off, len, bb } = set;
  const flows = flowsList();
  const baseCur = P.current.baseCur || cur;
  const baseFlows =
    P.current.direction === "out" ? baseCur.flows : baseCur.inFlows;
  const baseMaxN =
    P.current.direction === "out" ? baseCur.maxFlow : baseCur.maxInFlow;
  const maxN = P.current.direction === "out" ? cur.maxFlow : cur.maxInFlow;
  const filtered = isFilteredView();
  const timeline = activeTimeline();
  const isAnimated = S.current.animEnabled && !!timeline;
  const step = isAnimated && timeline
    ? Math.min(
        timeline.numSteps - 1,
        Math.max(0, Math.floor(S.current.animTime / timeline.stepMins)),
      )
    : 0;
  // A filtered view keeps the full origin's scale, so its bands stay
  // proportional to the faded full-origin context drawn underneath.
  const curMaxN = filtered
    ? baseMaxN
    : isAnimated && timeline
      ? timeline.maxFlowSteps[step] || maxN
      : maxN;
  const effectiveMaxN = Math.max(1, curMaxN);

  const isFerry = (s: number) =>
    bb[s * 4 + 1] < 20.15 &&
    bb[s * 4 + 3] > 20.20 &&
    bb[s * 4] > 110.0 &&
    bb[s * 4 + 2] < 110.3;

  function strokeFlowList(
    items: { s: number; n: number }[],
    alpha: number,
    normMaxN: number,
  ) {
    ctx.globalAlpha = alpha;
    let curW = -1,
      curCol = "",
      open = false;
    ctx.lineCap = "round";
    ctx.setLineDash([]);

    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      if (f.n <= 0) continue;
      if (
        !inViewBB(
          M,
          bb[f.s * 4],
          bb[f.s * 4 + 1],
          bb[f.s * 4 + 2],
          bb[f.s * 4 + 3],
          0.35,
        )
      )
        continue;
      const bw0 = Math.round(widthOf(f.n) * 4) / 4;
      const col = flowColor(f.n, normMaxN, pal);
      if (bw0 !== curW || col !== curCol) {
        if (open) ctx.stroke();
        ctx.beginPath();
        ctx.lineWidth = bw0;
        ctx.strokeStyle = col;
        curW = bw0;
        curCol = col;
        open = true;
      }
      if (isFerry(f.s)) {
        traceInto(M, ctx, pts, off[f.s], len[f.s], "landOnly");
      } else {
        traceInto(M, ctx, pts, off[f.s], len[f.s]);
      }
    }
    if (open) ctx.stroke();

    // Open-water ferry crossing dashed lines (Qiongzhou Strait water connector)
    const ferryBlue = P.current.dark ? "#38BDF8" : "#0284C7";
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      if (f.n <= 0) continue;
      if (!isFerry(f.s)) continue;
      if (
        !inViewBB(
          M,
          bb[f.s * 4],
          bb[f.s * 4 + 1],
          bb[f.s * 4 + 2],
          bb[f.s * 4 + 3],
          0.35,
        )
      )
        continue;
      const bw0 = Math.round(widthOf(f.n) * 4) / 4;
      ctx.beginPath();
      ctx.lineWidth = bw0;
      ctx.strokeStyle = ferryBlue;
      ctx.lineCap = "butt";
      const dashLen = Math.max(12, bw0 * 2.5);
      const gapLen = Math.max(9, bw0 * 1.8);
      ctx.setLineDash([dashLen, gapLen]);
      traceInto(M, ctx, pts, off[f.s], len[f.s], "waterOnly");
      ctx.stroke();
    }
    ctx.lineCap = "round";
    ctx.setLineDash([]);
  }

  let activeFlows: { s: number; n: number }[];
  if (isAnimated && timeline) {
    if (S.current.animTime >= timeline.totalMins) {
      // At or beyond totalMins, all journeys have completed: show 100% completed network
      activeFlows = flows;
    } else {
      activeFlows = [];
      for (let i = 0; i < flows.length; i++) {
        const f = flows[i];
        const n = timeline.secFlowSteps.get(f.s)?.[step] ?? 0;
        if (n > 0) {
          activeFlows.push({ s: f.s, n });
        }
      }
      activeFlows.sort((a, b) => b.n - a.n);
    }
  } else {
    activeFlows = flows;
  }

  const isolatedCode = P.current.isolatedTrainCode;
  const isoTrain = isolatedCode
    ? (P.current.direction === "out" ? cur.deps : cur.arrs).find(
        (t) => t.code === isolatedCode,
      )
    : null;
  const isoPt = isoTrain ? timeline?.getPrepTrain(isoTrain.code) : undefined;
  const isoSecs = isoTrain ? (isoPt ? isoPt.secs : isoTrain.secs) : null;

  if (isoTrain) {
    // Pass 1: faded ambient flows across the network
    strokeFlowList(activeFlows, P.current.dark ? 0.06 : 0.08, effectiveMaxN);

    // Pass 2: illuminate the exact physical corridor of the isolated train as a crisp thin line
    const isHs = isoTrain.cls === "G" || isoTrain.cls === "D" || isoTrain.cls === "C";
    const isoColor = isHs ? "#F59E0B" : "#06B6D4";
    ctx.globalAlpha = 1.0;
    ctx.lineWidth = 2.0;
    ctx.strokeStyle = isoColor;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([]);

    const animTime = S.current.animTime;
    const depMins = isoTrain.depMins >= 0 ? isoTrain.depMins : 0;
    const dur = isoTrain.dur > 0 ? isoTrain.dur : 1;
    const arrMins = depMins + dur;
    const isProgressive = isAnimated && timeline && animTime < timeline.totalMins;

    if (isoSecs && isoSecs.length > 0) {
      const ptSecRevs = isoPt?.secRevs;
      if (!isProgressive || animTime >= arrMins) {
        ctx.beginPath();
        for (let i = 0; i < isoSecs.length; i++) {
          const s = isoSecs[i];
          traceInto(M, ctx, pts, off[s], len[s], undefined, ptSecRevs ? ptSecRevs[i] === 1 : false);
        }
        ctx.stroke();
      } else if (animTime >= depMins) {
        const curTr = activeTrainsAt(timeline, animTime).find(
          (t) => t.code === isoTrain.code,
        );
        const totalDist = isoPt?.totalDist || 1;
        const targetDist =
          curTr && curTr.curDist !== undefined
            ? curTr.curDist
            : Math.min(1.0, Math.max(0.0, (animTime - depMins) / dur)) * totalDist;
        const secStarts = isoPt?.secStarts;
        let curSecIdx = 0;
        if (secStarts) {
          while (
            curSecIdx < isoSecs.length - 1 &&
            secStarts[curSecIdx + 1] <= targetDist
          ) {
            curSecIdx++;
          }
        } else {
          curSecIdx = Math.min(
            isoSecs.length - 1,
            Math.floor((targetDist / totalDist) * isoSecs.length),
          );
        }

        ctx.beginPath();
        for (let i = 0; i < curSecIdx; i++) {
          const s = isoSecs[i];
          traceInto(M, ctx, pts, off[s], len[s], undefined, ptSecRevs ? ptSecRevs[i] === 1 : false);
        }
        if (curSecIdx < isoSecs.length) {
          const curS = isoSecs[curSecIdx];
          const isSecRev = ptSecRevs ? ptSecRevs[curSecIdx] === 1 : false;
          if (curTr) {
            tracePartialSec(M, ctx, pts, off[curS], len[curS], curTr.lon, curTr.lat, isSecRev);
          } else {
            traceInto(M, ctx, pts, off[curS], len[curS], undefined, isSecRev);
          }
        }
        ctx.stroke();
      }
    } else {
      const destIdx = "tcIdx" in isoTrain ? isoTrain.tcIdx : isoTrain.fcIdx;
      const ch = cur.chords.find((c) => c.b === destIdx);
      if (ch) {
        ctx.beginPath();
        if (!isProgressive || animTime >= arrMins) {
          traceInto(M, ctx, ch.flat, 0, ch.count);
        } else if (animTime >= depMins) {
          const curTr = timeline && activeTrainsAt(timeline, animTime).find(
            (t) => t.code === isoTrain.code,
          );
          if (curTr) {
            ctx.moveTo(X(ch.flat[0]), Y(ch.flat[1]));
            ctx.lineTo(X(curTr.lon), Y(curTr.lat));
          }
        }
        ctx.stroke();
      }
    }
  } else if (destSecCounts) {
    // Pass 1: faded background: the full origin (static) in a filtered
    // view, else all flows at their current trunk width
    strokeFlowList(
      filtered ? baseFlows : activeFlows,
      P.current.dark ? 0.16 : 0.18,
      effectiveMaxN,
    );
    // Pass 2: exact city-pair flow on top at widthOf(subN) and flowColor(subN, effectiveMaxN, pal)
    if (destSecCounts.size > 0) {
      const subFlows: { s: number; n: number }[] = [];
      if (isAnimated && timeline && S.current.animTime < timeline.totalMins) {
        const activeCounts = getActiveDestSectionCounts(M, S.current.animTime);
        // Capped by the section's current total (as on main).
        const activeN = new Map<number, number>();
        for (const af of activeFlows) activeN.set(af.s, af.n);
        for (const [s, destN] of activeCounts.entries()) {
          const subN = Math.min(activeN.get(s) ?? 0, destN);
          if (subN > 0) {
            subFlows.push({ s, n: subN });
          }
        }
      } else {
        for (let i = 0; i < flows.length; i++) {
          const f = flows[i];
          const subN = Math.min(f.n, destSecCounts.get(f.s) || 0);
          if (subN > 0) {
            subFlows.push({ s: f.s, n: subN });
          }
        }
      }
      subFlows.sort((a, b) => b.n - a.n);
      strokeFlowList(subFlows, 1.0, effectiveMaxN);
    }
    ctx.globalAlpha = 1.0;
  } else if (filtered) {
    // Pass 1: faded background of ALL base flows at full trunk width
    strokeFlowList(baseFlows, P.current.dark ? 0.16 : 0.18, effectiveMaxN);
    // Pass 2: exact filtered flows on top at widthOf(f.n) and flowColor(f.n, effectiveMaxN, pal)
    strokeFlowList(activeFlows, 1.0, effectiveMaxN);
    ctx.globalAlpha = 1.0;
  } else {
    strokeFlowList(activeFlows, 1.0, effectiveMaxN);
  }
}


// Infrastructure overlay: uniform hairline in two colours (conventional
// rail first, then high-speed rail on top), superimposed on the flow
// mass.
export function drawInfra(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  destSecCounts: Map<number, number> | null,
) {
  const { P, flowsList, flowsSet } = M;
  const atlas = P.current.atlas;
  const cur = P.current.cur;
  const set = flowsSet();
  if (!atlas || !cur || !set) return;
  const { pts, off, len, bb, hsr } = set;
  const flows = flowsList();
  ctx.lineWidth = INFRA_WIDTH;
  ctx.setLineDash([]);

  function infraPass(wantConnected: boolean | null, alpha: number) {
    ctx.globalAlpha = alpha;
    const isFerry = (s: number) =>
      bb[s * 4 + 1] < 20.15 &&
      bb[s * 4 + 3] > 20.20 &&
      bb[s * 4] > 110.0 &&
      bb[s * 4 + 2] < 110.3;

    for (let pass = 0; pass < 2; pass++) {
      const wantHsr = pass === 1 ? 1 : 0;
      ctx.strokeStyle = pass === 1 ? pal.infraHsr : pal.infraConv;
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < flows.length; i++) {
        const f = flows[i];
        if (
          wantConnected !== null &&
          (destSecCounts ? destSecCounts.has(f.s) : false) !== wantConnected
        )
          continue;
        if ((hsr[f.s] ? 1 : 0) !== wantHsr) continue;
        if (
          !inViewBB(
            M,
            bb[f.s * 4],
            bb[f.s * 4 + 1],
            bb[f.s * 4 + 2],
            bb[f.s * 4 + 3],
            0.35,
          )
        )
          continue;
        if (pass === 0 && isFerry(f.s)) {
          traceInto(M, ctx, pts, off[f.s], len[f.s], "landOnly");
        } else {
          traceInto(M, ctx, pts, off[f.s], len[f.s]);
        }
        any = true;
      }
      if (any) ctx.stroke();

      // Depict train ferry crossing with a maritime dashed line in water blue (open water only)
      if (pass === 0) {
        ctx.beginPath();
        ctx.lineCap = "butt";
        ctx.strokeStyle = P.current.dark ? "#38BDF8" : "#0284C7";
        ctx.setLineDash([7, 6]);
        let anyFerry = false;
        for (let i = 0; i < flows.length; i++) {
          const f = flows[i];
          if (
            wantConnected !== null &&
            (destSecCounts ? destSecCounts.has(f.s) : false) !== wantConnected
          )
            continue;
          if (!isFerry(f.s)) continue;
          if (
            !inViewBB(
              M,
              bb[f.s * 4],
              bb[f.s * 4 + 1],
              bb[f.s * 4 + 2],
              bb[f.s * 4 + 3],
              0.35,
            )
          )
            continue;
          traceInto(M, ctx, pts, off[f.s], len[f.s], "waterOnly");
          anyFerry = true;
        }
        if (anyFerry) ctx.stroke();
        ctx.lineCap = "round";
        ctx.setLineDash([]);
      }
    }
  }

  const isIsolated = Boolean(P.current.isolatedTrainCode);
  if (isIsolated) {
    infraPass(false, P.current.dark ? 0.08 : 0.1);
    ctx.globalAlpha = 1.0;
  } else if (destSecCounts) {
    infraPass(false, P.current.dark ? 0.18 : 0.2);
    if (destSecCounts.size > 0) infraPass(true, 1.0);
    ctx.globalAlpha = 1.0;
  } else {
    infraPass(null, 1.0);
  }
}

export function drawChords(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  highlight: ChordVM | null,
  hasSelectedDest: boolean,
) {
  const { S, P, widthOf, activeTimeline, isFilteredView } = M;
  const cur = P.current.cur;
  if (!cur) return;
  const isIsolated = Boolean(P.current.isolatedTrainCode);
  // In a filtered view every chord is faded context (as on main), not gated by time.
  const filtered = isFilteredView();
  if (isIsolated) {
    ctx.globalAlpha = P.current.dark ? 0.05 : 0.08;
  } else if (hasSelectedDest || filtered) {
    ctx.globalAlpha = P.current.dark ? 0.16 : 0.18;
  }
  const st = S.current;
  const isAnimated = st.animEnabled && !P.current.showInfra && !filtered;
  const timeline = activeTimeline();
  const gated = isAnimated && !!timeline && st.animTime < timeline.totalMins;
  const isoTrain = gated && isIsolated
    ? cur.deps?.find((t) => t.code === P.current.isolatedTrainCode)
    : undefined;
  // Per origin view: the first departure towards each chord's terminus.
  let firstDep: Map<number, number> | null = null;
  if (gated && !isIsolated) {
    const c = st.chordDepCache;
    if (c && c.cur === cur) {
      firstDep = c.firstDep;
    } else {
      firstDep = new Map();
      for (const d of cur.deps || []) {
        const prev = firstDep.get(d.tcIdx);
        if (prev === undefined || d.depMins < prev) firstDep.set(d.tcIdx, d.depMins);
      }
      st.chordDepCache = { cur, firstDep };
    }
  }
  for (let i = 0; i < cur.chords.length; i++) {
    const ch = cur.chords[i];
    if (highlight === ch) continue;
    if (!inViewBB(M, ch.bb.x0, ch.bb.y0, ch.bb.x1, ch.bb.y1, 0.35)) continue;
    if (gated) {
      if (isIsolated) {
        if (!isoTrain || isoTrain.tcIdx !== ch.b || st.animTime < isoTrain.depMins) {
          continue;
        }
      } else {
        const dep = firstDep!.get(ch.b);
        if (dep === undefined || st.animTime < dep) continue;
      }
    }
    const w = isIsolated ? 1.5 : widthOf(ch.n);
    ctx.lineWidth = w;
    ctx.strokeStyle = pal.chord;
    ctx.setLineDash([Math.max(3, w * 1.1), Math.max(2.5, w * 0.8)]);
    ctx.beginPath();
    traceInto(M, ctx, ch.flat, 0, ch.count);
    ctx.stroke();
  }
  ctx.globalAlpha = 1.0;
  ctx.setLineDash([]);
  if (highlight && !isIsolated) {
    const hw = widthOf(highlight.n) + 1.6;
    ctx.lineWidth = hw;
    ctx.strokeStyle = pal.flowHi;
    ctx.setLineDash([Math.max(3, hw * 1.1), Math.max(2.5, hw * 0.8)]);
    ctx.beginPath();
    traceInto(M, ctx, highlight.flat, 0, highlight.count);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export function drawHighlightSeg(
  M: MapCtx,
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  sIdx: number,
  n: number,
) {
  const { S, P, widthOf, activeTimeline, flowsSet } = M;
  const cur = P.current.cur;
  if (!cur) return;
  const st = S.current;
  const isAnimated = st.animEnabled && !P.current.showInfra;
  const timeline = activeTimeline();
  if (isAnimated && timeline && st.animTime < timeline.totalMins) {
    const step = Math.min(
      timeline.numSteps - 1,
      Math.max(0, Math.floor(st.animTime / timeline.stepMins)),
    );
    if (P.current.isolatedTrainCode) {
      const isoTrain = (P.current.direction === "out" ? P.current.cur?.deps : P.current.cur?.arrs)?.find(
        (t) => t.code === P.current.isolatedTrainCode,
      );
      if (!isoTrain || !isoTrain.secs || !isoTrain.secs.includes(sIdx) || st.animTime < isoTrain.depMins) {
        return;
      }
      // Only a section the isolated train has already reached.
      const isoPt = timeline.getPrepTrain(isoTrain.code);
      if (isoPt) {
        const d = trainDistAt(isoPt, st.animTime);
        let reached = false;
        for (let k = 0; k < isoPt.secs.length && isoPt.secStarts[k] <= d; k++) {
          if (isoPt.secs[k] === sIdx) {
            reached = true;
            break;
          }
        }
        if (!reached) return;
      }
    } else if (P.current.panelDest) {
      const activeCounts = getActiveDestSectionCounts(M, st.animTime);
      if ((activeCounts.get(sIdx) ?? 0) <= 0) {
        return;
      }
    } else {
      if ((timeline.secFlowSteps.get(sIdx)?.[step] ?? 0) <= 0) {
        return;
      }
    }
  }
  const set = flowsSet();
  if (!set) return;
  const isFerry =
    set.bb[sIdx * 4 + 1] < 20.15 &&
    set.bb[sIdx * 4 + 3] > 20.20 &&
    set.bb[sIdx * 4] > 110.0 &&
    set.bb[sIdx * 4 + 2] < 110.3;
  const destSecCounts = getDestSectionCounts(M);
  const subN = destSecCounts ? destSecCounts.get(sIdx) : undefined;
  const effectiveN = subN !== undefined && subN > 0 ? subN : n;
  const hw = widthOf(effectiveN) + 1.6;
  ctx.lineWidth = hw;
  if (isFerry) {
    // Overland portions of the ferry route highlighted in standard flowHi
    ctx.strokeStyle = pal.flowHi;
    ctx.lineCap = "round";
    ctx.setLineDash([]);
    ctx.beginPath();
    traceInto(M, ctx, set.pts, set.off[sIdx], set.len[sIdx], "landOnly");
    ctx.stroke();

    // Open-water crossing highlighted in luminous water blue
    ctx.strokeStyle = P.current.dark ? "#7DD3FC" : "#0284C7";
    ctx.lineCap = "butt";
    ctx.setLineDash([Math.max(12, hw * 2.5), Math.max(9, hw * 1.8)]);
    ctx.beginPath();
    traceInto(M, ctx, set.pts, set.off[sIdx], set.len[sIdx], "waterOnly");
    ctx.stroke();
  } else {
    ctx.strokeStyle = pal.flowHi;
    ctx.lineCap = "round";
    ctx.setLineDash([]);
    ctx.beginPath();
    traceInto(M, ctx, set.pts, set.off[sIdx], set.len[sIdx]);
    ctx.stroke();
  }
  ctx.lineCap = "round";
  ctx.setLineDash([]);
}
