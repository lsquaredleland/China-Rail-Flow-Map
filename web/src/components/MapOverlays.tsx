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
