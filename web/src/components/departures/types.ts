import type { MouseEvent, ReactNode } from "react";
import type { DecodedAtlas, DistUnit, OriginVM, RawTrain } from "../../types";
import type { StationCount } from "../../stationBreakdown";
import type { EmptyProps } from "./EmptyMessage";
import type { HistRow, NatRow, NatSortKey } from "../../lib";

type SortDir = 1 | -1;
export type SortKey = "dep" | "dur" | "km" | "runs";
export type CallSortKey = "arr" | "dep" | "dur" | "runs";
export type ArrSortKey = "dep" | "arr" | "dur" | "km" | "runs";
export type InCallSortKey = "board" | "arr" | "dur" | "runs";

export interface SortState<K> {
  key: K;
  dir: SortDir;
}

/** What one table mode contributes to the section. */
export interface ModeView {
  heading: ReactNode;
  depNote: ReactNode;
  /** The "Calling at: X" / "Arriving from: X" chip, in the two city modes. */
  chipNode?: ReactNode;
  /** Heading count split by station (null while the schedules are loading). */
  stations: StationCount[] | null;
  /** Class-filtered row count the heading shows (== the station line sum). */
  count: number;
  /** Unfiltered count; the heading adds "of total" when it differs. */
  total: number;
  showingNote: string;
  tableNode: ReactNode;
}

/** Everything the mode builders read from the DeparturesTable shell. */
export interface DepCtx {
  cur: OriginVM | null;
  atlas?: DecodedAtlas | null;
  unit: DistUnit;
  /** The search text after any city name has been peeled off. */
  q: string;
  hasExtraFilters: boolean;
  matchesRowFilters: (
    timeStr: string,
    distKm: number,
    durMins: number,
    cls: string,
    code?: string,
  ) => boolean;
  /** Train-class chips (G, D, ...) selected; empty means all. */
  selectedClasses: string[];
  selectedTrainCodes: string[];
  handleRowClick: (
    code: string,
    idx: number,
    e: MouseEvent,
    currentList: { code: string }[],
  ) => void;
  onSelectTrain?: (code: string) => void;
  handleClearChip: () => void;
  emptyProps: EmptyProps;
  natSort: SortState<NatSortKey>;
  setNatSort: (f: (s: SortState<NatSortKey>) => SortState<NatSortKey>) => void;
  sort: SortState<SortKey>;
  setSort: (f: (s: SortState<SortKey>) => SortState<SortKey>) => void;
  callSort: SortState<CallSortKey>;
  setCallSort: (f: (s: SortState<CallSortKey>) => SortState<CallSortKey>) => void;
  arrSort: SortState<ArrSortKey>;
  setArrSort: (f: (s: SortState<ArrSortKey>) => SortState<ArrSortKey>) => void;
  inCallSort: SortState<InCallSortKey>;
  setInCallSort: (
    f: (s: SortState<InCallSortKey>) => SortState<InCallSortKey>,
  ) => void;
}

/** What national mode hands the shared departures section instead of an origin. */
export interface NatData {
  /** Every train's row; null while the schedules load. */
  rows: NatRow[] | null;
  /** The same trains as the histograms bin them. */
  histRows: HistRow[];
  /** natSelect's flags per train_table row (null = all). */
  sel: Uint8Array | null;
  trainTable: readonly RawTrain[];
  calendar?: readonly string[];
  /** Trains per class (FLOW_CLASSES names) for the class buttons. */
  classCounts: Record<string, number>;
}
