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
}) {
  const toggleClass = (cls: string) => {
    onSelectClasses(
      selectedClasses.includes(cls)
        ? selectedClasses.filter((c) => c !== cls)
        : [...selectedClasses, cls],
    );
  };

  return (
<div className="dep-tools">
  <input
    id="depFilter"
    type="search"
    placeholder="Filter by train, city, or station…"
    aria-label="Filter trains by train, city, or station"
    value={query}
    onChange={(e) => onQueryChange(e.target.value)}
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
  );
}
