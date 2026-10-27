/* Display strings: city names, HTML escaping, clock / duration / distance
   formatting and the tooltip row builders. */
import type {
  DecodedAtlas,
  DestVM,
  DistUnit,
  ScheduleStop,
  SchedulesData,
  SrcVM,
} from "../types";

/* ---------- names & escaping ---------- */

// The data's romanizations for a few famous places, in the form readers know.
const EN_FIX: Record<string, string> = {
  Lasa: "Lhasa",
  Wulumuqi: "Ürümqi",
  Xianggang: "Hong Kong",
};
export function enName(en: string): string {
  return EN_FIX[en] || en;
}

/** Train-table index of a raw dep/arr row. The one place that knows the
    row layout, so a row-format change only touches this. */
function rowTrainIdx(row: readonly unknown[]): number {
  return row[0] as number;
}

const trainOriginIndex = new WeakMap<object, Map<string, number[]>>();

/** Train code (lowercased) -> origin indices whose dep rows (outbound) or
    arr rows (inbound) include it. Built once per atlas and direction; call
    only after that direction's tables have loaded. */
export function trainOrigins(
  atlas: DecodedAtlas,
  dir: "out" | "in",
): Map<string, number[]> {
  const key = dir === "out" ? atlas.data.origins : atlas.data.train_table;
  const cached = trainOriginIndex.get(key);
  if (cached) return cached;
  const m = new Map<string, number[]>();
  atlas.data.origins.forEach((o, oi) => {
    const seen = new Set<number>();
    for (const row of (dir === "out" ? o.deps : o.arrs) || []) {
      const t = rowTrainIdx(row);
      if (seen.has(t)) continue;
      seen.add(t);
      const code = atlas.data.train_table[t].code.toLowerCase();
      const l = m.get(code);
      if (l) l.push(oi);
      else m.set(code, [oi]);
    }
  });
  trainOriginIndex.set(key, m);
  return m;
}

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


/** How a station's two names read: "zh-en" 重庆北 Chongqing North, "en-zh"
    Chongqing North 重庆北, "zh-paren" 重庆北 (Chongqing North). One name when
    the English is missing or identical. */
type NameOrder = "zh-en" | "en-zh" | "zh-paren";
export function stationName(zh: string, en: string | undefined, order: NameOrder): string {
  if (!en || en === zh) return zh;
  return order === "zh-en" ? `${zh} ${en}` : order === "en-zh" ? `${en} ${zh}` : `${zh} (${en})`;
}

/** Minutes as words: "45 min", "1 h", "1 h 5 min". */
export function fmtDurationWords(m: number): string {
  const r = Math.max(0, Math.round(m));
  return r >= 60 ? `${Math.floor(r / 60)} h ${r % 60 ? (r % 60) + " min" : ""}`.trim() : `${r} min`;
}

