import type { MouseEvent, ReactNode } from "react";
import type { DecodedAtlas, DistUnit, OriginVM } from "../../types";
import type { StationCount } from "../../stationBreakdown";
import type { EmptyProps } from "./EmptyMessage";

export type SortDir = 1 | -1;
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
