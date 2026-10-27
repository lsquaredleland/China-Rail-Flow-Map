import { useState } from "react";
import type { ReactNode } from "react";
import type {
  CityPointVM,
  DistBinFilter,
  DurBinFilter,
  OriginVM,
} from "../../types";
import { FLOW_CLASSES } from "../../lib";
import { formatHoursLabel } from "../../lib";
import { CLASS_NAMES } from "./helpers";

/* Search box, class buttons and the active-filter chips above the table. */
export default function FilterToolbar({
  cur,
  activeCity,
  query,
  onQueryChange,
  selectedClasses,
  onSelectClasses,
  classCounts,
  isolatedTrainCode,
  onClearTrainIsolation,
  chipNode,
  selectedTrainCodes,
  onSelectTrainCodes,
  activeHours,
  onSelectHours,
  setSelectedHour,
  activeDistBins,
  onSelectDistBins,
  setSelectedDistBin,
  activeDurBins,
  onSelectDurBins,
  setSelectedDurBin,
  showingNote,
  allClasses = false,
}: {
  cur: OriginVM | null;
  activeCity: CityPointVM | null;
  query: string;
  onQueryChange: (q: string) => void;
  selectedClasses: string[];
  onSelectClasses: (classes: string[]) => void;
  classCounts: Record<string, number>;
  isolatedTrainCode?: string | null;
  onClearTrainIsolation?: () => void;
  chipNode: ReactNode;
  selectedTrainCodes: string[];
  onSelectTrainCodes?: (codes: string[]) => void;
  activeHours: number[];
  onSelectHours?: (hours: number[]) => void;
  setSelectedHour: (h: number | null) => void;
  activeDistBins: DistBinFilter[];
  onSelectDistBins?: (bins: DistBinFilter[]) => void;
  setSelectedDistBin: (b: DistBinFilter | null) => void;
  activeDurBins: DurBinFilter[];
  onSelectDurBins?: (bins: DurBinFilter[]) => void;
  setSelectedDurBin: (b: DurBinFilter | null) => void;
  showingNote: string;
  /** National mode: the toolbar's class filter offers all classes, so does this one. */
  allClasses?: boolean;
}) {
  const toggleClass = (cls: string) => {
    onSelectClasses(
      selectedClasses.includes(cls)
        ? selectedClasses.filter((c) => c !== cls)
        : [...selectedClasses, cls],
    );
  };

  const [clsOpen, setClsOpen] = useState(false);
  return (
<div className={"dep-tools" + (clsOpen ? " cls-open" : "")}>
  <input
    id="depFilter"
    type="search"
    placeholder="Filter by train, city, or station…"
    aria-label="Filter trains by train, city, or station"
    value={query}
    onChange={(e) => onQueryChange(e.target.value)}
  />
  <button
    type="button"
    className="tb-mob-btn dep-cls-btn"
    aria-label="Train class filter"
    aria-expanded={clsOpen}
    onClick={() => setClsOpen((v) => !v)}
  >
    <svg className="tb-ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="16" cy="7" r="2.4" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="8" cy="17" r="2.4" fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
    {selectedClasses.length > 0 && <span className="tb-badge">{selectedClasses.length}</span>}
  </button>
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
      const enabled = allClasses || count > 0;
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
                (count > 0 ? " (" + count + (count === 1 ? " train)" : " trains)") : "")
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
      className="dep-chip is-isolated"
    >
      Isolated:{" "}
      <b>{isolatedTrainCode}</b>
      {onClearTrainIsolation ? (
        <button
          type="button"
          aria-label="Clear train isolation"
          onClick={onClearTrainIsolation}
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
  );
}
