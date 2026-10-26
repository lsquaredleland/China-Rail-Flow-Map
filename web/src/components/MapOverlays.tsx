/* Floating controls drawn over the map canvas. */
import { TrainCard } from "./MapCards";

/** The isolated train as a train card while one train is isolated (hidden
    while its timetable is open: the modal's own card covers it). */
export function IsolationChip({
  code,
  route,
  band,
  onTimetable,
  onExit,
}: {
  code: string;
  route: string;
  band: string;
  onTimetable: () => void;
  onExit: () => void;
}) {
  return (
    <TrainCard
        code={code}
        route={route || code}
        state="isolated"
        leg="Only this train is shown"
        band={band}
        isolated
        onTimetable={onTimetable}
        onClose={onExit}
        closeLabel="Exit single train isolation"
        ariaLabel={`Train ${code} isolated`}
      />
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
