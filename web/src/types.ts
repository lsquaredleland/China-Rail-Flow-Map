/* Types for the China Rail Flow Atlas data model and view-models.
   The raw shapes mirror the v2 dataset (assets/atlas-v2-*.json)
   exactly: shared geometry/tables plus four staged per-origin files
   (outbound map + tables, inbound map + tables) merged by index. */

/** One shared track section: encoded geometry plus optional HSR flag
    (v2 dropped the endpoint station indices). */
export interface RawSection {
  g: string; // Google-polyline-encoded track geometry, precision 1e4
  h?: number; // 1 for high-speed rail (HSR), omitted/0 for conventional rail
}

export interface RawCity {
  zh: string;
  en: string;
  pt: [number, number]; // [lon, lat] of the city's principal station point
}

export interface RawStation {
  zh: string;
  en: string;
}

export interface RawTrain {
  code: string;
  class: string; // "G" | "D" | "C" | "S" | "K" | ... | "plain"
}

/** A leg with no track routing, drawn straight. a/b are station-table indices. */
export interface RawChord {
  a: number;
  b: number;
  n: number; // trains/day
  g: string; // encoded straight-line geometry
}

/** [section index, trains/day, g?, d?, c?, s?, z?, t?, k?, plain?] */
export type RawFlow = number[];

/** One train calling at a destination city:
    [dep index into the same origin's deps, arrival minutes at the city,
     departure minutes from the city, arrival day offset from boarding day,
     1 if the train terminates in this city else 0,
     optional sec_cnt (number of section indices from origin to this stop)].
    Clock times are integer minutes since midnight. */
export type RawCall = [number, number, number, number, number, number?];

/** [city index, trains, fast, terminating, fastest min, median min, crow km, rail km]
    rail km is -1 when unknown (e.g. Hong Kong's unrouted tunnel leg). */
export type RawDest = [number, number, number, number, number, number, number, number];

/** Parallel in shape to RawDest, for a city sending trains INTO the origin:
    [city index, trains, fast, originating, fastest min, median min, crow km, rail km]. */
export type RawSrc = RawDest;

/** One train arriving in the origin city, as seen from a source city:
    [index into the origin's arrs, boarding minutes at the source city,
     arrival minutes in the origin city, arrival day offset from boarding day,
     1 if the train originates in the source city else 0, boarding-station index,
     optional sec_cnt (number of section indices from boarding stop to origin)]. */
export type RawInCall = [number, number, number, number, number, number, number?];

/** One train arriving in the origin city, positional:
    [train-table index, origin-station index (where the train truly starts),
     origin-city index, departure minutes at the true origin,
     arrival-station index in this city, arrival minutes in this city,
     duration minutes origin to this city, stops before this city,
     rail journey km from the origin; -1 when unknown]. */
export type RawArr = [
  number, number, number, number, number, number, number, number, number,
];

/** One train departing the origin city, positional:
    [train-table index, from-station index, departure minutes,
     to-station index, to-city index, arrival minutes,
     duration minutes, stops,
     exact journey distance by rail to the final stop; -1 when any leg is unrouted]. */
export type RawDep = [
  number, number, number, number, number, number, number, number, number,
];

/** One origin city, assembled by merging four staged files by index:
    the identity + outbound map fields ship in atlas-v2-out-map.json,
    the outbound per-train tables in atlas-v2-out-tables.json, the
    inbound map fields in atlas-v2-in-map.json and the inbound tables
    in atlas-v2-in-tables.json. Until a file lands, its fields are
    absent (the optional markers below). */
export interface RawOrigin {
  zh: string;
  en: string;
  pt: [number, number];
  outbound: number;
  fully_tracked: number;
  dests: RawDest[];
  calls?: RawCall[][]; // parallel to dests: calls[i] = trains calling at dests[i]'s city
  flows: RawFlow[];
  chords: RawChord[];
  deps?: RawDep[];
  dep_secs?: number[][];
  inbound: number;
  srcs?: RawSrc[];
  in_calls?: RawInCall[][]; // parallel to srcs: in_calls[i] = trains arriving from srcs[i]'s city
  in_flows?: RawFlow[]; // [index into in_sections, trains/day]
  arrs?: RawArr[];
  arr_secs?: number[][];
}

/** atlas-v2-shared.json: the tables and geometry every origin shares. */
export interface SharedData {
  city_table: RawCity[];
  station_table: RawStation[];
  train_table: RawTrain[];
  sections: RawSection[];
  in_sections: RawSection[];
  network: string[]; // encoded backdrop polylines
}

/** atlas-v2-out-map.json: every origin's identity + outbound map
    fields — the phase-1 file the first paint is built from. */
export interface OutMapData {
  origins: RawOrigin[];
}

