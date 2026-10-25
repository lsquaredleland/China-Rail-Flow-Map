import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type {
  DecodedAtlas,
  CityPointVM,
  DestVM,
  Direction,
  DistBinFilter,
  DistUnit,
  DurBinFilter,
  OriginVM,
  SrcVM,
} from "../types";
import { classIndex, FLOW_CLASSES } from "../lib";
import Histograms from "./Histograms";
import FilterToolbar from "./departures/FilterToolbar";
import LoadingSection from "./departures/LoadingSection";
import StationLine from "./departures/StationLine";
import { matchCityFromQuery } from "./departures/helpers";
import { inArrivalsMode } from "./departures/inArrivals";
import { inCallsMode } from "./departures/inCalls";
import { outCallsMode } from "./departures/outCalls";
import { outDeparturesMode } from "./departures/outDepartures";
import type {
  ArrSortKey,
  CallSortKey,
  DepCtx,
  InCallSortKey,
  ModeView,
  SortKey,
  SortState,
} from "./departures/types";

interface Props {
  cur: OriginVM | null;
  unit: DistUnit;
  direction: Direction;
  /** The city pinned on the map: a DestVM outbound, a SrcVM inbound. */
  panelCity: CityPointVM | null;
  selectedClasses: string[];
  onSelectClasses: (classes: string[]) => void;
  /** Staged-loading readiness of each direction's per-train tables
      file. Until the active direction's tables land, the section
      shows its heading (from map-file aggregates) over a loading
      line instead of the histograms and table. */
  outTablesReady: boolean;
  inTablesReady: boolean;
  onClearFilter: () => void;
  /** Loaded atlas and the origin picker's callback; used only to point a
      train-code search at the origins that train actually serves. */
  atlas?: DecodedAtlas | null;
  onSelectOrigin?: (idx: number) => void;
  onSelectTrain?: (code: string) => void;
  isolatedTrainCode?: string | null;
  onClearTrainIsolation?: () => void;
  onSelectCity?: (city: CityPointVM | null) => void;
  selectedHour?: number | null;
  selectedHours?: number[];
  onSelectHour?: (h: number | null) => void;
  onSelectHours?: (hours: number[]) => void;
  selectedDistBin?: DistBinFilter | null;
  selectedDistBins?: DistBinFilter[];
  onSelectDistBin?: (b: DistBinFilter | null) => void;
  onSelectDistBins?: (bins: DistBinFilter[]) => void;
  selectedDurBin?: DurBinFilter | null;
  selectedDurBins?: DurBinFilter[];
  onSelectDurBin?: (b: DurBinFilter | null) => void;
  onSelectDurBins?: (bins: DurBinFilter[]) => void;
  selectedTrainCodes?: string[];
  onSelectTrainCodes?: (codes: string[]) => void;
}

/* The trains section below the map, in four modes. Outbound with no
   destination selected it lists every train departing the origin city;
   with a destination selected (either clicked on the map or matched by
   city name in the search box) it switches to calls mode — every train
   that calls at that city. Inbound mirrors both: every train arriving
   in the selected city, or, with a source selected, every train
   arriving from that source with its boarding time there, duration, and
   true origin. All modes share the text filter, train-class filter,
   histogram bar filters, and the 50dvh scroller with its sticky header.
   This component owns the filter / sort state; each mode (./departures)
   turns it into a heading, note and table. */
