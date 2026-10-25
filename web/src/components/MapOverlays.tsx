/* Floating controls drawn over the map canvas. */
import type { NatLayer } from "../types";

/** "Isolated: K9217 [Timetable] [x]" pill while one train is isolated. */
export function IsolationChip({
  code,
  onTimetable,
  onExit,
}: {
  code: string;
  onTimetable: () => void;
  onExit: () => void;
}) {
  return (
    <div className="iso-chip">
      <span className="iso-chip-dot" />
      <span>
        Isolated: <strong className="iso-chip-code">{code}</strong>
      </span>
      <button
        type="button"
        className="iso-chip-timetable"
        onClick={() => onTimetable()}
      >
        Timetable
      </button>
      <button
        type="button"
        className="iso-chip-exit"
        onClick={() => onExit()}
        title="Exit single train isolation"
      >
        ✕
      </button>
    </div>
  );
}

const NAT_LAYERS: { v: NatLayer; label: string; title: string }[] = [
  { v: "trains", label: "Trains", title: "Every train's dot on the 24h clock" },
  { v: "flows", label: "Flows", title: "Trains per day on each section" },
  { v: "both", label: "Trains + flows", title: "Dots over the flows, built up to the clock's time" },
];

/** National mode's coverage note: the trains drawn and the schedule window
    they run in (`span`, from the pack's calendar), and what the map draws
    (trains, flows, or both: P3.2 / P3.3). */
export function NationalNote({
  trains,
  span,
  failed,
  layer,
  onLayer,
  flowsFailed,
}: {
  trains: number;
  span: string | undefined;
  failed: boolean;
  layer: NatLayer;
  onLayer: (v: NatLayer) => void;
  flowsFailed: boolean;
}) {
  return (
    <div className="nat-note" role="note">
      <span className="nat-note-tag">National · beta</span>
      <span>
        {failed
          ? "The national train data could not be loaded."
          : trains
          ? `${trains.toLocaleString("en-US")} trains running${span ? " " + span : ""}`
          : "Loading national trains…"}
      </span>
      {flowsFailed && <span>The national flow data could not be loaded.</span>}
      <span className="nat-layers" role="group" aria-label="National map layers">
        {NAT_LAYERS.map((o) => (
          <button
            key={o.v}
            id={"natLayer-" + o.v}
            type="button"
            aria-pressed={layer === o.v ? "true" : "false"}
            title={o.title}
            onClick={() => onLayer(o.v)}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** The collapsed 24h-animation entry button. */
export function TimelineExpandButton({ onExpand }: { onExpand: () => void }) {
  return (
    <div className="tl-expand-wrap">
      <button
        type="button"
        className="tl-expand-btn is-over-map"
        onClick={onExpand}
        title="Expand 24h train flow animation controls"
      >
        <span className="tl-expand-dot" />
        <span>24h Flow Animation · Expand ▴</span>
      </button>
    </div>
  );
}
