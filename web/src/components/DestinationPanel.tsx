import { useEffect, useRef, useState } from "react";
import type { CityPointVM, DestVM, Direction, DistUnit, SrcVM } from "../types";
import { sourceRows, stationRows } from "../lib";
import { CityCard, InSlot } from "./MapCards";

interface Props {
  point: CityPointVM | null;
  direction: Direction;
  cityEn: string; // the selected city (origin outbound, destination inbound)
  cityZh: string;
  unit: DistUnit;
  /** Minimised card line before the count; national mode has no origin
      ("120 departures · 98 arrivals"). Default: "from <city>". */
  sub?: string;
  onClose: () => void;
}

/* The pinned city detail card: a corner panel on wide screens, a bottom
   sheet on phones (CSS). Outbound it describes a destination reached
   from the origin; inbound it mirrors for a source city sending trains
   in. Pinning a city also filters the table below the map to that
   city — App owns that coupling. */
export default function DestinationPanel({
  point,
  direction,
  cityEn,
  cityZh,
  unit,
  sub,
  onClose,
}: Props) {
  // Minimized keeps the selection (map highlight, flows, table filter);
  // only the card collapses. It stays minimized while another city is
  // picked (the pill just follows), and resets once the panel is closed.
  const [minimized, setMinimized] = useState(false);
  const hasPoint = point !== null;
  const minBtn = useRef<HTMLButtonElement | null>(null);
  const expandBtn = useRef<HTMLButtonElement | null>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (!hasPoint) setMinimized(false);
  }, [hasPoint]);
  // Hand keyboard focus to the control that replaces the one just used.
  useEffect(() => {
    if (!toggled.current) return;
    (minimized ? expandBtn : minBtn).current?.focus({ preventScroll: true });
  }, [minimized]);
  const setMin = (v: boolean) => {
    toggled.current = true;
    setMinimized(v);
  };

  if (!point) return null;
  const rows =
    direction === "out"
      ? stationRows(point as DestVM, cityEn, unit)
      : sourceRows(point as SrcVM, cityEn, unit);

  const scrollToDepartures = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = document.getElementById("departures");
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  if (minimized) {
    return (
      <CityCard
        en={point.en}
        zh={point.zh}
        sub={
          sub !== undefined
            ? sub
            : `${direction === "out" ? "from " : "to "}${cityEn}`
        }
        count={point.trains}
        onExpand={() => setMin(false)}
        onClose={onClose}
        expandRef={expandBtn}
      />
    );
  }

  return (
    <InSlot>
    <div id="destPanel">
      <div className="dp-actions">
        <button
          ref={minBtn}
          id="destMin"
          type="button"
          title="Minimize to a compact pill"
          aria-label="Minimize city details"
          onClick={() => setMin(true)}
        >
          —
        </button>
        <button
          id="destClose"
          type="button"
          title="Close city details (Esc)"
          aria-label="Close city details"
          onClick={onClose}
        >
          &times;
        </button>
      </div>
      <div id="destBody">
        <div className="dp-badge">SELECTED</div>
        <div className="dp-title">
          {point.en} &middot; {point.zh}
        </div>
        <div className="dp-sub">
          {direction === "out" ? "from " : "to "}
          {cityEn} &middot; {cityZh}
        </div>
        <table>
          <tbody>
            {rows.map((r) => {
              const isAccent = r[0].startsWith("Fastest") || r[0] === "By rail";
              return (
                <tr key={r[0]}>
                  <td>{r[0]}</td>
                  <td className={isAccent ? "accent-val" : undefined}>{r[1]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {point.trains > 0 && (
          <div className="dp-link-row">
            <a
              href="#departures"
              className="dp-link"
              onClick={scrollToDepartures}
            >
              See all {point.trains} trains &darr;
            </a>
          </div>
        )}
      </div>
    </div>
    </InSlot>
  );
}
