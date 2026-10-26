/* The two collapsed map cards: the city card (minimised destination panel)
   and the train card (minimised timetable, isolation chip). Same frame:
   black rule on top, 2px frame, no radius, one solid action, one outlined
   close. Styles in styles/cards.css. */

export type TrainCardState = "en-route" | "stopped" | "not-departed" | "arrived" | "isolated";

const STATE_LABEL: Record<TrainCardState, string> = {
  "en-route": "En route",
  stopped: "At station",
  "not-departed": "Not yet departed",
  arrived: "Arrived",
  isolated: "Isolated",
};

/** "重庆北 Chongqing North": Chinese name then English, once if identical. */
export function cardStName(zh: string, en?: string): string {
  return en && en !== zh ? `${zh} ${en}` : zh;
}

export function CityCard({
  en,
  zh,
  sub,
  count,
  countLabel = "trains",
  onExpand,
  onClose,
  expandRef,
}: {
  en: string;
  zh: string;
  sub?: string; // text before the count ("from Chongqing"); empty for none
  count?: number;
  countLabel?: string;
  onExpand: () => void;
  onClose: () => void;
  expandRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <div
      className="map-card city-card"
      role="dialog"
      aria-label={`${en} city details (minimized)`}
    >
      <div className="mc-main mc-click" onClick={onExpand}>
        <div className="mc-title">
          <svg className="mc-pin" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="8" cy="8" r="2" fill="currentColor" />
          </svg>
          <span className="mc-ell">
            {en} {zh}
          </span>
        </div>
        <div className="mc-sub mc-ell">
          {sub}
          {sub && count ? " · " : ""}
          {count ? (
            <>
              <b>{count}</b> {countLabel}
            </>
          ) : null}
        </div>
      </div>
      <button
        ref={expandRef}
        type="button"
        className="mc-btn"
        onClick={onExpand}
        title="Expand city details"
        aria-label="Expand city details"
      >
        <span aria-hidden="true">↗</span> <span className="mc-btn-t">Details</span>
      </button>
      <button
        type="button"
        className="mc-close"
        onClick={onClose}
        title="Close city details"
        aria-label="Close city details"
      >
        ✕
      </button>
    </div>
  );
}

export function TrainCard({
  code,
  route,
  state,
  leg,
  band,
  isolated,
  onTimetable,
  onClose,
  closeLabel,
  ariaLabel,
}: {
  code: string;
  route: string;
  state: TrainCardState;
  leg: string;
  band: string; // the train's fastest-time band colour
  isolated?: boolean;
  onTimetable: () => void;
  onClose: () => void;
  closeLabel: string;
  ariaLabel: string;
}) {
  const m = /^([A-Za-z]+)(.*)$/.exec(code);
  const letter = m ? m[1] : "";
  const num = m ? m[2] : code;
  return (
    <div
      className={"map-card train-card" + (isolated ? " is-isolated" : "")}
      role="dialog"
      aria-label={ariaLabel}
    >
      <div className="mc-id">
        <span className="mc-band" style={{ background: band }} />
        {letter && <span className="mc-class">{letter}</span>}
        <span className="mc-num">{num}</span>
      </div>
      <div className="mc-main">
        <div className="mc-title mc-ell">{route}</div>
        <div className="mc-sub mc-ell">
          <span className={"mc-state is-" + state}>{STATE_LABEL[state]}</span>
          {leg ? <span className="mc-leg"> {leg}</span> : null}
        </div>
      </div>
      <button type="button" className="mc-btn" onClick={onTimetable} title="Open the full timetable" aria-label="Open the full timetable">
        <span aria-hidden="true">↗</span> <span className="mc-btn-t">Timetable</span>
      </button>
      <button
        type="button"
        className="mc-close"
        onClick={onClose}
        title={closeLabel}
        aria-label={closeLabel}
      >
        ✕
      </button>
    </div>
  );
}
