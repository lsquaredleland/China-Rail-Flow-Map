/* Hit-testing and the floating tooltip. */
import type {
  ActiveTrainVM,
  ChordVM,
  CityPointVM,
  DestVM,
  FlowVM,
  Hit,
  SrcVM,
} from "../../types";
import {
  esc,
  sourceRowsHtml,
  stationLabel,
  stationR,
  stationZoomK,
  stationRowsHtml,
  trainDistAt,
} from "../../lib";
import type { MapCtx } from "./context";
import { stationT } from "./camera";
import { getActiveDestSectionCounts, getDestSectionCounts } from "./flows";
import { getAllowedTrainCodes } from "./trains";


/* ---------- hit testing & tooltip ---------- */
export function distToSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px,
    ey = ay + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}

export function pickStation(M: MapCtx, px: number, py: number): Hit | null {
  const { S, P, X, Y, points } = M;
  const cur = P.current.cur;
  if (!cur) return null;
  const { W, H } = S.current;
  const pts = points();
  let best: CityPointVM | null = null;
  const sk = stationT(M);
  let bestD2 = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i];
    const x = X(c.pt[0]),
      y = Y(c.pt[1]);
    if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
    const dx = px - x,
      dy = py - y,
      d2 = dx * dx + dy * dy;
    const hitR = 14 * stationZoomK(stationR(c.trains), sk);
    if (d2 <= hitR * hitR && d2 <= bestD2) {
      best = c;
      bestD2 = d2;
    }
  }
  const cx = X(cur.o.pt[0]),
    cy = Y(cur.o.pt[1]);
  const odx = px - cx,
    ody = py - cy,
    od2 = odx * odx + ody * ody;
  if (od2 <= 15 * 15 && (best === null || od2 <= bestD2))
    return { kind: "origin" };
  return best ? { kind: "station", station: best } : null;
}

