import type { DistBinFilter, DurBinFilter } from "../types";
import { formatHoursLabel } from "../lib";
import { InSlot } from "./MapCards";

export default function ActiveFilterBar({
  classes,
  hours,
  distBins,
  durBins,
  trainCodes,
  onClearClass,
  onClearHours,
  onClearDist,
  onClearDur,
  onClearTrains,
  onClearAll,
}: {
  classes: string[];
  hours: number[];
  distBins: DistBinFilter[];
  durBins: DurBinFilter[];
  trainCodes: string[];
  onClearClass: (cls: string) => void;
  onClearHours: () => void;
  onClearDist: () => void;
  onClearDur: () => void;
  onClearTrains: () => void;
  onClearAll: () => void;
}) {
  const hasAny =
    classes.length > 0 ||
    hours.length > 0 ||
    distBins.length > 0 ||
    durBins.length > 0 ||
    trainCodes.length > 0;
  if (!hasAny) return null;

  return (
    <InSlot>
    <div
      className="map-card active-filter-bar"
      role="status"
      aria-label="Active map and table filters"
    >
      <div className="mc-main filter-main">
      <span className="filter-pill-label">Filtered</span>
      {classes.map((cls) => (
        <span key={cls} className="filter-pill">
          <span className="mc-class">{cls === "plain" ? "普" : cls}</span>
          Class: {cls === "plain" ? "普" : cls}
          <button
            type="button"
            aria-label={`Remove class ${cls} filter`}
            onClick={() => onClearClass(cls)}
          >
            &times;
          </button>
        </span>
      ))}
      {trainCodes.length > 0 && (
        <span className="filter-pill">
          {trainCodes.length === 1
            ? `Train: ${trainCodes[0]}`
            : `Trains: ${trainCodes.length} selected`}
          <button
            type="button"
            aria-label="Remove train selection"
            onClick={onClearTrains}
          >
            &times;
          </button>
        </span>
      )}
      {hours.length > 0 && (
        <span className="filter-pill">
          {hours.length === 1 ? "Hour" : "Hours"}: {formatHoursLabel(hours)}
          <button
            type="button"
            aria-label="Remove hour filter"
            onClick={onClearHours}
          >
            &times;
          </button>
        </span>
      )}
      {distBins.length > 0 && (
        <span className="filter-pill">
          Dist: {distBins.map((b) => b.label).join(", ")}
          <button
            type="button"
            aria-label="Remove distance filter"
            onClick={onClearDist}
          >
            &times;
          </button>
        </span>
      )}
      {durBins.length > 0 && (
        <span className="filter-pill">
          Time: {durBins.map((b) => b.label).join(", ")}
          <button
            type="button"
            aria-label="Remove duration filter"
            onClick={onClearDur}
          >
            &times;
          </button>
        </span>
      )}
      </div>
      <button
        type="button"
        className="mc-btn filter-clear-all"
        onClick={onClearAll}
        title="Reset all filters"
      >
        Reset
      </button>
    </div>
    </InSlot>
  );
}
