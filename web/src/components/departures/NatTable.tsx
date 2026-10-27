import type { DistUnit, RawTrain } from "../../types";
import { fmtClock, fmtDist, fmtTime } from "../../lib";
import type { NatRow, NatSortKey } from "../../lib";
import EmptyMessage from "./EmptyMessage";
import TrainCell from "./TrainCell";
import { RunsLabel } from "./RunsCell";
import { ariaSort, sortArrow } from "./sorting";
import type { SortState } from "./types";
import WindowedTable, { NAT_ROW_H } from "./WindowedTable";

/* The national trains table, in the origin table's look. 11k rows are
   windowed (WindowedTable). The rows arrive filtered and sorted. */

export default function NatTable({
  list,
  sort,
  onSort,
  unit,
  trainTable,
  calendar,
  loaded,
  onSelectTrain,
  onToggleIsolate,
}: {
  list: NatRow[];
  sort: SortState<NatSortKey>;
  onSort: (k: NatSortKey) => void;
  unit: DistUnit;
  trainTable: readonly RawTrain[];
  calendar?: readonly string[];
  /** The schedules the rows are read from have loaded. */
  loaded: boolean;
  onSelectTrain?: (code: string) => void;
  /** A row click isolates the train on the map; the train link opens its timetable. */
  onToggleIsolate?: (code: string) => void;
}) {
  const th = (k: NatSortKey, label: string, cls?: string) => (
    <th
      scope="col"
      className={"sortable" + (cls ? " " + cls : "")}
      data-sort={k}
      aria-sort={ariaSort(sort, k)}
      onClick={() => onSort(k)}
    >
      {label} <span className="arrow">{sortArrow(sort, k)}</span>
    </th>
  );

  return (
    // A new filter or sort starts from the top.
    <WindowedTable n={list.length} rowH={NAT_ROW_H} cols={7} className="nat-table" resetKey={list}>
      {(w) => (
        <>
        <thead>
          <tr>
            {th("code", "Train")}
            <th scope="col">From → To</th>
            {th("dep", "Departs")}
            {th("arr", "Arrives")}
            {th("dur", "Duration")}
            {th("km", "Distance", "num")}
            {th("runs", "Runs")}
          </tr>
        </thead>
        <tbody id="depBody">
          {!loaded ? (
            <tr>
              <td colSpan={7} className="dep-empty">
                Loading the timetable…
              </td>
            </tr>
          ) : list.length === 0 ? (
            <tr>
              <td colSpan={7} className="dep-empty">
                <EmptyMessage cur={null} direction="out" query="" tablesLoaded={true} />
              </td>
            </tr>
          ) : (
            <>
              {w.top}
              {list.slice(w.first, w.last).map((r, k) => {
                const tr = trainTable[r.t];
                return (
                  <tr key={r.t} {...w.tr(w.first + k)} onClick={onToggleIsolate ? () => onToggleIsolate(r.code) : undefined}>
                    <td className="c-train">
                      <TrainCell d={{ code: r.code, cls: r.cls }} onClick={onSelectTrain ? () => onSelectTrain(r.code) : undefined} />
                    </td>
                    <td className="nat-route">
                      <span className="to-city">
                        {r.from} → {r.to}
                      </span>
                      <span className="to-stn">
                        {r.fromEn} → {r.toEn}
                      </span>
                    </td>
                    <td className="c-time">{r.dep >= 0 ? fmtClock(r.dep) : "—"}</td>
                    <td className="c-time">
                      {r.arr >= 0 ? fmtClock(r.arr % 1440) : "—"}
                      {r.arr >= 1440 ? <span className="plus"> +{Math.floor(r.arr / 1440)}d</span> : null}
                    </td>
                    <td className="c-time">{fmtTime(r.dur)}</td>
                    <td className="num c-time">{fmtDist(r.km, unit)}</td>
                    <td className="c-runs">
                      <RunsLabel days={tr.days} pattern={tr.pattern} calendar={calendar} />
                    </td>
                  </tr>
                );
              })}
              {w.bottom}
            </>
          )}
        </tbody>
        </>
      )}
    </WindowedTable>
  );
}