export function pickSegment(M: MapCtx, px: number, py: number): Hit | null {
  const { S, P, X, Y, toLon, toLat, flowsList, activeTimeline, flowsSet } = M;
  const atlas = P.current.atlas;
  const cur = P.current.cur;
  const set = flowsSet();
  if (!atlas || !cur || !set) return null;
  const sec = set;
  const flows = flowsList();
  const lon = toLon(px),
    lat = toLat(py);
  const thrDeg = 12 / S.current.view.scale;
  let segBest: FlowVM | null = null;
  let bestDist = 10;
  let i: number, k: number;
  const destSecCounts = getDestSectionCounts(M);
  const st = S.current;
  const isAnimated = st.animEnabled && !P.current.showInfra;
  const timeline = activeTimeline();
  const step =
    isAnimated && timeline
      ? Math.min(
          timeline.numSteps - 1,
          Math.max(0, Math.floor(st.animTime / timeline.stepMins)),
        )
      : 0;

  let activeDestCounts: Map<number, number> | null = null;
  if (destSecCounts && isAnimated && timeline && st.animTime < timeline.totalMins) {
    activeDestCounts = getActiveDestSectionCounts(M, st.animTime);
  }

  let activeIsoSecs: Set<number> | null = null;
  if (P.current.isolatedTrainCode && isAnimated && timeline && st.animTime < timeline.totalMins) {
    activeIsoSecs = new Set<number>();
    const isoTrain = (P.current.direction === "out" ? cur.deps : cur.arrs).find(
      (t) => t.code === P.current.isolatedTrainCode,
    );
    const isoPt = isoTrain ? timeline.getPrepTrain(isoTrain.code) : undefined;
    if (isoTrain && isoPt && st.animTime >= isoTrain.depMins) {
      const targetDist = trainDistAt(isoPt, st.animTime);
      const secStarts = isoPt.secStarts;
      let curSecIdx = 0;
      while (
        curSecIdx < isoPt.secs.length - 1 &&
        secStarts[curSecIdx + 1] <= targetDist
      ) {
        curSecIdx++;
      }
      for (let j = 0; j <= curSecIdx; j++) {
        activeIsoSecs.add(isoPt.secs[j]);
      }
    }
  }

  for (i = 0; i < flows.length; i++) {
    const f = flows[i];
    const s = f.s;
    // When a city pair is selected, restrict segment picking ONLY to sections that belong to the city pair
    if (
      destSecCounts &&
      (!destSecCounts.has(s) || (destSecCounts.get(s) ?? 0) <= 0)
    ) {
      continue;
    }
    if (isAnimated && timeline && st.animTime < timeline.totalMins) {
      if (activeDestCounts) {
        if ((activeDestCounts.get(s) ?? 0) <= 0) continue;
      } else if (activeIsoSecs !== null) {
        if (!activeIsoSecs.has(s)) continue;
      } else {
        const activeN = timeline.secFlowSteps.get(s)?.[step] ?? 0;
        if (activeN <= 0) continue;
      }
    }
    if (
      lon < sec.bb[s * 4] - thrDeg ||
      lon > sec.bb[s * 4 + 2] + thrDeg ||
      lat < sec.bb[s * 4 + 1] - thrDeg ||
      lat > sec.bb[s * 4 + 3] + thrDeg
    )
      continue;
    const off = sec.off[s],
      cnt = sec.len[s];
    for (k = 0; k + 1 < cnt; k++) {
      const d = distToSeg(
        px,
        py,
        X(sec.pts[off + k * 2]),
        Y(sec.pts[off + k * 2 + 1]),
        X(sec.pts[off + k * 2 + 2]),
        Y(sec.pts[off + k * 2 + 3]),
      );
      if (
        d < bestDist - 0.75 ||
        (d <= bestDist + 0.75 && segBest && f.n > segBest.n)
      ) {
        if (d < bestDist || (segBest && f.n > segBest.n)) {
          segBest = f;
          bestDist = Math.min(d, bestDist);
        }
      }
    }
  }
  if (segBest) {
    const destSecCounts = getDestSectionCounts(M);
    const subN =
      destSecCounts && destSecCounts.has(segBest.s)
        ? destSecCounts.get(segBest.s)
        : undefined;
    return { kind: "seg", s: segBest.s, n: segBest.n, subN };
  }
  if (P.current.direction !== "out" || destSecCounts) return null;
  let chordBest: ChordVM | null = null;
  for (i = 0; i < cur.chords.length; i++) {
    const ch = cur.chords[i];
    if (isAnimated && timeline && st.animTime < timeline.totalMins) {
      if (P.current.isolatedTrainCode) {
        const isoTrain = cur.deps?.find((t) => t.code === P.current.isolatedTrainCode);
        if (!isoTrain || isoTrain.tcIdx !== ch.b || st.animTime < isoTrain.depMins) {
          continue;
        }
      } else {
        const destTrains = (cur.deps || []).filter((d) => d.tcIdx === ch.b);
        const hasDeparted = destTrains.some((d) => st.animTime >= d.depMins);
        if (!hasDeparted) continue;
      }
    }
    if (
      lon < ch.bb.x0 - thrDeg ||
      lon > ch.bb.x1 + thrDeg ||
      lat < ch.bb.y0 - thrDeg ||
      lat > ch.bb.y1 + thrDeg
    )
      continue;
    for (k = 0; k + 1 < ch.count; k++) {
      const dd = distToSeg(
        px,
        py,
        X(ch.flat[k * 2]),
        Y(ch.flat[k * 2 + 1]),
        X(ch.flat[k * 2 + 2]),
        Y(ch.flat[k * 2 + 3]),
      );
      if (dd < bestDist) {
        chordBest = ch;
        bestDist = dd;
      }
    }
  }
  return chordBest ? { kind: "chord", chord: chordBest } : null;
}

export function pickTrain(M: MapCtx, px: number, py: number): Hit | null {
  const { S, P, X, Y, activeTimeline, activeTrainsAt } = M;
  const st = S.current;
  // Paused only: moving train tooltips are strictly active when visualization is paused
  if (!st.animEnabled || st.animPlaying) return null;
  const cur = P.current.cur;
  if (!cur) return null;
  const timeline = activeTimeline();
  if (!timeline) return null;
  const activeTrains = activeTrainsAt(timeline, st.animTime);
  if (!activeTrains || activeTrains.length === 0) return null;

  const allowedCodes = getAllowedTrainCodes(M);
  let bestDist = 14;
  let bestTrain: ActiveTrainVM | null = null;
  for (let i = 0; i < activeTrains.length; i++) {
    const tr = activeTrains[i];
    if (allowedCodes && !allowedCodes.has(tr.code)) {
      continue;
    }
    const tx = X(tr.lon);
    const ty = Y(tr.lat);
    const d = Math.hypot(px - tx, py - ty);
    if (d < bestDist) {
      bestDist = d;
      bestTrain = tr;
    }
  }
  return bestTrain ? { kind: "train", train: bestTrain } : null;
}

