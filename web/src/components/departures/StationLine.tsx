import { Fragment } from "react";
import type { StationCount } from "../../stationBreakdown";

/** "重庆北 Chongqing North 82 · 重庆西 …": the heading's count split by station. */
export default function StationLine({ stations }: { stations: StationCount[] | null }) {
  if (!stations || stations.length === 0) return null;
  return (
    <p className="dep-stations" aria-label="Trains by station">
      {stations.map((s, i) => (
        <Fragment key={s.zh}>
          {i > 0 && " · "}
          <span className="dep-st">
            {s.zh}
            {s.en && s.en !== s.zh && <span className="dep-st-en"> {s.en}</span>}{" "}
            <b>{s.n}</b>
          </span>
        </Fragment>
      ))}
    </p>
  );
}
