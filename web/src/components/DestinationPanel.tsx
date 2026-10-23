import type { CityPointVM, DestVM, Direction, DistUnit, SrcVM } from "../types";
import { sourceRows, stationRows } from "../lib";

interface Props {
  point: CityPointVM | null;
  direction: Direction;
  cityEn: string; // the selected city (origin outbound, destination inbound)
  cityZh: string;
  unit: DistUnit;
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
  onClose,
}: Props) {
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

  return (
    <div id="destPanel">
      <button
        id="destClose"
        type="button"
        aria-label="Close city details"
        onClick={onClose}
      >
        &times;
      </button>
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
            {rows.map((r) => (
              <tr key={r[0]}>
                <td>{r[0]}</td>
                <td>{r[1]}</td>
              </tr>
            ))}
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
  );
}
