import { useState } from "react";
import type { StationCount } from "../../stationBreakdown";

/** "重庆北 Chongqing North 82 · 重庆西 …": the heading's count split by station. */
export default function StationLine({
  stations,
}: {
  stations: StationCount[] | null;
}) {
  const [open, setOpen] = useState(false);
  if (!stations || stations.length === 0) return null;
  // Phones show the first two stations and a toggle for the rest (CSS).
  const more = stations.length - 2;
  return (
    <p className={"dep-stations" + (open ? " open" : "")} aria-label="Trains by station">
      {stations.map((s, i) => (
        <span className="dep-st" key={s.zh}>
          {i > 0 && " · "}
          {s.zh}
          {s.en && s.en !== s.zh && <span className="dep-st-en"> {s.en}</span>}{" "}
          <b>{s.n}</b>
        </span>
      ))}
      {more > 0 && (
        <button type="button" className="dep-st-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "less ▴" : `+${more} more ▾`}
        </button>
      )}
    </p>
  );
}