export function pick(M: MapCtx, px: number, py: number): Hit | null {
  const tr = pickTrain(M, px, py);
  if (tr) return tr;
  const c = pickStation(M, px, py);
  if (c) return c;
  return pickSegment(M, px, py);
}

export function showTooltip(M: MapCtx, hit: Hit, px: number, py: number) {
  const { S, P, flowsSet, tooltipRef } = M;
  const atlas = P.current.atlas;
  const cur = P.current.cur;
  const tooltip = tooltipRef.current;
  if (!atlas || !cur || !tooltip) return;
  const st = S.current;
  st.lastTip = { hit, x: px, y: py };
  let html = "";
  if (hit.kind === "origin") {
    html =
      "<div class='t-title'>" +
      esc(cur.o.zh) +
      " &middot; " +
      esc(cur.en) +
      "</div>" +
      (P.current.direction === "out"
        ? "<div>The origin &mdash; " +
          cur.o.outbound +
          " trains a day leave " +
          esc(cur.en) +
          " for " +
          cur.dests.length +
          " cities, no change of train.</div>"
        : "<div>The destination &mdash; " +
          cur.o.inbound +
          " trains a day arrive in " +
          esc(cur.en) +
          " from " +
          cur.srcs.length +
          " cities, no change of train.</div>");
  } else if (hit.kind === "station") {
    const c = hit.station;
    if (P.current.panelDest && P.current.panelDest.idx === c.idx) {
      const isOrigin = atlas.data.origins.some((o) => o.zh === c.zh);
      html =
        "<div class='t-title'>" +
        esc(c.zh) +
        " &middot; " +
        esc(c.en) +
        "</div><div class='t-sub'>" +
        (isOrigin
          ? "Click again to set as origin city"
          : "Click again to clear selection") +
        "</div>";
    } else {
      html =
        "<div class='t-title'>" +
        esc(c.zh) +
        " &middot; " +
        esc(c.en) +
        "</div>" +
        (P.current.direction === "out"
          ? stationRowsHtml(c as DestVM, cur.en, P.current.distUnit)
          : sourceRowsHtml(c as SrcVM, cur.en, P.current.distUnit));
    }
  } else if (hit.kind === "chord") {
    const ch = hit.chord;
    html =
      "<div class='t-title'>" +
      esc(stationLabel(atlas.data, ch.a)) +
      " &rarr; " +
      esc(stationLabel(atlas.data, ch.b)) +
      "</div>" +
      "<table>" +
      "<tr><td>Trains / day</td><td>" +
      ch.n +
      "</td></tr>" +
      "</table>" +
      "<div class='t-sub'>No track routing &mdash; drawn straight</div>";
  } else if (hit.kind === "seg") {
    const set = flowsSet();
    const isFerry =
      set &&
      set.bb[hit.s * 4 + 1] < 20.15 &&
      set.bb[hit.s * 4 + 3] > 20.20 &&
      set.bb[hit.s * 4] > 110.0 &&
      set.bb[hit.s * 4 + 2] < 110.3;

    if (hit.subN !== undefined && hit.subN > 0 && P.current.panelDest) {
      const destName = P.current.panelDest.en;
      html =
        "<div class='t-title'>" +
        hit.subN +
        (hit.subN === 1 ? " train" : " trains") +
        (P.current.direction === "out" ? " to " : " from ") +
        esc(destName) +
        " <span style='opacity:0.75;font-size:0.9em'>(of " +
        hit.n +
        " total)</span></div>";
    } else {
      html =
        "<div class='t-title'>" +
        hit.n +
        (hit.n === 1 ? " train" : " trains") +
        " per day on this section</div>";
    }
    if (isFerry) {
      const blueCol = P.current.dark ? "#38BDF8" : "#0284C7";
      html +=
        `<div class='t-sub' style='color:${blueCol};font-weight:600'>` +
        "粤海铁路轮渡 (Guangdong–Hainan Train Ferry) &middot; Qiongzhou Strait crossing</div>";
    }
  } else if (hit.kind === "train") {
    const tr = hit.train;
    const isHighSpeed = tr.cls === "G" || tr.cls === "D" || tr.cls === "C";
    const badgeColor = isHighSpeed ? "#F59E0B" : "#0284C7";
    const fromDisplay =
      tr.fromStationEn && tr.fromStationEn !== tr.fromStation
        ? `${esc(tr.fromStation)} <span style='font-size:11px;font-weight:400;opacity:0.8;'>(${esc(tr.fromStationEn)})</span>`
        : esc(tr.fromStation || "");
    const toDisplay =
      tr.toStationEn && tr.toStationEn !== tr.toStation
        ? `${esc(tr.toStation)} <span style='font-size:11px;font-weight:400;opacity:0.8;'>(${esc(tr.toStationEn)})</span>`
        : esc(tr.toStation || "");
    const dwellName =
      tr.dwellStationEn && tr.dwellStationEn !== tr.dwellStation
        ? `${esc(tr.dwellStation || "")} (${esc(tr.dwellStationEn)})`
        : esc(tr.dwellStation || "");

    html =
      "<div class='t-title' style='display:flex;align-items:center;gap:6px;margin-bottom:6px;'>" +
      `<span style='background:${badgeColor};color:#fff;padding:2px 7px;border-radius:4px;font-size:12px;font-weight:700;font-family:monospace;'>${esc(tr.code)}</span>` +
      `<span style='font-size:13px;font-weight:600;'>${fromDisplay} &rarr; ${toDisplay}</span>` +
      "</div>" +
      (tr.isDwelling
        ? (tr.dwellStatus === "origin"
          ? `<div style='font-size:12px;color:#F59E0B;font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:4px;'><span>🛑</span> Boarding at ${dwellName} &middot; ${esc(tr.dwellDetail || "")}</div>`
          : tr.dwellStatus === "dest"
            ? `<div style='font-size:12px;color:#10B981;font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:4px;'><span>🏁</span> Arrived at ${dwellName} &middot; Final Stop</div>`
            : `<div style='font-size:12px;color:#F59E0B;font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:4px;'><span>🛑</span> Boarding at ${dwellName}${tr.dwellDetail ? ` &middot; ${esc(tr.dwellDetail)}` : ""}</div>`)
        : "") +
      (tr.onChord
        ? "<div style='font-size:12px;color:#9CA3AF;margin-bottom:6px;'>No track geometry on this leg (straight-line stand-in)</div>"
        : "") +
      "<table style='width:100%;margin-bottom:4px;'>" +
      `<tr><td>Departure</td><td style='text-align:right'><b>${esc(tr.depTime)}</b></td></tr>` +
      `<tr><td>Arrival</td><td style='text-align:right'><b>${esc(tr.arrTime)}</b></td></tr>` +
      `<tr><td>Duration</td><td style='text-align:right'>${Math.floor(tr.durMins / 60)}h ${tr.durMins % 60}m</td></tr>` +
      `<tr><td>Journey Progress</td><td style='text-align:right'><b>${tr.progressPct}%</b></td></tr>` +
      "</table>" +
      `<div class='t-sub' style='margin-top:6px;color:${badgeColor};font-weight:600;'>Click train to inspect full station schedule</div>`;
  }
  tooltip.innerHTML = html;
  tooltip.classList.add("show");
  const tw = tooltip.offsetWidth,
    th = tooltip.offsetHeight;
  let x = px + 14,
    y = py + 14;
  if (x + tw > st.W - 6) x = px - tw - 10;
  if (y + th > st.H - 6) y = py - th - 10;
  tooltip.style.left = Math.max(4, x) + "px";
  tooltip.style.top = Math.max(4, y) + "px";
}

export function hideTooltip(M: MapCtx) {
  const { S, tooltipRef } = M;
  const tooltip = tooltipRef.current;
  if (tooltip) tooltip.classList.remove("show");
  S.current.pinned = false;
}

export function sameHit(a: Hit | null, b: Hit | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "seg" && b.kind === "seg") return a.s === b.s;
  if (a.kind === "chord" && b.kind === "chord") return a.chord === b.chord;
  if (a.kind === "train" && b.kind === "train") return a.train.code === b.train.code;
  if (a.kind === "station" && b.kind === "station")
    return a.station === b.station;
  return true; // origin
}
