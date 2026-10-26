/* Floating controls drawn over the map canvas. */

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

/** National mode's note and its two independent toggles: what the dots mean
    (every train that runs at least once in the schedule window `span`, from
    the pack's calendar, all on one 24-hour clock), Flows (the day's trains
    per section and the city circles) and Animation (the trains' dots on the
    clock, off until pressed). */
export function NationalNote({
  trains,
  span,
  failed,
  flows,
  animate,
  onFlows,
  onAnimate,
  flowsFailed,
}: {
  trains: number;
  span: string | undefined;
  failed: boolean;
  flows: boolean;
  animate: boolean;
  onFlows: () => void;
  onAnimate: () => void;
  flowsFailed: boolean;
}) {
  return (
    <div className="nat-note" role="note">
      <span>
        Trains of China Rail
        {trains ? ` · ${trains.toLocaleString("en-US")} trains` : ""}
        {span ? ` · ${span}, all on one 24-hour clock` : ""}
      </span>
      {failed && <span>The national train data could not be loaded.</span>}
      {flowsFailed && <span>The national flow data could not be loaded.</span>}
      <span className="nat-layers" role="group" aria-label="National map layers">
        <button
          id="natFlows"
          type="button"
          aria-pressed={flows ? "true" : "false"}
          title="Trains per day on each section, and a circle per city sized by its departures and arrivals"
          onClick={() => onFlows()}
        >
          Flows
        </button>
        <button
          id="natAnimate"
          type="button"
          aria-pressed={animate ? "true" : "false"}
          title="Play every train as a dot on the 24-hour clock"
          onClick={() => onAnimate()}
        >
          Animation
        </button>
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