export function fmtTime(m: number | null | undefined): string {
  if (m === null || m === undefined || m < 0 || isNaN(m)) return "—";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h + ":" + (mm < 10 ? "0" : "") + mm;
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** "06:00–07:00" for one hour or a consecutive run, "06:00, 09:00" otherwise. */
export function formatHoursLabel(hours: number[]): string {
  if (hours.length === 0) return "";
  if (hours.length === 1) {
    const h = hours[0];
    return `${pad2(h)}:00–${pad2(h + 1)}:00`;
  }
  const sorted = [...hours].sort((a, b) => a - b);
  const isConsecutive = sorted.every(
    (h, i) => i === 0 || h === sorted[i - 1] + 1,
  );
  if (isConsecutive) {
    return `${pad2(sorted[0])}:00–${pad2(sorted[sorted.length - 1] + 1)}:00`;
  }
  return sorted.map((h) => `${pad2(h)}:00`).join(", ");
}

/** Minutes since midnight → zero-padded "HH:MM" clock time, the display
    form of every clock field in the v2 data (which stores raw minutes). */
export function fmtClock(m: number | null | undefined): string {
  if (m === null || m === undefined || m < 0 || isNaN(m)) return "—";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The schedule window of a pack's calendar (`shared.calendar`, ISO dates in
    order) as "23 Oct – 6 Nov"; undefined without a calendar (12306 packs). */
export function fmtCalendarSpan(calendar: readonly string[] | undefined): string | undefined {
  if (!calendar || calendar.length === 0) return undefined;
  const day = (iso: string) => {
    const [, m, d] = iso.split("-").map(Number);
    return `${d} ${MONTHS[m - 1]}`;
  };
  const a = day(calendar[0]);
  const b = day(calendar[calendar.length - 1]);
  return a === b ? a : `${a} – ${b}`;
}

// One value, in the unit picked on the toolbar switcher; unknown
// distances (rail_km -1, e.g. Hong Kong's unrouted tunnel leg) read
// as an em dash.
export function fmtDist(km: number | null | undefined, unit: DistUnit): string {
  if (km === null || km === undefined || km < 0 || isNaN(km)) return "—";
  if (unit === "mi")
    return Math.round(km * 0.621371).toLocaleString("en-US") + " mi";
  return km.toLocaleString("en-US") + " km";
}

/** The fact rows shared by the hover tooltip and the pinned detail panel. */
export function stationRows(
  c: DestVM,
  originEn: string,
  unit: DistUnit,
): [string, string][] {
  return [
    ["Direct trains / day", String(c.trains)],
    ["of which fast (G/D/C/S)", String(c.fast)],
    ["Trains ending here", String(c.terminating)],
    ["Fastest from " + originEn, fmtTime(c.fastest)],
    ["Median journey", fmtTime(c.median)],
    ["Crow flies", fmtDist(c.crow, unit)],
    ["By rail", fmtDist(c.rail, unit)],
  ];
}

/** stationRows as the tooltip's HTML table (the tooltip is set via innerHTML). */
export function stationRowsHtml(
  c: DestVM,
  originEn: string,
  unit: DistUnit,
): string {
  return rowsHtml(stationRows(c, originEn, unit));
}

/** The mirrored fact rows for a source city in inbound mode. */
export function sourceRows(
  c: SrcVM,
  destEn: string,
  unit: DistUnit,
): [string, string][] {
  return [
    ["Direct trains / day", String(c.trains)],
    ["of which fast (G/D/C/S)", String(c.fast)],
    ["Originate in " + c.en, String(c.originating)],
    ["Fastest to " + destEn, fmtTime(c.fastest)],
    ["Median journey", fmtTime(c.median)],
    ["Crow flies", fmtDist(c.crow, unit)],
    ["By rail", fmtDist(c.rail, unit)],
  ];
}

/** sourceRows as the tooltip's HTML table. */
export function sourceRowsHtml(
  c: SrcVM,
  destEn: string,
  unit: DistUnit,
): string {
  return rowsHtml(sourceRows(c, destEn, unit));
}

function rowsHtml(rows: [string, string][]): string {
  return (
    "<table>" +
    rows
      .map((r) => {
        const isAccent = r[0].startsWith("Fastest") || r[0] === "By rail";
        return (
          "<tr><td>" +
          esc(r[0]) +
          "</td><td" +
          (isAccent ? ' class="accent-val"' : "") +
          ">" +
          esc(r[1]) +
          "</td></tr>"
        );
      })
      .join("") +
    "</table>"
  );
}


/** Formats raw schedule integers into human-readable ScheduleStop records */
export function formatScheduleStops(
  schedulesData: SchedulesData | null,
  stationTable: { zh: string; en: string }[],
  t: number,
): ScheduleStop[] | null {
  if (!schedulesData || !schedulesData.schedules) return null;
  const rawStops = schedulesData.schedules[t];
  if (!rawStops || rawStops.length === 0) return null;

  return rawStops.map(([stIdx, arrMins, depMins, dayOff, legKm]) => {
    let stZh = "";
    let stEn = "";
    if (stIdx < stationTable.length) {
      stZh = stationTable[stIdx].zh;
      stEn = stationTable[stIdx].en;
    } else {
      const extraIdx = stIdx - stationTable.length;
      stZh =
        schedulesData.extra_stations[extraIdx] ||
        (extraIdx >= 0 ? `Station ${stIdx}` : "");
      stEn = stZh;
    }
    const arr = arrMins >= 0 ? fmtClock(arrMins) : "—";
    const dep = depMins >= 0 ? fmtClock(depMins) : "—";
    const dwellMins =
      arrMins >= 0 && depMins >= 0 ? Math.max(0, depMins - arrMins) : 0;
    return {
      stIdx,
      stZh,
      stEn,
      arr,
      dep,
      arrMins,
      depMins,
      dayOff,
      dwellMins,
      legKm: typeof legKm === "number" ? legKm : 0,
    };
  });
}
