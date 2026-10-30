/* The tooltip's train view-model for one national dot (P2.3): code, ends,
   times, progress and dwell, from the national timeline and the schedules, so
   the origin tooltip builder (tooltipHtml) is reused as is. */
import type { ActiveTrainVM, AtlasData, NationalTimeline, SchedulesData } from "../types";
import { fmtClock } from "./format";
import { natMotion, natState } from "./national";

const CLS = ["G", "K", ""];
const scratch = natMotion();

/** Train q of `tl` at absolute minute `a`, at lon / lat with unit direction (ux, uy). */
export function natTrainVM(
  tl: NationalTimeline,
  data: AtlasData,
  sched: SchedulesData["schedules"],
  q: number,
  a: number,
  lon: number,
  lat: number,
  ux: number,
  uy: number,
): ActiveTrainVM {
  const t = tl.tIdx[q];
  const sd = sched[t];
  const s0 = tl.sOff[q];
  const nStops = tl.sOff[q + 1] - s0;
  const b = sd.length - 1 - nStops;
  const st = data.station_table;
  const from = st[sd[b][0]];
  const to = st[sd[sd.length - 1][0]];
  const row = data.train_table[t];
  const m = natState(tl, q, a, scratch);
  const vm: ActiveTrainVM = {
    lon,
    lat,
    heading: Math.atan2(uy, ux),
    cls: row?.class || CLS[tl.cls[q]],
    code: row?.code || "",
    fromStation: from?.zh || "",
    fromStationEn: from?.en,
    toStation: to?.zh || "",
    toStationEn: to?.en,
    depTime: fmtClock(tl.start[q] % 1440),
    arrTime: fmtClock(tl.end[q] % 1440),
    durMins: Math.round(tl.end[q] - tl.start[q]),
    progressPct: tl.total[q] > 0 ? Math.round((m.dist / tl.total[q]) * 100) : 0,
  };
  if (m.dwell) {
    for (let i = 0; i < nStops; i++) {
      const arr = tl.sArr[s0 + i], dep = tl.sDep[s0 + i];
      if (dep >= 0 && dep > arr && a >= arr && a <= dep) {
        const s = st[sd[b + 1 + i][0]];
        vm.isDwelling = true;
        vm.dwellStation = s?.zh || "";
        vm.dwellStationEn = s?.en;
        vm.dwellStatus = "stop";
        vm.dwellDetail = `${fmtClock(arr % 1440)} - ${fmtClock(dep % 1440)}`;
        break;
      }
    }
  } else {
    // the leg ahead: the first stop not yet reached
    for (let i = 0; i < nStops; i++) {
      if (a < tl.sArr[s0 + i]) {
        vm.legKmh = sd[b + 1 + i][5] || undefined;
        break;
      }
    }
    vm.trackKmh = sectionAt(tl, data, q, m.dist);
  }
  return vm;
}

/** The signed speed limit of the flow section at route distance d of train
    q (natXY's entry search); undefined on a throat or an untagged section. */
function sectionAt(tl: NationalTimeline, data: AtlasData, q: number, d: number): number | undefined {
  let lo = tl.pOff[q], hi = tl.pOff[q + 1] - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl.pStart[mid] <= d) lo = mid; else hi = mid - 1;
  }
  const v = tl.pId[lo];
  const id = v < 0 ? ~v : v;
  return id < data.sections.length ? data.sections[id].v : undefined;
}
