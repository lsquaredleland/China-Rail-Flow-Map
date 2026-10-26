/* The two collapsed map cards: the city card (minimised destination panel)
   and the train card (minimised timetable, isolation chip). Same frame:
   black rule on top, 2px frame, no radius, one solid action, one outlined
   close. Styles in styles/cards.css. */

import { createPortal } from "react-dom";
import { palette, rampColor } from "../lib/palette";
import type { RampStop } from "../types";

/** The cards live in one reserved stack (#mapCards, top-right of the map)
    that the legend, scale bar, expand button and timeline are laid out
    around, so they never cover each other. Without the host (tests) a card
    renders in place. */
export function InSlot({ children }: { children: React.ReactElement }) {
  const host = typeof document === "undefined" ? null : document.getElementById("mapCards");
  return host ? createPortal(children, host) : children;
}

export function MapCardSlot() {
  return <div id="mapCards" className="map-cards" />;
}

export type TrainCardState = "en-route" | "stopped" | "not-departed" | "arrived" | "isolated";

const STATE_LABEL: Record<TrainCardState, string> = {
  "en-route": "En route",
  stopped: "At station",
  "not-departed": "Not yet departed",
  arrived: "Arrived",
  isolated: "Isolated",
};

/** A train's fastest-time band colour for the card; at night the saffron
    band lifts to #F0B85A (the global ramp is unchanged). */
export function cardBand(mins: number, dark: boolean): string {
  const pal = palette(dark);
  if (!dark) return rampColor(mins, pal);
  const lift = pal.ramp.map(([t, c]) =>
    [t, c[0] === 227 && c[1] === 166 && c[2] === 63 ? [240, 184, 90] : c] as RampStop);
  return rampColor(mins, { ...pal, ramp: lift });
}

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
  onExpand?: () => void; // no expanded panel (national): no Details button
  onClose: () => void;
  expandRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <InSlot>
    <div
      className="map-card city-card"
      role="dialog"
      aria-label={`${en} city details (minimized)`}
    >
      <div className={"mc-main" + (onExpand ? " mc-click" : "")} onClick={onExpand}>
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
      {onExpand && (
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
      )}
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
    </InSlot>
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
    <InSlot>
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
    </InSlot>
  );
}
