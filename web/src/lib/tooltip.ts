/* Tooltip HTML builders (pure). */
import type {
  AtlasData,
  CityPointVM,
  DestVM,
  Direction,
  DistUnit,
  Hit,
  OriginVM,
  SrcVM,
} from "../types";
import {
  esc,
  sourceRowsHtml,
  stationRowsHtml,
} from "./format";
import { stationLabel } from "./geo";

export interface TooltipInput {
  data: AtlasData;
  cur: OriginVM;
  direction: Direction;
  distUnit: DistUnit;
  panelDest: CityPointVM | null;
  dark: boolean;
  /** The hovered section is the Qiongzhou Strait ferry corridor. */
  ferry: boolean;
}

export function tooltipHtml(hit: Hit, t: TooltipInput): string {
  const cur = t.cur;
  const data = t.data;
  let html = "";
  if (hit.kind === "origin") {
    html =
      "<div class='t-title'>" +
      esc(cur.o.zh) +
      " &middot; " +
      esc(cur.en) +
      "</div>" +
      (t.direction === "out"
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
    if (t.panelDest && t.panelDest.idx === c.idx) {
      const isOrigin = data.origins.some((o) => o.zh === c.zh);
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
        (t.direction === "out"
          ? stationRowsHtml(c as DestVM, cur.en, t.distUnit)
          : sourceRowsHtml(c as SrcVM, cur.en, t.distUnit));
    }
  } else if (hit.kind === "chord") {
    const ch = hit.chord;
    html =
      "<div class='t-title'>" +
      esc(stationLabel(data, ch.a)) +
      " &rarr; " +
      esc(stationLabel(data, ch.b)) +
      "</div>" +
      "<table>" +
      "<tr><td>Trains / day</td><td>" +
      ch.n +
      "</td></tr>" +
      "</table>" +
      "<div class='t-sub'>No track routing &mdash; drawn straight</div>";
  } else if (hit.kind === "seg") {
    if (hit.subN !== undefined && hit.subN > 0 && t.panelDest) {
      const destName = t.panelDest.en;
      html =
        "<div class='t-title'>" +
        hit.subN +
        (hit.subN === 1 ? " train" : " trains") +
        (t.direction === "out" ? " to " : " from ") +
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
    if (t.ferry) {
      const blueCol = t.dark ? "#38BDF8" : "#0284C7";
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
  return html;
}
