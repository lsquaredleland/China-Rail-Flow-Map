/* Pure logic for the atlas: polyline decoding, per-origin view-models,
   palettes, the travel-time ramp, and value formatting. Re-exports the
   concern modules so callers import from "./lib". */
export {
  enName,
  esc,
  fmtCalendarSpan,
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
  WIDTH_KNEE,
  flowColor,
  flowUnits,
  flowWidth,
  palette,
  paletteRGBA,
  rampColor,
  rgba,
  stationR,
  NAT_CITY_R_MIN,
  natCityR,
  stationZoomK,
} from "./palette";
export type { PaletteRGBA, RGBA } from "./palette";
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
  prepTrainPath,
  trainDistAt,
} from "./timeline";
export { buildNational, nat, natPositions, natState, natXY, requireNationalTrains } from "./national";
export { natTrainVM } from "./natTrain";
export {
  NAT_DIST_BINS,
  NAT_DIST_SIZE,
  NAT_DUR_BINS,
  NAT_HOUR_BINS,
  natFilterKey,
  natFlowCounts,
  natCityCounts,
  natHistogram,
  natIndexActive,
  natSelect,
  requireNationalIndex,
} from "./nationalIndex";
export type { NatFilter } from "./nationalIndex";
export {
  nationalCounts,
  nationalCountsAt,
  nationalFlowPasses,
  nationalWidths,
  nationalCityCounts,
  natCityTier,
  NAT_CITY_TOP,
  NAT_CITY_ALL_ZOOM,
  NAT_WIDTH_FACTOR,
  requireNationalEntries,
  requireNationalFlows,
} from "./nationalFlows";
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
export {
  fitCountryView,
  fitExtentView,
  fitGuangzhouInitialView,
  fitHomeView,
  stationT,
  viewStateToView,
  viewToViewState,
  zoomBounds,
} from "./camera";
export type { Extent, View, ViewState } from "./camera";
export { isFerrySection, isWaterCross, splitFerry } from "./ferry";
export type { FerryPiece } from "./ferry";
export { tooltipHtml } from "./tooltip";
export type { TooltipInput } from "./tooltip";
export {
  activeTimeline,
  animStep,
  chordPlan,
  chordVisible,
  flowPasses,
  flowsOf,
  getActiveDestSectionCounts,
  getDestSectionCounts,
  highlightSegN,
  infraPasses,
  isFilteredView,
  isolatedCorridor,
  isolatedTrain,
  newModelCaches,
  pickableChords,
  pickableFlows,
} from "./mapModel";
export type {
  ChordPlan,
  FlowItem,
  FlowPass,
  InfraPass,
  IsolatedCorridor,
  ModelCaches,
  ModelState,
} from "./mapModel";
export {
  computeAllowedTrainCodes,
  computeCityAllowedArrivalTimes,
  computeDestWindow,
  getSelCache,
  isTrainShown,
  stationStates,
} from "./mapModel";
export type { SelCache, SelInput, StationInput, StationState } from "./mapModel";
export { placeLabels } from "./labels";
export type { LabelOptions, LabelStyle, Measure, PlacedLabel } from "./labels";
export { SEG_TIE_PX, TRAIN_RADIUS, distToLine, distToSeg, pickPriority } from "./pick";
export type { PickCandidate, PickKind, PickLine, PickOptions, PickView } from "./pick";
