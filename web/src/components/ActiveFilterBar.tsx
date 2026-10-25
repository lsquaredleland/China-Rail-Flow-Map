import type { DistBinFilter, DurBinFilter } from "../types";

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
    <div
      className="active-filter-bar"
      role="status"
      aria-label="Active map and table filters"
    >
      <span className="filter-pill-label">Filtered:</span>
      {classes.map((cls) => (
        <span key={cls} className="filter-pill">
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
      <button
        type="button"
        className="filter-clear-all"
        onClick={onClearAll}
        title="Reset all filters"
      >
        Reset
      </button>
    </div>
  );
}
