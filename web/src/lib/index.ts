/* Pure logic for the atlas: polyline decoding, per-origin view-models,
   palettes, the travel-time ramp, and value formatting. Re-exports the
   concern modules so callers import from "./lib". */
export {
  enName,
  esc,
  fmtClock,
  fmtDist,
  fmtTime,
  formatHoursLabel,
  formatScheduleStops,
  rowTrainIdx,
  sourceRows,
  sourceRowsHtml,
  stationRows,
  stationRowsHtml,
  trainOrigins,
} from "./format";
export {
  STATION_R_MAX,
  STATION_R_MIN,
  WIDTH_K,
  flowColor,
  flowWidth,
  palette,
  rampColor,
  stationR,
  stationZoomK,
} from "./palette";
export {
  DATA_FMT,
  decodeFlat,
  decodeFlows,
  decodeSecs,
  decodeSet,
  expandInTables,
  expandOutTables,
  flatBB,
  prepAtlas,
  prepOutline,
  requireFmt,
} from "./decode";
export {
  haversineKm,
  stationLabel,
  stationName,
} from "./geo";
export {
  FLOW_CLASSES,
  buildOrigin,
  classIndex,
  prepOrigin,
} from "./origin";
export {
  buildDayTimeline,
  trainDistAt,
  trainEase,
  trainSpeedFrac,
} from "./timeline";
export {
  callArrMins,
  destWindow,
  stopArrivalTimes,
  trainShownAt,
} from "./stopEffects";
export type { DestWindow } from "./stopEffects";
export {
  filterOrigin,
  filterOriginByClasses,
} from "./filter";