/** One origin's entry in atlas-v2-out-tables.json. */
export interface OutTablesOrigin {
  deps: RawDep[];
  calls: RawCall[][];
  dep_secs: number[][];
}

/** atlas-v2-out-tables.json: origins parallel by index. */
export interface OutTablesData {
  origins: OutTablesOrigin[];
}

/** One origin's entry in atlas-v2-in-map.json: inbound map fields. */
export interface InMapOrigin {
  srcs: RawSrc[];
  in_flows: RawFlow[];
}

/** atlas-v2-in-map.json: origins parallel by index. */
export interface InMapData {
  origins: InMapOrigin[];
}

/** One origin's entry in atlas-v2-in-tables.json: inbound tables. */
export interface InTablesOrigin {
  arrs: RawArr[];
  in_calls: RawInCall[][];
  arr_secs: number[][];
}

/** atlas-v2-in-tables.json: origins parallel by index. */
export interface InTablesData {
  origins: InTablesOrigin[];
}

export interface AtlasData extends SharedData {
  about: string;
  origins: RawOrigin[];
}

/** A set of polylines decoded once into one typed array + offsets + bboxes. */
export interface DecodedSet {
  pts: Float32Array; // flat [lon0, lat0, lon1, lat1, ...]
  off: Int32Array; // float offset of each polyline
  len: Int32Array; // point count of each polyline
  bb: Float32Array; // [x0, y0, x1, y1] per polyline
  hsr: Uint8Array; // 1 for high-speed rail (HSR), 0 for conventional rail
}

export interface Extent {
  lon0: number;
  lat0: number;
  lon1: number;
  lat1: number;
}

export interface OutlineData {
  rings: string[];
  lines: string[];
}

export interface DecodedOutline {
  rings: DecodedSet;
  lines: DecodedSet;
}

export interface DecodedAtlas {
  data: AtlasData;
  sec: DecodedSet;
  inSec: DecodedSet;
  net: DecodedSet;
  extent: Extent;
}

export type AtlasVM = DecodedAtlas;

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FlowVM {
  s: number; // section index
  n: number; // trains/day
  byClass: number[]; // [G, D, C, S, Z, T, K, plain]
}

/** A city drawn as a dot on the map, in either direction. `endpoint`
    is the count the label pass treats as route ends: trains terminating
    there outbound, trains originating there inbound. */
export interface CityPointVM {
  idx: number; // city-table index
  zh: string;
  en: string;
  pt: [number, number];
  trains: number;
  fast: number;
  endpoint: number;
  fastest: number; // minutes
  median: number; // minutes
  crow: number; // crow-flies km
  rail: number; // rail km, -1 when unknown
  nn: number; // nearest-neighbour distance in degrees (label placement order)
  arrTimes?: number[]; // sorted arrival minutes for dynamic circle expansion
}

export interface DestVM extends CityPointVM {
  terminating: number;
  calls: CallVM[]; // every train calling at this city, pre-sorted by arrival
}

export interface SrcVM extends CityPointVM {
  originating: number;
  inCalls: InCallVM[]; // every train arriving from this city
}

export interface ChordVM {
  a: number;
  b: number;
  n: number;
  flat: number[]; // decoded [lon, lat, ...]
  count: number;
  bb: BBox;
}

export interface DepVM {
  code: string;
  cls: string;
  dep: string; // "HH:MM" (zero-padded, formatted from minutes at build time)
  arr: string; // "HH:MM"
  depMins: number;
  arrMins: number;
  dur: number;
  stops: number;
  tcIdx: number;
  fsZh: string;
  fsEn: string;
  tsZh: string;
  tsEn: string;
  tcZh: string;
  tcEn: string;
  km: number; // rail journey distance to the final stop, -1 when unrouted
  distKm: number; // journey distance for binning: km when routed, else crow-flies origin → terminus city
  hay: string; // lowercase search haystack
  secs: number[]; // section indices traversed by this train
}

/** One train calling at a destination city, joined to its departure row. */
export interface CallVM {
  dep: DepVM; // the train's row in the origin's departures (code, boarding, terminus)
  arr: string; // arrival at this city, "HH:MM"
  depAt: string; // departure from this city, "HH:MM"
  dur: number; // minutes from origin boarding to arrival at this city
  dayOff: number; // arrival day offset relative to the boarding day
  term: boolean; // true when the train's final destination is this city
  secCnt: number; // number of section indices from origin to this stop
}