export default function DeparturesTable({
  cur,
  unit,
  direction,
  panelCity,
  selectedClasses,
  onSelectClasses,
  outTablesReady,
  inTablesReady,
  onClearFilter,
  atlas,
  onSelectOrigin,
  onSelectTrain,
  isolatedTrainCode,
  onClearTrainIsolation,
  onSelectCity,
  selectedHour: controlledHour,
  selectedHours: controlledHours,
  onSelectHour,
  onSelectHours,
  selectedDistBin: controlledDistBin,
  selectedDistBins: controlledDistBins,
  onSelectDistBin,
  onSelectDistBins,
  selectedDurBin: controlledDurBin,
  selectedDurBins: controlledDurBins,
  onSelectDurBin,
  onSelectDurBins,
  selectedTrainCodes = [],
  onSelectTrainCodes,
}: Props) {
  const [query, setQuery] = useState("");
  const [internalHour, setInternalHour] = useState<number | null>(null);
  const [internalDistBin, setInternalDistBin] =
    useState<DistBinFilter | null>(null);
  const [internalDurBin, setInternalDurBin] = useState<DurBinFilter | null>(
    null,
  );

  const selectedHour =
    controlledHour !== undefined ? controlledHour : internalHour;
  const setSelectedHour = onSelectHour || setInternalHour;
  const selectedDistBin =
    controlledDistBin !== undefined ? controlledDistBin : internalDistBin;
  const setSelectedDistBin = onSelectDistBin || setInternalDistBin;
  const selectedDurBin =
    controlledDurBin !== undefined ? controlledDurBin : internalDurBin;
  const setSelectedDurBin = onSelectDurBin || setInternalDurBin;

  const activeHours: number[] =
    controlledHours !== undefined
      ? controlledHours
      : selectedHour !== null && selectedHour !== undefined
        ? [selectedHour]
        : [];
  const activeDistBins: DistBinFilter[] =
    controlledDistBins !== undefined
      ? controlledDistBins
      : selectedDistBin
        ? [selectedDistBin]
        : [];
  const activeDurBins: DurBinFilter[] =
    controlledDurBins !== undefined
      ? controlledDurBins
      : selectedDurBin
        ? [selectedDurBin]
        : [];

  const lastClickedRowIdxRef = useRef<number | null>(null);

  const handleRowClick = (
    code: string,
    idx: number,
    e: MouseEvent,
    currentList: { code: string }[],
  ) => {
    if (!onSelectTrainCodes) return;
    if (e.shiftKey && lastClickedRowIdxRef.current !== null) {
      const start = Math.min(lastClickedRowIdxRef.current, idx);
      const end = Math.max(lastClickedRowIdxRef.current, idx);
      const rangeCodes = currentList
        .slice(start, end + 1)
        .map((item) => item.code);
      const merged = Array.from(
        new Set([...selectedTrainCodes, ...rangeCodes]),
      );
      onSelectTrainCodes(merged);
    } else if (e.metaKey || e.ctrlKey) {
      const next = selectedTrainCodes.includes(code)
        ? selectedTrainCodes.filter((c) => c !== code)
        : [...selectedTrainCodes, code];
      onSelectTrainCodes(next);
      lastClickedRowIdxRef.current = idx;
    } else {
      if (selectedTrainCodes.length === 1 && selectedTrainCodes[0] === code) {
        onSelectTrainCodes([]);
        lastClickedRowIdxRef.current = null;
      } else {
        onSelectTrainCodes([code]);
        lastClickedRowIdxRef.current = idx;
      }
    }
  };
  const [sort, setSort] = useState<SortState<SortKey>>({
    key: "dep",
    dir: 1,
  });
  const [callSort, setCallSort] = useState<SortState<CallSortKey>>({
    key: "arr",
    dir: 1,
  });
  const [arrSort, setArrSort] = useState<SortState<ArrSortKey>>({
    key: "arr",
    dir: 1,
  });
  const [inCallSort, setInCallSort] = useState<SortState<InCallSortKey>>({
    key: "arr",
    dir: 1,
  });

  // Reset histogram filters when switching origin city, and
  // clear distance bin filter when switching km/mi.
  useEffect(() => {
    setSelectedHour(null);
    setSelectedDistBin(null);
    setSelectedDurBin(null);
    // Keyed on the origin city alone: the setters are re-created each
    // render and must not retrigger the reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.o.zh]);

  useEffect(() => {
    setSelectedDistBin(null);
    // Keyed on the unit alone (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit]);

  const rawQ = query.trim().toLowerCase();
  const matched = useMemo(
    () =>
      panelCity
        ? { city: null, restQuery: rawQ }
        : matchCityFromQuery(cur, direction, rawQ),
    [cur, direction, panelCity, rawQ],
  );

  const activeCity: CityPointVM | null = useMemo(() => {
    const raw = panelCity || matched.city;
    if (!raw || !cur) return raw;
    const list: CityPointVM[] = direction === "out" ? cur.dests : cur.srcs;
    return list.find((c) => c.idx === raw.idx) || raw;
  }, [cur, direction, panelCity, matched.city]);
  const q = panelCity ? rawQ : matched.restQuery;

  const destFilter =
    direction === "out" ? (activeCity as DestVM | null) : null;
  const srcFilter = direction === "in" ? (activeCity as SrcVM | null) : null;

  // Available train classes for the current origin/direction (or active city pair).
  const classCounts = useMemo(() => {
    if (!cur) return {};
    const counts: Record<string, number> = {};
    if (destFilter) {
      for (const c of destFilter.calls) {
        if (!c.dep) continue;
        const cls = FLOW_CLASSES[classIndex(c.dep.cls)];
        counts[cls] = (counts[cls] || 0) + 1;
      }
    } else if (srcFilter) {
      for (const c of srcFilter.inCalls) {
        if (!c.arr) continue;
        const cls = FLOW_CLASSES[classIndex(c.arr.cls)];
        counts[cls] = (counts[cls] || 0) + 1;
      }
    } else if (direction === "in") {
      for (const a of cur.arrs) {
        const cls = FLOW_CLASSES[classIndex(a.cls)];
        counts[cls] = (counts[cls] || 0) + 1;
      }
    } else {
      for (const d of cur.deps) {
        const cls = FLOW_CLASSES[classIndex(d.cls)];
        counts[cls] = (counts[cls] || 0) + 1;
      }
    }
    return counts;
  }, [cur, direction, destFilter, srcFilter]);

  // Helper predicate for class + histogram filters on a train row.
  const matchesRowFilters = (
    timeStr: string,
    distKm: number,
    durMins: number,
    cls: string,
    code?: string,
  ) => {
    if (isolatedTrainCode && (!code || code !== isolatedTrainCode)) {
      return false;
    }
    if (selectedClasses.length > 0 && !selectedClasses.includes(cls)) {
      return false;
    }
    if (activeHours.length > 0) {
      const h = parseInt(timeStr.slice(0, 2), 10);
      if (!activeHours.includes(h)) return false;
    }
    if (activeDistBins.length > 0) {
      const v = unit === "km" ? distKm : distKm * 0.621371;
      const matched = activeDistBins.some((bin) => {
        const b = Math.min(
          bin.nb - 1,
          Math.max(0, Math.floor(v / bin.size)),
        );
        return b === bin.bin;
      });
      if (!matched) return false;
    }
    if (activeDurBins.length > 0) {
      if (durMins < 0) return false;
      const matched = activeDurBins.some((bin) => {
        const b = Math.min(
          bin.nb - 1,
          Math.max(0, Math.floor(durMins / bin.size)),
        );
        return b === bin.bin;
      });
      if (!matched) return false;
    }
    return true;
  };

  const hasExtraFilters =
    !!q ||
    Boolean(isolatedTrainCode) ||
    selectedClasses.length > 0 ||
    activeHours.length > 0 ||
    activeDistBins.length > 0 ||
    activeDurBins.length > 0 ||
    selectedTrainCodes.length > 0;

  // A fresh selection starts from its pre-sorted arrival order.
  useEffect(() => {
    setCallSort({ key: "arr", dir: 1 });
  }, [destFilter]);
  useEffect(() => {
    setInCallSort({ key: "arr", dir: 1 });
  }, [srcFilter]);

  const handleClearChip = () => {
    setQuery("");
    onClearFilter();
    onSelectCity?.(null);
  };

  /* ---------------- tables still in flight ---------------- */
  const tablesReady = direction === "out" ? outTablesReady : inTablesReady;
  if (cur && !tablesReady) {
    return (
      <LoadingSection
        cur={cur}
        direction={direction}
        destFilter={destFilter}
        srcFilter={srcFilter}
      />
    );
  }

  const ctx: DepCtx = {
    cur,
    atlas,
    unit,
    q,
    hasExtraFilters,
    matchesRowFilters,
    selectedClasses,
    selectedTrainCodes,
    handleRowClick,
    onSelectTrain,
    handleClearChip,
    emptyProps: {
      atlas,
      cur,
      direction,
      query,
      tablesLoaded: tablesReady,
      onSelectOrigin,
    },
    sort,
    setSort,
    callSort,
    setCallSort,
    arrSort,
    setArrSort,
    inCallSort,
    setInCallSort,
  };

  const view: ModeView =
    cur && destFilter
      ? outCallsMode(ctx, cur, destFilter)
      : cur && srcFilter
        ? inCallsMode(ctx, cur, srcFilter)
        : cur && direction === "in"
          ? inArrivalsMode(ctx, cur)
          : outDeparturesMode(ctx);

  return (
    <section id="departures">
      <h2>{view.heading}</h2>
      <StationLine stations={view.stations} classes={selectedClasses} />
      <p className="dep-note">{view.depNote}</p>
      {cur ? (
        <Histograms
          cur={cur}
          unit={unit}
          direction={direction}
          panelCity={activeCity}
          selectedClasses={selectedClasses}
          selectedHour={selectedHour}
          selectedHours={activeHours}
          onSelectHour={setSelectedHour}
          onSelectHours={onSelectHours}
          selectedDistBin={selectedDistBin}
          selectedDistBins={activeDistBins}
          onSelectDistBin={setSelectedDistBin}
          onSelectDistBins={onSelectDistBins}
          selectedDurBin={selectedDurBin}
          selectedDurBins={activeDurBins}
          onSelectDurBin={setSelectedDurBin}
          onSelectDurBins={onSelectDurBins}
        />
      ) : null}
      <FilterToolbar
        cur={cur}
        activeCity={activeCity}
        query={query}
        onQueryChange={setQuery}
        selectedClasses={selectedClasses}
        onSelectClasses={onSelectClasses}
        classCounts={classCounts}
        isolatedTrainCode={isolatedTrainCode}
        onClearTrainIsolation={onClearTrainIsolation}
        chipNode={view.chipNode ?? null}
        selectedTrainCodes={selectedTrainCodes}
        onSelectTrainCodes={onSelectTrainCodes}
        activeHours={activeHours}
        onSelectHours={onSelectHours}
        setSelectedHour={setSelectedHour}
        activeDistBins={activeDistBins}
        onSelectDistBins={onSelectDistBins}
        setSelectedDistBin={setSelectedDistBin}
        activeDurBins={activeDurBins}
        onSelectDurBins={onSelectDurBins}
        setSelectedDurBin={setSelectedDurBin}
        showingNote={view.showingNote}
      />
      <p className="dep-swipe">Swipe sideways for all columns &rarr;</p>
      <div className="dep-scrollwrap">
        <div className="dep-scroll">{view.tableNode}</div>
        <div className="dep-fade" aria-hidden="true"></div>
      </div>
    </section>
  );
}
