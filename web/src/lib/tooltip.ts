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
  fmtSpeed,
  sourceRowsHtml,
  stationRowsHtml,
} from "./format";
import { stationLabel } from "./geo";

interface TooltipInput {
  data: AtlasData;
  cur: OriginVM;
  direction: Direction;
  distUnit: DistUnit;
  panelDest: CityPointVM | null;
  dark: boolean;
  /** The hovered section is the Qiongzhou Strait ferry corridor. */
  ferry: boolean;
  /** The hovered section's OSM line names `[name, name:en]`. */
  lines?: [string, string][];
  /** The hovered section's signed speed limit, km/h. */
  speed?: number;
}

/** Flow section `s`'s OSM line names and speed limit: national flows and
    the outbound view index `sections`, the inbound view `in_sections`. */
export function sectionInfo(
  data: AtlasData,
  view: { national?: boolean; direction: Direction },
  s: number,
): { lines: [string, string][]; speed?: number } {
  const sec = (view.national || view.direction === "out" ? data.sections : data.in_sections)[s];
  const names = data.lines ?? [];
  return {
    lines: (sec?.l ?? []).map((i) => names[i]).filter((n) => n !== undefined),
    speed: sec?.v,
  };
}

/** The section card (Signal · Section tooltip): the count, the OSM line
    names (and the ferry crossing), then the signed speed limit. Type comes
    from the map cards' classes (mc-num, mc-state, mc-sub; cards.css). */
function sectionCardHtml(hit: Extract<Hit, { kind: "seg" }>, t: TooltipInput): string {
  const sub = hit.subN !== undefined && hit.subN > 0 && t.panelDest;
  const n = sub ? hit.subN! : hit.n;
  const what =
    (n === 1 ? "train" : "trains") +
    (sub ? (t.direction === "out" ? " to " : " from ") + esc(t.panelDest!.en) : " per day");
  const kicker = sub ? "of " + hit.n + " on this section" : "on this section";
  let html =
    "<div class='sc-head'><div class='sc-n mc-num'>" + n + "</div>" +
    "<div class='sc-what'><div class='sc-label'>" + what + "</div>" +
    "<div class='mc-state'>" + kicker + "</div></div>" +
    "<div class='sc-swatch'></div></div>";
  const lines = (t.lines ?? []).map(
    ([zh, en]) =>
      "<div class='sc-line'><div class='sc-zh'>" + esc(zh) + "</div>" +
      (en ? "<div class='mc-sub'>" + esc(en) + "</div>" : "") + "</div>",
  );
  if (t.ferry) {
    lines.push(
      "<div class='sc-line sc-ferry'><div class='sc-zh'>粤海铁路轮渡</div>" +
        "<div class='mc-sub'>Guangdong–Hainan Train Ferry &middot; Qiongzhou Strait crossing</div></div>",
    );
  }
  if (lines.length) html += "<div class='sc-body'>" + lines.join("") + "</div>";
  if (t.speed) {
    const [v, unit] = fmtSpeed(t.speed, t.distUnit).split(" ");
    html +=
      "<div class='sc-foot'><span class='mc-state'>Line speed limit</span>" +
      "<span class='sc-speed'><b>" + v + "</b> " + unit + "</span></div>";
  }
  return html;
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
    html = sectionCardHtml(hit, t);
  } else if (hit.kind === "natCity") {
    const c = data.city_table[hit.idx];
    html =
      "<div class='t-title'>" +
      esc(c.zh) +
      " &middot; " +
      esc(c.en) +
      "</div><div>" +
      hit.dep.toLocaleString("en-US") +
      (hit.dep === 1 ? " departure" : " departures") +
      " &middot; " +
      hit.arr.toLocaleString("en-US") +
      (hit.arr === 1 ? " arrival" : " arrivals") +
      "</div>";
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
      (tr.legKmh
        ? `<tr><td>Speed (leg avg)</td><td style='text-align:right'>~${fmtSpeed(tr.legKmh, t.distUnit)}</td></tr>`
        : "") +
      (tr.trackKmh
        ? `<tr><td>Track limit</td><td style='text-align:right'>${fmtSpeed(tr.trackKmh, t.distUnit)}</td></tr>`
        : "") +
      "</table>" +
      `<div class='t-sub' style='margin-top:6px;color:${badgeColor};font-weight:600;'>Click train to inspect full station schedule</div>`;
  }
  return html;
}