/** One train arriving in the selected city, joined to its tables. */
export interface ArrVM {
  code: string;
  cls: string;
  dep: string; // departure "HH:MM" at the true origin
  arr: string; // arrival "HH:MM" in the selected city
  depMins: number;
  arrMins: number;
  dur: number; // minutes
  stops: number; // stops before the selected city
  dayOff: number; // arrival day offset from the departure day
  fcIdx: number; // origin-city index
  fcZh: string;
  fcEn: string;
  fsZh: string; // origin station
  fsEn: string;
  tsZh: string; // arrival station in the selected city
  tsEn: string;
  km: number; // rail journey km from the origin; -1 when unknown
  distKm: number; // journey distance for binning: km when known, else crow-flies source city → selected city
  hay: string; // lowercase search haystack
  secs: number[]; // section indices traversed by this train (in reverse: arrival to origin)
}

/** One train arriving from a source city, joined to its arrival row. */
export interface InCallVM {
  arr: ArrVM; // the train's row in the origin's arrivals
  board: string; // boarding "HH:MM" at the source city
  arrTime: string; // arrival "HH:MM" in the selected city
  dur: number; // minutes from boarding at the source city to arrival in the selected city
  dayOff: number; // arrival day offset from the boarding day
  started: boolean; // true when the train originates in the source city
  bsZh: string; // boarding station in the source city
  bsEn: string;
  secCnt: number; // number of section indices from arrival back to boarding stop
}

export interface ActiveTrainVM {
  lon: number;
  lat: number;
  heading: number; // in radians
  cls: string;     // train class e.g. "G", "D", "K", etc.
  code: string;
  fromStation: string;
  toStation: string;
  depTime: string;
  arrTime: string;
  durMins: number;
  progressPct: number;
}

export interface ScheduleStop {
  stIdx: number;
  stZh: string;
  stEn: string;
  arr: string;
  dep: string;
  arrMins: number;
  depMins: number;
  dayOff: number;
  dwellMins: number;
  legKm?: number;
}

export interface SchedulesData {
  extra_stations: string[];
  schedules: Record<string, [number, number, number, number, number?][]>;
}

export interface DayTimelineVM {
  stepMins: number; // 5
  numSteps: number; // total steps across all days
  totalMins: number; // total duration until all trains arrive (e.g. 1440, 2880, 4320)
  totalDays: number; // number of 24h cycles needed for all trains to complete
  secFlowSteps: Map<number, Uint16Array>; // sectionId -> Uint16Array(numSteps) of cumulative train count
  maxFlowSteps: Uint16Array; // length numSteps: max flow count across all sections at each step
  getActiveTrains: (tMins: number) => ActiveTrainVM[];
  totalTrains: number;
  getDepartedCount: (tMins: number) => number;
  getArrivedCount: (tMins: number) => number;
}

export interface DistBinFilter {
  bin: number;
  nb: number;
  size: number;
  label: string;
}

export interface DurBinFilter {
  bin: number;
  nb: number;
  size: number; // in minutes (60 = 1h)
  label: string;
}

export interface OriginFilterCriteria {
  classes?: string[];
  hour?: number | null;
  distBin?: DistBinFilter | null;
  durBin?: DurBinFilter | null;
  unit?: DistUnit;
}

export interface OriginVM {
  o: RawOrigin;
  en: string; // display English name (romanization fixes applied)
  flows: FlowVM[]; // sorted widest first
  dests: DestVM[]; // sorted by trains/day desc
  chords: ChordVM[];
  deps: DepVM[];
  maxFlow: number;
  inFlows: FlowVM[]; // sorted widest first
  srcs: SrcVM[]; // sorted by trains/day desc
  arrs: ArrVM[];
  maxInFlow: number;
  timeline?: DayTimelineVM;
  inTimeline?: DayTimelineVM;
}

export type DistUnit = "km" | "mi";
export type Direction = "out" | "in";

/** What the pointer is over on the map. */
export type Hit =
  | { kind: "origin" }
  | { kind: "station"; station: CityPointVM }
  | { kind: "seg"; s: number; n: number; subN?: number }
  | { kind: "chord"; chord: ChordVM }
  | { kind: "train"; train: ActiveTrainVM };

export type RampStop = [number, [number, number, number]];

export interface Palette {
  paper: string;
  network: string;
  graticule: string;
  flow: string;
  flowHi: string;
  /** Flow-colour ramp stops [t, rgb] with t = sqrt(n / N) in 0..1.
      Empty in the dark scheme, where flows keep the flat `flow` colour. */
  flowStops: [number, [number, number, number]][];
  chord: string;
  /** Infrastructure overlay strokes: distinct colours for high-speed rail
      (HSR) vs. conventional rail when the Infrastructure toggle is on. */
  infraLine: string;
  infraHsr: string;
  infraConv: string;
  dot: string;
  dotEdge: string;
  label: string;
  labelHalo: string;
  origin: string;
  legendInk: string;
  legendLine: string;
  ramp: RampStop[];
  outline: string;
  dashLine: string;
  landFill: string;
}
