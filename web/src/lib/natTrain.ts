/* The tooltip's train view-model for one national dot (P2.3): code, ends,
   times, progress and dwell, from the national timeline and the schedules, so
   the origin tooltip builder (tooltipHtml) is reused as is. */
import type { ActiveTrainVM, AtlasData, NationalTimeline, SchedulesData } from "../types";
import { fmtClock } from "./format";
import { nat, natState } from "./national";

const CLS = ["G", "K", ""];

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
  natState(tl, q, a);
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
    progressPct: tl.total[q] > 0 ? Math.round((nat.dist / tl.total[q]) * 100) : 0,
  };
  if (nat.dwell) {
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
  }
  return vm;
}
