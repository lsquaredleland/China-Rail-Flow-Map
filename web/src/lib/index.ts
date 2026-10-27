/* Pure logic for the atlas: polyline decoding, per-origin view-models,
   palettes, the travel-time ramp, and value formatting. Re-exports the
   concern modules so callers import from "./lib". */
export {
  enName,
  esc,
  fmtCalendarSpan,
  fmtClock,
  fmtDist,
  fmtDurationWords,
  fmtTime,
  formatHoursLabel,
  formatScheduleStops,
  sourceRows,
  sourceRowsHtml,
  stationName,
  stationRows,
  stationRowsHtml,
  trainOrigins,
} from "./format";
export {
  WIDTH_K,
  WIDTH_KNEE,
  flowColor,
  flowUnits,
  flowWidth,
  zoomWidthScale,
  ZOOM_WIDTH_KNEE,
  palette,
  paletteRGBA,
  rampColor,
  rgba,
  stationR,
  NAT_CITY_R_MIN,
  natCityR,
  stationZoomK,
} from "./palette";
export type { RGBA } from "./palette";
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
} from "./geo";
export {
  FLOW_CLASSES,
  buildOrigin,
  classIndex,
} from "./origin";
export {
  buildDayTimeline,
  prepTrainPath,
  trainDistAt,
  trainSpeedFrac,
} from "./timeline";
export { buildNational, nat, natPositions, natState, natXY, requireNationalTrains } from "./national";
export { natTrainVM } from "./natTrain";
export { buildNatRows, natHistRows, selectNatRows, sortNatRows } from "./natTable";
export type { HistRow, NatRow, NatSortKey } from "./natTable";
export { runRank, runDays } from "./runDays";

export {
  NAT_DIST_SIZE,
  natFilterKey,
  natFlowCounts,
  natCityCounts,
  natCityEvents,
  natCityEventsAt,
  natHistogram,
  natIndexActive,
  natSelect,
  requireNationalIndex,
} from "./nationalIndex";
export type { NatFilter, NatCityEvents } from "./nationalIndex";
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
export type { Extent, View } from "./camera";
export { isFerrySection, splitFerry } from "./ferry";

export { tooltipHtml } from "./tooltip";

export {
  activeTimeline,
  animStep,
  chordPlan,
  chordVisible,
  flowPasses,
  getActiveDestSectionCounts,
  getDestSectionCounts,
  highlightSegN,
  infraPasses,
  isFilteredView,
  isoFlowAlpha,
  isolatedCorridor,
  newModelCaches,
  pickableChords,
  pickableFlows,
} from "./mapModel";
export type {
  FlowItem,
  FlowPass,
  InfraPass,
  ModelCaches,
  ModelState,
} from "./mapModel";
export {
  getSelCache,
  isTrainShown,
  stationStates,
} from "./mapModel";
export type { SelCache, SelInput, StationInput, StationState } from "./mapModel";
export { placeLabels } from "./labels";
export type { LabelPoint } from "./labels";
export { TRAIN_RADIUS, distToLine, distToSeg, pickPriority } from "./pick";
export type { PickCandidate } from "./pick";
export { tripStatus, unrollStops } from "./tripStatus";
export type { AlignedStop } from "./tripStatus";
