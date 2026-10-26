import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DistUnit, RawTrain } from "../../types";
import { fmtClock, fmtDist, fmtTime } from "../../lib";
import type { NatRow, NatSortKey } from "../../lib";
import EmptyMessage from "./EmptyMessage";
import TrainCell from "./TrainCell";
import { RunsLabel } from "./RunsCell";
import { ariaSort, sortArrow } from "./sorting";
import type { SortState } from "./types";

/* The national trains table, in the origin table's look. 11k rows are
   windowed: rows have a fixed height (CSS .nat-table), only the ones in view
   plus a margin are in the DOM, and two spacer rows stand in for the rest, so
   the scroller keeps its full height and scrollbar. The rows arrive filtered
   and sorted. */

export const NAT_ROW_H = 46;
const OVERSCAN = 8;

export function natWindow(scrollTop: number, viewH: number, n: number): [number, number] {
  const first = Math.min(n, Math.max(0, Math.floor(scrollTop / NAT_ROW_H) - OVERSCAN));
  const last = Math.min(n, Math.ceil((scrollTop + viewH) / NAT_ROW_H) + OVERSCAN);
  return [first, Math.max(first, last)];
}

export default function NatTable({
  list,
  sort,
  onSort,
  unit,
  trainTable,
  calendar,
  loaded,
  onSelectTrain,
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
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const scroller = useRef<HTMLDivElement>(null);

  // A new filter or sort starts from the top.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
  }, [list]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight || 400);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const [first, last] = natWindow(scrollTop, viewH, list.length);
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
    <div className="dep-scroll" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <table id="depTable" className="nat-table">
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
              {first > 0 && (
                <tr className="nat-spacer" aria-hidden="true" style={{ height: first * NAT_ROW_H }}>
                  <td colSpan={7} />
                </tr>
              )}
              {list.slice(first, last).map((r) => {
                const tr = trainTable[r.t];
                return (
                  <tr key={r.t} onClick={onSelectTrain ? () => onSelectTrain(r.code) : undefined}>
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
              {last < list.length && (
                <tr className="nat-spacer" aria-hidden="true" style={{ height: (list.length - last) * NAT_ROW_H }}>
                  <td colSpan={7} />
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
