import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ArrVM,
  CityPointVM,
  DepVM,
  DestVM,
  Direction,
  DistUnit,
  OriginVM,
  SrcVM,
} from "../types";
import { classIndex, FLOW_CLASSES, fmtDist, fmtTime } from "../lib";
import Histograms, {
  type DistBinFilter,
  type DurBinFilter,
} from "./Histograms";

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

type SortKey = "dep" | "dur" | "km";
type CallSortKey = "arr" | "dep" | "dur";
type ArrSortKey = "dep" | "arr" | "dur" | "km";
type InCallSortKey = "board" | "arr" | "dur";

const CLASS_ORDER = ["G", "D", "C", "S", "Z", "T", "K", "Y", "plain"];
const CLASS_NAMES: Record<string, string> = {
  G: "G · High-speed (Fuxing / Hexie)",
  D: "D · Bullet (CRH / EMU)",
  C: "C · Intercity high-speed",
  S: "S · Suburban / commuter",
  Z: "Z · Direct express",
  T: "T · Express",
  K: "K · Fast",
  Y: "Y · Tourist",
  plain: "普 · Ordinary",
};

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function formatHoursLabel(hours: number[]): string {
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

function depDayOffset(d: DepVM): number {
  if (d.dur < 0) return 0;
  const dm =
    parseInt(d.dep.slice(0, 2), 10) * 60 + parseInt(d.dep.slice(3, 5), 10);
  return Math.floor((dm + d.dur) / 1440);
}

function normCityStr(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f'’]/g, "");
}

/** Match a search query against the map's reachable cities in the current
    direction so typing a city name in the search bar activates the same
    "Calling at" / "Arriving from" city-pair view as clicking its dot. */
function matchCityFromQuery(
  cur: OriginVM | null,
  direction: Direction,
  q: string,
): { city: CityPointVM | null; restQuery: string } {
  if (!cur || !q) return { city: null, restQuery: q };
  const points: CityPointVM[] = direction === "out" ? cur.dests : cur.srcs;
  const qNorm = normCityStr(q);
  // 1. Exact match on English or Chinese city name
  const exact = points.find(
    (c) => normCityStr(c.en) === qNorm || c.zh === q,
  );
  if (exact) return { city: exact, restQuery: "" };
  // 2. City name followed by a sub-filter token (e.g. "Chongqing G")
  for (const c of points) {
    const enN = normCityStr(c.en);
    if (qNorm.startsWith(enN + " ")) {
      return { city: c, restQuery: q.slice(c.en.length).trim() };
    }
    if (q.startsWith(c.zh + " ")) {
      return { city: c, restQuery: q.slice(c.zh.length).trim() };
    }
  }
  // 3. Unique prefix match (at least 3 Latin chars or 2 Chinese chars)
  const isCjk = /[\u4e00-\u9fff]/.test(q);
  if (isCjk ? q.length >= 2 : qNorm.length >= 3) {
    const pref = points.filter(
      (c) => normCityStr(c.en).startsWith(qNorm) || c.zh.startsWith(q),
    );
    if (pref.length === 1) return { city: pref[0], restQuery: "" };
  }
  return { city: null, restQuery: q };
}

/** The train cell shared by every table mode: class chip and number. */
function TrainCell({
  d,
  onClick,
}: {
  d: { code: string; cls: string };
  onClick?: () => void;
}) {
  const chip = d.cls === "plain" ? "普" : d.cls;
  const num = d.cls === "plain" ? d.code : d.code.replace(/^[A-Z]+/, "");
  const isHs = d.cls === "G" || d.cls === "D" || d.cls === "C";
  return (
    <button
      type="button"
      onClick={
        onClick
          ? (e) => {
              // The schedule link must not also toggle the row's train filter.
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
      title={onClick ? `View full schedule for train ${d.code}` : undefined}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        margin: 0,
        font: "inherit",
        color: "inherit",
        cursor: onClick ? "pointer" : "default",
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
      }}
    >
      <span className={"cls " + (isHs ? "cls-hs" : "cls-conv")}>{chip}</span>
      <b
        style={
          onClick
            ? {
                textDecoration: "underline",
                textDecorationStyle: "dotted",
                textUnderlineOffset: "3px",
              }
            : undefined
        }
      >
        {num || d.code}
      </b>
    </button>
  );
}

/* The trains section below the map, in four modes. Outbound with no
   destination selected it lists every train departing the origin city;
   with a destination selected (either clicked on the map or matched by
   city name in the search box) it switches to calls mode — every train
   that calls at that city. Inbound mirrors both: every train arriving
   in the selected city, or, with a source selected, every train
   arriving from that source with its boarding time there, duration, and
   true origin. All modes share the text filter, train-class filter,
   histogram bar filters, and the 50dvh scroller with its sticky header. */
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
    e: React.MouseEvent,
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
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: "dep",
    dir: 1,
  });
  const [callSort, setCallSort] = useState<{ key: CallSortKey; dir: 1 | -1 }>({
    key: "arr",
    dir: 1,
  });
  const [arrSort, setArrSort] = useState<{ key: ArrSortKey; dir: 1 | -1 }>({
    key: "arr",
    dir: 1,
  });
  const [inCallSort, setInCallSort] = useState<{
    key: InCallSortKey;
    dir: 1 | -1;
  }>({ key: "arr", dir: 1 });

  // Reset histogram filters when switching origin city, and
  // clear distance bin filter when switching km/mi.
  useEffect(() => {
    setSelectedHour(null);
    setSelectedDistBin(null);
    setSelectedDurBin(null);
  }, [cur?.o.zh]);

  useEffect(() => {
    setSelectedDistBin(null);
  }, [unit]);

  const rawQ = query.trim().toLowerCase();
  const matched = useMemo(
    () =>
      panelCity
        ? { city: null, restQuery: rawQ }
        : matchCityFromQuery(cur, direction, rawQ),
    [cur, direction, panelCity, rawQ],
  );

  useEffect(() => {
    if (!panelCity && matched.city) {
      onSelectCity?.(matched.city);
    }
  }, [matched.city, panelCity, onSelectCity]);

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

  const toggleClass = (cls: string) => {
    onSelectClasses(
      selectedClasses.includes(cls)
        ? selectedClasses.filter((c) => c !== cls)
        : [...selectedClasses, cls],
    );
  };

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
    let heading: ReactNode;
    let note: ReactNode;
    if (destFilter) {
      heading = (
        <>
          <span id="depCityName">
            {destFilter.trains} trains call at {destFilter.en} &middot;{" "}
            {destFilter.zh}
          </span>{" "}
          &mdash;{" "}
          <span id="depCount">
            {destFilter.terminating > 0
              ? destFilter.terminating + " terminate here"
              : "none terminate here — all intermediate stops"}
          </span>
        </>
      );
      note = (
        <>
          Every train from {cur.en} that stops at {destFilter.en} &mdash;
          whether it ends its journey there or only calls on the way
          through. &ldquo;Arrives&rdquo; and &ldquo;Departs&rdquo; are the
          times at {destFilter.en}&rsquo;s station; &ldquo;Final
          destination&rdquo; is where the train is ultimately bound.
        </>
      );
    } else if (srcFilter) {
      heading = (
        <>
          <span id="depCityName">
            {srcFilter.trains} trains arrive from {srcFilter.en} &middot;{" "}
            {srcFilter.zh}
          </span>{" "}
          &mdash;{" "}
          <span id="depCount">
            {srcFilter.originating > 0
              ? srcFilter.originating + " start there"
              : "none start there"}
          </span>
        </>
      );
      note = (
        <>
          Every train from {srcFilter.en} that arrives in {cur.en} &mdash;
          whether it starts in {srcFilter.en} or only calls there on the
          way in. &ldquo;Departs {srcFilter.en}&rdquo; is the boarding time
          at {srcFilter.en}&rsquo;s station; &ldquo;Origin&rdquo; is where
          the train truly starts.
        </>
      );
    } else if (direction === "in") {
      heading = (
        <>
          Arrivals into{" "}
          <span id="depCityName">
            {cur.en} &middot; {cur.o.zh}
          </span>{" "}
          &mdash; <span id="depCount">{cur.o.inbound} arrivals</span>
        </>
      );
      note = (
        <>
          Every train arriving in the selected city &mdash; from wherever
          it starts &mdash; across the two timetable dates &mdash; Wednesday
          21 October 2026 (national) and Wednesday 28 October 2026
          (intercity C/S). &ldquo;Stops&rdquo; counts the stops the train
          makes before reaching {cur.en}.
        </>
      );
    } else {
      heading = (
        <>
          Departures from{" "}
          <span id="depCityName">
            {cur.en} &middot; {cur.o.zh}
          </span>{" "}
          &mdash; <span id="depCount">{cur.o.outbound} departures</span>
        </>
      );
      note = (
        <>
          Every train departing the selected city &mdash; from any of its
          stations &mdash; across the two timetable dates &mdash; Wednesday 21
          October 2026 (national) and Wednesday 28 October 2026
          (intercity C/S). &ldquo;Stops&rdquo; counts the stops the train makes after leaving
          its origin-city station.
        </>
      );
    }
    return (
      <section id="departures">
        <h2>{heading}</h2>
        <p className="dep-note">{note}</p>
        <p className="dep-empty" role="status">
          Loading the train tables&hellip;
        </p>
      </section>
    );
  }

  let heading: ReactNode;
  let depNote: ReactNode;
  let showingNote: string;
  let chipNode: ReactNode = null;
  let tableNode: ReactNode;

  /* ---------------- outbound calls mode ---------------- */
  if (cur && destFilter) {
    const calls = destFilter.calls;
    const termCount = destFilter.terminating;
    const list = calls.filter((c) => {
      if (
        !matchesRowFilters(
          c.dep.dep,
          c.dep.distKm,
          c.dep.dur,
          c.dep.cls,
          c.dep.code,
        )
      )
        return false;
      if (!q) return true;
      if (c.dep.hay.indexOf(q) !== -1) return true;
      // Searching the selected city's own name keeps every call.
      return (destFilter.en + " " + destFilter.zh).toLowerCase().indexOf(q) !== -1;
    });
    const { key: ck, dir: cdir } = callSort;
    list.sort((a, b) => {
      if (ck === "dur") {
        const va = a.dur;
        const vb = b.dur;
        if (va < 0 && vb < 0) {
          /* fall through */
        } else if (va < 0) return 1;
        else if (vb < 0) return -1;
        else if (va !== vb) return (va < vb ? -1 : 1) * cdir;
      } else if (ck === "arr") {
        if (a.dayOff !== b.dayOff) return (a.dayOff - b.dayOff) * cdir;
        if (a.arr !== b.arr) return (a.arr < b.arr ? -1 : 1) * cdir;
      } else if (a.dep.dep !== b.dep.dep) {
        return (a.dep.dep < b.dep.dep ? -1 : 1) * cdir;
      }
      if (a.dep.dep !== b.dep.dep) return a.dep.dep < b.dep.dep ? -1 : 1;
      if (a.arr !== b.arr) return a.arr < b.arr ? -1 : 1;
      return a.dep.code < b.dep.code ? -1 : a.dep.code > b.dep.code ? 1 : 0;
    });

    showingNote = hasExtraFilters
      ? "Showing " +
        list.length +
        " of " +
        calls.length +
        " trains calling at " +
        destFilter.en
      : calls.length +
        " trains, " +
        (ck === "arr"
          ? cdir === 1
            ? "earliest arrival at " + destFilter.en + " first"
            : "latest arrival at " + destFilter.en + " first"
          : ck === "dur"
            ? cdir === 1
              ? "shortest journey to " + destFilter.en + " first"
              : "longest journey to " + destFilter.en + " first"
            : cdir === 1
              ? "earliest departure first"
              : "latest departure first");

    const onCallSort = (k: CallSortKey) => {
      setCallSort((s) =>
        s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 },
      );
    };
    const cArrow = (k: CallSortKey) =>
      callSort.key === k ? (callSort.dir === 1 ? "▲" : "▼") : "";
    const cAriaSort = (k: CallSortKey) =>
      callSort.key === k
        ? callSort.dir === 1
          ? ("ascending" as const)
          : ("descending" as const)
        : undefined;

    heading = (
      <>
        <span id="depCityName">
          <b className="dep-num-lead">{calls.length}</b> trains call at {destFilter.en} &middot;{" "}
          {destFilter.zh}
        </span>{" "}
        <span id="depCount">
          {termCount > 0
            ? termCount + " terminate here"
            : "none terminate here — all intermediate stops"}
        </span>
      </>
    );
    depNote = (
      <>
        Every train from {cur.en} that stops at {destFilter.en} &mdash;
        whether it ends its journey there or only calls on the way
        through. &ldquo;Arrives&rdquo; and &ldquo;Departs&rdquo; are the
        times at {destFilter.en}&rsquo;s station; &ldquo;Duration&rdquo; is
        the travel time from {cur.en} to {destFilter.en}; &ldquo;Final
        destination&rdquo; is where the train is ultimately bound.
      </>
    );
    chipNode = (
      <span className="dep-chip" id="depChip">
        Calling at:{" "}
        <b id="depChipName">
          {destFilter.en} &middot; {destFilter.zh}
        </b>
        <button
          id="depChipClear"
          type="button"
          aria-label="Clear destination filter"
          onClick={handleClearChip}
        >
          &times;
        </button>
      </span>
    );
    tableNode = (
      <table id="depTable" className="calls">
        <thead>
          <tr>
            <th scope="col">Train</th>
            <th
              scope="col"
              className="sortable"
              data-sort="dep"
              aria-sort={cAriaSort("dep")}
              onClick={() => onCallSort("dep")}
            >
              Departs {cur.en} <span className="arrow">{cArrow("dep")}</span>
            </th>
            <th scope="col">From</th>
            <th
              scope="col"
              className="sortable"
              data-sort="arr"
              aria-sort={cAriaSort("arr")}
              onClick={() => onCallSort("arr")}
            >
              Arrives {destFilter.en}{" "}
              <span className="arrow">{cArrow("arr")}</span>
            </th>
            <th
              scope="col"
              className="sortable"
              data-sort="dur"
              aria-sort={cAriaSort("dur")}
              onClick={() => onCallSort("dur")}
            >
              Duration <span className="arrow">{cArrow("dur")}</span>
            </th>
            <th scope="col">Departs {destFilter.en}</th>
            <th scope="col">Final destination</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody id="depBody">
          {list.length === 0 ? (
            <tr>
              <td colSpan={8} className="dep-empty">
                No trains match that filter.
              </td>
            </tr>
          ) : (
            list.map((c, i) => {
              const d = c.dep;
              const isSelected = selectedTrainCodes.includes(d.code);
              return (
                <tr
                  key={i}
                  className={isSelected ? "dep-row-selected" : undefined}
                  onClick={(e) =>
                    handleRowClick(
                      d.code,
                      i,
                      e,
                      list.map((item) => ({ code: item.dep.code })),
                    )
                  }
                >
                  <td className="c-train">
                    <TrainCell
                      d={d}
                      onClick={
                        onSelectTrain ? () => onSelectTrain(d.code) : undefined
                      }
                    />
                  </td>
                  <td className="c-time">{d.dep}</td>
                  <td>
                    {d.fsZh}
                    {d.fsEn ? <span className="to-stn">{d.fsEn}</span> : null}
                  </td>
                  <td className="c-time">
                    {c.arr}
                    {c.dayOff > 0 ? (
                      <span className="plus"> +{c.dayOff}d</span>
                    ) : null}
                  </td>
                  <td className="c-time">{fmtTime(c.dur)}</td>
                  <td className="c-time">{c.term ? "—" : c.depAt}</td>
                  <td>
                    <span className="to-city">
                      {d.tcEn} &middot; {d.tcZh}
                    </span>
                    <span className="to-stn">
                      {d.tsZh}
                      {d.tsEn ? " · " + d.tsEn : ""}
                    </span>
                  </td>
                  <td>
                    <span
                      className={
                        "status-chip " + (c.term ? "status-term" : "status-mid")
                      }
                    >
                      {c.term ? "Terminates here" : "Intermediate stop"}
                    </span>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    );
  } else if (cur && srcFilter) {
    /* ---------------- inbound source mode ---------------- */
    const calls = srcFilter.inCalls;
    const list = calls.filter((c) => {
      if (
        !matchesRowFilters(
          c.arr.arr,
          c.arr.distKm,
          c.arr.dur,
          c.arr.cls,
          c.arr.code,
        )
      )
        return false;
      if (!q) return true;
      if (c.arr.hay.indexOf(q) !== -1) return true;
      if ((c.bsZh + " " + c.bsEn).toLowerCase().indexOf(q) !== -1)
        return true;
      // Searching the selected source's own name keeps every call.
      return (srcFilter.en + " " + srcFilter.zh).toLowerCase().indexOf(q) !== -1;
    });
    const { key: ik, dir: idir } = inCallSort;
    list.sort((a, b) => {
      if (ik === "dur") {
        const va = a.dur;
        const vb = b.dur;
        if (va < 0 && vb < 0) {
          /* fall through */
        } else if (va < 0) return 1;
        else if (vb < 0) return -1;
        else if (va !== vb) return (va < vb ? -1 : 1) * idir;
      } else if (ik === "arr") {
        if (a.dayOff !== b.dayOff) return (a.dayOff - b.dayOff) * idir;
        if (a.arrTime !== b.arrTime)
          return (a.arrTime < b.arrTime ? -1 : 1) * idir;
      } else if (a.board !== b.board) {
        return (a.board < b.board ? -1 : 1) * idir;
      }
      if (a.board !== b.board) return a.board < b.board ? -1 : 1;
      if (a.arrTime !== b.arrTime) return a.arrTime < b.arrTime ? -1 : 1;
      return a.arr.code < b.arr.code ? -1 : a.arr.code > b.arr.code ? 1 : 0;
    });

    showingNote = hasExtraFilters
      ? "Showing " +
        list.length +
        " of " +
        calls.length +
        " trains arriving from " +
        srcFilter.en
      : calls.length +
        " trains, " +
        (ik === "arr"
          ? idir === 1
            ? "earliest arrival in " + cur.en + " first"
            : "latest arrival in " + cur.en + " first"
          : ik === "dur"
            ? idir === 1
              ? "shortest journey from " + srcFilter.en + " first"
              : "longest journey from " + srcFilter.en + " first"
            : idir === 1
              ? "earliest departure from " + srcFilter.en + " first"
              : "latest departure from " + srcFilter.en + " first");

    const onInCallSort = (k: InCallSortKey) => {
      setInCallSort((s) =>
        s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 },
      );
    };
    const iArrow = (k: InCallSortKey) =>
      inCallSort.key === k ? (inCallSort.dir === 1 ? "▲" : "▼") : "";
    const iAriaSort = (k: InCallSortKey) =>
      inCallSort.key === k
        ? inCallSort.dir === 1
          ? ("ascending" as const)
          : ("descending" as const)
        : undefined;

    heading = (
      <>
        <span id="depCityName">
          {srcFilter.trains} trains arrive from {srcFilter.en} &middot;{" "}
          {srcFilter.zh}
        </span>{" "}
        &mdash;{" "}
        <span id="depCount">
          {srcFilter.originating > 0
            ? srcFilter.originating + " start there"
            : "none start there"}
        </span>
      </>
    );
    depNote = (
      <>
        Every train from {srcFilter.en} that arrives in {cur.en} &mdash;
        whether it starts in {srcFilter.en} or only calls there on the
        way in. &ldquo;Departs {srcFilter.en}&rdquo; is the boarding time
        at {srcFilter.en}&rsquo;s station; &ldquo;Duration&rdquo; is the
        travel time from {srcFilter.en} to {cur.en}; &ldquo;Origin&rdquo; is
        where the train truly starts.
      </>
    );
    chipNode = (
      <span className="dep-chip" id="depChip">
        Arriving from:{" "}
        <b id="depChipName">
          {srcFilter.en} &middot; {srcFilter.zh}
        </b>
        <button
          id="depChipClear"
          type="button"
          aria-label="Clear source filter"
          onClick={handleClearChip}
        >
          &times;
        </button>
      </span>
    );
    tableNode = (
      <table id="depTable" className="calls">
        <thead>
          <tr>
            <th scope="col">Train</th>
            <th
              scope="col"
              className="sortable"
              data-sort="board"
              aria-sort={iAriaSort("board")}
              onClick={() => onInCallSort("board")}
            >
              Departs {srcFilter.en}{" "}
              <span className="arrow">{iArrow("board")}</span>
            </th>
            <th
              scope="col"
              className="sortable"
              data-sort="arr"
              aria-sort={iAriaSort("arr")}
              onClick={() => onInCallSort("arr")}
            >
              Arrives {cur.en}{" "}
              <span className="arrow">{iArrow("arr")}</span>
            </th>
            <th
              scope="col"
              className="sortable"
              data-sort="dur"
              aria-sort={iAriaSort("dur")}
              onClick={() => onInCallSort("dur")}
            >
              Duration <span className="arrow">{iArrow("dur")}</span>
            </th>
            <th scope="col">Origin</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody id="depBody">
          {list.length === 0 ? (
            <tr>
              <td colSpan={6} className="dep-empty">
                No trains match that filter.
              </td>
            </tr>
          ) : (
            list.map((c, i) => {
              const a = c.arr;
              const isSelected = selectedTrainCodes.includes(a.code);
              return (
                <tr
                  key={i}
                  className={isSelected ? "dep-row-selected" : undefined}
                  onClick={(e) =>
                    handleRowClick(
                      a.code,
                      i,
                      e,
                      list.map((item) => ({ code: item.arr.code })),
                    )
                  }
                >
                  <td className="c-train">
                    <TrainCell
                      d={a}
                      onClick={
                        onSelectTrain ? () => onSelectTrain(a.code) : undefined
                      }
                    />
                  </td>
                  <td className="c-time">
                    {c.board}
                    <span className="to-stn">
                      {c.bsZh}
                      {c.bsEn ? " · " + c.bsEn : ""}
                    </span>
                  </td>
                  <td className="c-time">
                    {c.arrTime}
                    {c.dayOff > 0 ? (
                      <span className="plus"> +{c.dayOff}d</span>
                    ) : null}
                  </td>
                  <td className="c-time">{fmtTime(c.dur)}</td>
                  <td>
                    <span className="to-city">
                      {a.fcEn} &middot; {a.fcZh}
                    </span>
                    <span className="to-stn">
                      {a.fsZh}
                      {a.fsEn ? " · " + a.fsEn : ""}
                    </span>
                  </td>
                  <td>
                    <span
                      className={
                        "status-chip " +
                        (c.started ? "status-term" : "status-mid")
                      }
                    >
                      {c.started ? "Originates here" : "Through train"}
                    </span>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    );
  } else if (cur && direction === "in") {
    /* ---------------- inbound arrivals mode ---------------- */
    const arrs = cur.arrs;
    const list: ArrVM[] = arrs.filter(
      (a) =>
        matchesRowFilters(a.arr, a.distKm, a.dur, a.cls, a.code) &&
        (!q || a.hay.indexOf(q) !== -1),
    );
    const { key: ak, dir: adir } = arrSort;
    list.sort((a, b) => {
      if (ak === "dur" || ak === "km") {
        const va = ak === "dur" ? a.dur : a.km;
        const vb = ak === "dur" ? b.dur : b.km;
        if (va < 0 && vb < 0) {
          /* fall through to tie-break */
        } else if (va < 0) return 1;
        else if (vb < 0) return -1;
        else if (va !== vb) return (va < vb ? -1 : 1) * adir;
      } else if (ak === "arr") {
        if (a.dayOff !== b.dayOff) return (a.dayOff - b.dayOff) * adir;
        if (a.arr !== b.arr) return (a.arr < b.arr ? -1 : 1) * adir;
      } else if (a.dep !== b.dep) {
        return (a.dep < b.dep ? -1 : 1) * adir;
      }
      if (a.arr !== b.arr) return a.arr < b.arr ? -1 : 1;
      if (a.dep !== b.dep) return a.dep < b.dep ? -1 : 1;
      return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    });

    if (hasExtraFilters)
      showingNote = "Showing " + list.length + " of " + arrs.length + " arrivals";
    else if (ak === "arr")
      showingNote =
        arrs.length +
        " arrivals, " +
        (adir === 1 ? "earliest first" : "latest first");
    else if (ak === "dep")
      showingNote =
        arrs.length +
        " arrivals, " +
        (adir === 1 ? "earliest departure first" : "latest departure first");
    else if (ak === "km")
      showingNote =
        arrs.length +
        " arrivals, " +
        (adir === 1 ? "shortest distance first" : "longest distance first");
    else
      showingNote =
        arrs.length +
        " arrivals, " +
        (adir === 1 ? "shortest duration first" : "longest duration first");

    const onArrSort = (k: ArrSortKey) => {
      setArrSort((s) =>
        s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 },
      );
    };
    const aArrow = (k: ArrSortKey) =>
      arrSort.key === k ? (arrSort.dir === 1 ? "▲" : "▼") : "";
    const aAriaSort = (k: ArrSortKey) =>
      arrSort.key === k
        ? arrSort.dir === 1
          ? ("ascending" as const)
          : ("descending" as const)
        : undefined;

    heading = (
      <>
        Arrivals into{" "}
        <span id="depCityName">
          {cur.en} &middot; {cur.o.zh}
        </span>{" "}
        &mdash; <span id="depCount">{arrs.length} arrivals</span>
      </>
    );
    depNote = (
      <>
        Every train arriving in the selected city &mdash; from wherever
        it starts &mdash; across the two timetable dates &mdash; Wednesday
        21 October 2026 (national) and Wednesday 28 October 2026
        (intercity C/S). &ldquo;Stops&rdquo; counts the stops the train
        makes before reaching {cur.en}.
      </>
    );
    tableNode = (
      <table id="depTable">
        <thead>
          <tr>
            <th scope="col">Train</th>
            <th scope="col">Origin</th>
            <th
              scope="col"
              className="sortable"
              data-sort="dep"
              aria-sort={aAriaSort("dep")}
              onClick={() => onArrSort("dep")}
            >
              Departs <span className="arrow">{aArrow("dep")}</span>
            </th>
            <th
              scope="col"
              className="sortable"
              data-sort="arr"
              aria-sort={aAriaSort("arr")}
              onClick={() => onArrSort("arr")}
            >
              Arrives <span className="arrow">{aArrow("arr")}</span>
            </th>
            <th
              scope="col"
              className="sortable"
              data-sort="dur"
              aria-sort={aAriaSort("dur")}
              onClick={() => onArrSort("dur")}
            >
              Duration <span className="arrow">{aArrow("dur")}</span>
            </th>
            <th
              scope="col"
              className="num sortable"
              data-sort="km"
              aria-sort={aAriaSort("km")}
              onClick={() => onArrSort("km")}
            >
              Distance <span className="arrow">{aArrow("km")}</span>
            </th>
            <th scope="col" className="num">
              Stops
            </th>
          </tr>
        </thead>
        <tbody id="depBody">
          {list.length === 0 ? (
            <tr>
              <td colSpan={7} className="dep-empty">
                No trains match that filter.
              </td>
            </tr>
          ) : (
            list.map((a, i) => (
              <tr
                key={i}
                className={
                  selectedTrainCodes.includes(a.code)
                    ? "dep-row-selected"
                    : undefined
                }
                onClick={(e) => handleRowClick(a.code, i, e, list)}
              >
                <td className="c-train">
                  <TrainCell
                    d={a}
                    onClick={
                      onSelectTrain ? () => onSelectTrain(a.code) : undefined
                    }
                  />
                </td>
                <td>
                  <span className="to-city">
                    {a.fcEn} &middot; {a.fcZh}
                  </span>
                  <span className="to-stn">
                    {a.fsZh}
                    {a.fsEn ? " · " + a.fsEn : ""}
                  </span>
                </td>
                <td className="c-time">{a.dep}</td>
                <td className="c-time">
                  {a.arr}
                  {a.dayOff > 0 ? (
                    <span className="plus"> +{a.dayOff}d</span>
                  ) : null}
                </td>
                <td className="c-time">{fmtTime(a.dur)}</td>
                <td className="num c-time">{fmtDist(a.km, unit)}</td>
                <td className="num">{a.stops}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    );
  } else {
    /* ---------------- outbound departures mode ---------------- */
    const deps = cur ? cur.deps : [];
    const list = deps.filter(
      (d) =>
        matchesRowFilters(d.dep, d.distKm, d.dur, d.cls, d.code) &&
        (!q || d.hay.indexOf(q) !== -1),
    );
    const { key, dir } = sort;
    list.sort((a, b) => {
      if (key === "dur" || key === "km") {
        const va = key === "dur" ? a.dur : a.km;
        const vb = key === "dur" ? b.dur : b.km;
        if (va < 0 && vb < 0) {
          /* fall through to tie-break */
        } else if (va < 0) return 1;
        else if (vb < 0) return -1;
        else if (va !== vb) return (va < vb ? -1 : 1) * dir;
      } else if (a.dep !== b.dep) {
        return (a.dep < b.dep ? -1 : 1) * dir;
      }
      if (a.dep !== b.dep) return a.dep < b.dep ? -1 : 1;
      return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    });

    if (!cur) showingNote = "";
    else if (hasExtraFilters)
      showingNote =
        "Showing " + list.length + " of " + deps.length + " departures";
    else if (key === "dep")
      showingNote =
        deps.length +
        " departures, " +
        (dir === 1 ? "earliest first" : "latest first");
    else if (key === "km")
      showingNote =
        deps.length +
        " departures, " +
        (dir === 1 ? "shortest distance first" : "longest distance first");
    else
      showingNote =
        deps.length +
        " departures, " +
        (dir === 1 ? "shortest duration first" : "longest duration first");

    const onSort = (k: SortKey) => {
      setSort((s) =>
        s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 },
      );
    };
    const arrow = (k: SortKey) =>
      sort.key === k ? (sort.dir === 1 ? "▲" : "▼") : "";
    const ariaSort = (k: SortKey) =>
      sort.key === k
        ? sort.dir === 1
          ? ("ascending" as const)
          : ("descending" as const)
        : undefined;

    heading = (
      <>
        Departures from{" "}
        <span id="depCityName">
          {cur ? cur.en + " · " + cur.o.zh : "…"}
        </span>{" "}
        <b className="dep-num-lead">{cur ? cur.deps.length : "…"}</b>
      </>
    );
    depNote = (
      <>
        Every train departing the selected city &mdash; from any of its
        stations &mdash; across the two timetable dates &mdash; Wednesday 21
        October 2026 (national) and Wednesday 28 October 2026 (intercity
        C/S). &ldquo;Stops&rdquo; counts the stops the train makes after leaving
        its origin-city station.
      </>
    );
    tableNode = (
      <table id="depTable">
        <thead>
          <tr>
            <th scope="col">Train</th>
            <th
              scope="col"
              className="sortable"
              data-sort="dep"
              aria-sort={ariaSort("dep")}
              onClick={() => onSort("dep")}
            >
              Departs <span className="arrow">{arrow("dep")}</span>
            </th>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Arrives</th>
            <th
              scope="col"
              className="sortable"
              data-sort="dur"
              aria-sort={ariaSort("dur")}
              onClick={() => onSort("dur")}
            >
              Duration <span className="arrow">{arrow("dur")}</span>
            </th>
            <th
              scope="col"
              className="num sortable"
              data-sort="km"
              aria-sort={ariaSort("km")}
              onClick={() => onSort("km")}
            >
              Distance <span className="arrow">{arrow("km")}</span>
            </th>
            <th scope="col" className="num">
              Stops
            </th>
          </tr>
        </thead>
        <tbody id="depBody">
          {!cur ? null : list.length === 0 ? (
            <tr>
              <td colSpan={8} className="dep-empty">
                No trains match that filter.
              </td>
            </tr>
          ) : (
            list.map((d, i) => (
              <tr
                key={i}
                className={
                  selectedTrainCodes.includes(d.code)
                    ? "dep-row-selected"
                    : undefined
                }
                onClick={(e) => handleRowClick(d.code, i, e, list)}
              >
                <td className="c-train">
                  <TrainCell
                    d={d}
                    onClick={
                      onSelectTrain ? () => onSelectTrain(d.code) : undefined
                    }
                  />
                </td>
                <td className="c-time">{d.dep}</td>
                <td>
                  {d.fsZh}
                  {d.fsEn ? <span className="to-stn">{d.fsEn}</span> : null}
                </td>
                <td>
                  <span className="to-city">
                    {d.tcEn} &middot; {d.tcZh}
                  </span>
                  <span className="to-stn">
                    {d.tsZh}
                    {d.tsEn ? " · " + d.tsEn : ""}
                  </span>
                </td>
                <td className="c-time">
                  {d.arr}
                  {depDayOffset(d) > 0 ? (
                    <span className="plus"> +{depDayOffset(d)}d</span>
                  ) : null}
                </td>
                <td className="c-time">{fmtTime(d.dur)}</td>
                <td className="num c-time">{fmtDist(d.km, unit)}</td>
                <td className="num">{d.stops}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    );
  }

  return (
    <section id="departures">
      <h2>{heading}</h2>
      <p className="dep-note">{depNote}</p>
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
      <div className="dep-tools">
        <input
          id="depFilter"
          type="search"
          placeholder="Filter by train, city, or station…"
          aria-label="Filter trains by train, city, or station"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div
          className="cls-filter"
          role="group"
          aria-label="Filter by train class"
        >
          <span className="cls-label">Class:</span>
          <button
            type="button"
            className="cls-btn"
            aria-pressed={selectedClasses.length === 0 ? "true" : "false"}
            onClick={() => onSelectClasses([])}
          >
            All
          </button>
          {FLOW_CLASSES.map((cls) => {
            const active = selectedClasses.includes(cls);
            const count = classCounts[cls] || 0;
            const enabled = count > 0;
            const label = cls === "plain" ? "普" : cls;
            return (
              <button
                key={cls}
                type="button"
                className="cls-btn"
                aria-pressed={active ? "true" : "false"}
                disabled={!enabled}
                title={
                  enabled
                    ? (CLASS_NAMES[cls] || cls) +
                      " (" +
                      count +
                      (count === 1 ? " train)" : " trains)")
                    : `No ${label} trains ${activeCity ? `between ${cur?.en || "origin"} and ${activeCity.en}` : `for ${cur?.en || "origin"}`}`
                }
                onClick={() => toggleClass(cls)}
              >
                {label}
              </button>
            );
          })}
        </div>
        {isolatedTrainCode ? (
          <span
            className="dep-chip"
            style={{
              background: "#2563EB",
              color: "#FFFFFF",
              borderColor: "#1D4ED8",
            }}
          >
            Isolated:{" "}
            <b style={{ marginLeft: 4, color: "#FFFFFF" }}>
              {isolatedTrainCode}
            </b>
            {onClearTrainIsolation ? (
              <button
                type="button"
                aria-label="Clear train isolation"
                onClick={onClearTrainIsolation}
                style={{ color: "#FFFFFF" }}
              >
                &times;
              </button>
            ) : null}
          </span>
        ) : null}
        {chipNode}
        {selectedTrainCodes.length > 0 ? (
          <span className="dep-chip">
            {selectedTrainCodes.length === 1 ? (
              <>
                Train: <b>{selectedTrainCodes[0]}</b>
              </>
            ) : (
              <>
                Trains: <b>{selectedTrainCodes.length} selected</b>
              </>
            )}
            <button
              type="button"
              aria-label="Clear selected trains"
              onClick={() => onSelectTrainCodes && onSelectTrainCodes([])}
            >
              &times;
            </button>
          </span>
        ) : null}
        {activeHours.length > 0 ? (
          <span className="dep-chip">
            {activeHours.length === 1 ? "Hour" : "Hours"}:{" "}
            <b>{formatHoursLabel(activeHours)}</b>
            <button
              type="button"
              aria-label="Clear hour filter"
              onClick={() => {
                if (onSelectHours) onSelectHours([]);
                setSelectedHour(null);
              }}
            >
              &times;
            </button>
          </span>
        ) : null}
        {activeDistBins.length > 0 ? (
          <span className="dep-chip">
            Distance: <b>{activeDistBins.map((b) => b.label).join(", ")}</b>
            <button
              type="button"
              aria-label="Clear distance filter"
              onClick={() => {
                if (onSelectDistBins) onSelectDistBins([]);
                setSelectedDistBin(null);
              }}
            >
              &times;
            </button>
          </span>
        ) : null}
        {activeDurBins.length > 0 ? (
          <span className="dep-chip">
            Time: <b>{activeDurBins.map((b) => b.label).join(", ")}</b>
            <button
              type="button"
              aria-label="Clear duration filter"
              onClick={() => {
                if (onSelectDurBins) onSelectDurBins([]);
                setSelectedDurBin(null);
              }}
            >
              &times;
            </button>
          </span>
        ) : null}
        <span className="dep-showing" id="depShowing">
          {showingNote}
        </span>
      </div>
      <p className="dep-swipe">Swipe sideways for all columns &rarr;</p>
      <div className="dep-scrollwrap">
        <div className="dep-scroll">{tableNode}</div>
        <div className="dep-fade" aria-hidden="true"></div>
      </div>
    </section>
  );
}
