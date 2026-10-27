/* Inbound, no source: every train arriving in the origin city. */
import type { ArrVM, OriginVM } from "../../types";
import { fmtDist, fmtTime, runRank } from "../../lib";
import EmptyMessage from "./EmptyMessage";
import WindowedTable, { ORIGIN_ROW_H } from "./WindowedTable";
import TrainCell from "./TrainCell";
import RunsCell from "./RunsCell";
import HeadCount from "./HeadCount";
import { byClass, classTag } from "./helpers";
import { ariaSort, nextSort, sortArrow } from "./sorting";
import { arrStations } from "../../stationBreakdown";
import type { DepCtx, ModeView, ArrSortKey } from "./types";

export function inArrivalsMode(ctx: DepCtx, cur: OriginVM): ModeView {
  const {
    unit,
    q,
    hasExtraFilters,
    matchesRowFilters,
    selectedTrainCodes,
    handleRowClick,
    onSelectTrain,
    arrSort,
    setArrSort,
    emptyProps,
    atlas,
  } = ctx;
  let showingNote: string;
  const arrs = cur.arrs;
  const stations = arrStations(arrs, ctx.selectedClasses);
  const count = byClass(arrs, ctx.selectedClasses, (a) => a.cls).length;
  const tag = classTag(ctx.selectedClasses);
  const list: ArrVM[] = arrs.filter(
    (a) =>
      matchesRowFilters(a.arr, a.distKm, a.dur, a.cls, a.code) &&
      (!q || a.hay.indexOf(q) !== -1),
  );
  const { key: ak, dir: adir } = arrSort;
  list.sort((a, b) => {
    if (ak === "runs") {
      const dd = runRank(atlas?.data.train_table[a.t], atlas?.data.calendar) - runRank(atlas?.data.train_table[b.t], atlas?.data.calendar);
      if (dd) return dd * adir;
    }
    if (ak === "dur" || ak === "km") {
      const va = ak === "dur" ? a.dur : a.km;
      const vb = ak === "dur" ? b.dur : b.km;
      if (va < 0 && vb < 0) {
        /* fall through to tie-break */
      } else if (va < 0) return 1;
      else if (vb < 0) return -1;
      else if (va !== vb) return (va < vb ? -1 : 1) * adir;
    } else if (ak === "arr") {
      if (a.dayOff !== b.dayOff) return (a.dayOff - b.dayOff) * adir;
      if (a.arr !== b.arr) return (a.arr < b.arr ? -1 : 1) * adir;
    } else if (a.dep !== b.dep) {
      return (a.dep < b.dep ? -1 : 1) * adir;
    }
    if (a.arr !== b.arr) return a.arr < b.arr ? -1 : 1;
    if (a.dep !== b.dep) return a.dep < b.dep ? -1 : 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });

  if (hasExtraFilters)
    showingNote = "Showing " + list.length + " of " + arrs.length + " arrivals";
  else if (ak === "arr")
    showingNote =
      arrs.length +
      " arrivals, " +
      (adir === 1 ? "earliest first" : "latest first");
  else if (ak === "dep")
    showingNote =
      arrs.length +
      " arrivals, " +
      (adir === 1 ? "earliest departure first" : "latest departure first");
  else if (ak === "km")
    showingNote =
      arrs.length +
      " arrivals, " +
      (adir === 1 ? "shortest distance first" : "longest distance first");
  else
    showingNote =
      arrs.length +
      " arrivals, " +
      (adir === 1 ? "shortest duration first" : "longest duration first");

  const onArrSort = (k: ArrSortKey) => setArrSort((s) => nextSort(s, k));
  const aArrow = (k: ArrSortKey) => sortArrow(arrSort, k);
  const aAriaSort = (k: ArrSortKey) => ariaSort(arrSort, k);

  const heading = (
    <>
      {tag ? tag + " arrivals into" : "Arrivals into"}{" "}
      <span id="depCityName">
        {cur.en} &middot; {cur.o.zh}
      </span>{" "}
      &mdash; <span id="depCount">
        <HeadCount n={count} total={arrs.length} suffix=" arrivals" />
      </span>
    </>
  );
  const depNote = (
    <>
      Every train arriving in the selected city &mdash; from wherever
      it starts &mdash; for every train in the timetable window.
    </>
  );
  const tableNode = (
    <WindowedTable n={list.length} rowH={ORIGIN_ROW_H} cols={8}>
      {(w) => (
      <>
      <thead>
        <tr>
          <th scope="col">Train</th>
          <th
            scope="col"
            className="sortable"
            data-sort="dep"
            aria-sort={aAriaSort("dep")}
            onClick={() => onArrSort("dep")}
          >
            Departs <span className="arrow">{aArrow("dep")}</span>
          </th>
          <th scope="col">Origin</th>
          <th
            scope="col"
            className="sortable"
            data-sort="arr"
            aria-sort={aAriaSort("arr")}
            onClick={() => onArrSort("arr")}
          >
            Arrives <span className="arrow">{aArrow("arr")}</span>
          </th>
          <th
            scope="col"
            className="sortable"
            data-sort="dur"
            aria-sort={aAriaSort("dur")}
            onClick={() => onArrSort("dur")}
          >
            Duration <span className="arrow">{aArrow("dur")}</span>
          </th>
          <th
            scope="col"
            className="num sortable"
            data-sort="km"
            aria-sort={aAriaSort("km")}
            onClick={() => onArrSort("km")}
          >
            Distance <span className="arrow">{aArrow("km")}</span>
          </th>
          <th scope="col" className="num">
            Stops
          </th>
          <th
            scope="col"
            className="sortable"
            data-sort="runs"
            aria-sort={aAriaSort("runs")}
            onClick={() => onArrSort("runs")}
          >
            Runs <span className="arrow">{aArrow("runs")}</span>
          </th>
        </tr>
      </thead>
      <tbody id="depBody">
        {list.length === 0 ? (
          <tr>
            <td colSpan={8} className="dep-empty">
              <EmptyMessage {...emptyProps} />
            </td>
          </tr>
        ) : (
          <>{w.top}{list.map((a, i) => i < w.first || i >= w.last ? null : (
            <tr
              key={i}
              {...w.tr(i, selectedTrainCodes.includes(a.code) ? "dep-row-selected" : undefined)}
              onClick={(e) => handleRowClick(a.code, i, e, list)}
            >
              <td className="c-train">
                <TrainCell
                  d={a}
                  onClick={
                    onSelectTrain ? () => onSelectTrain(a.code) : undefined
                  }
                />
              </td>
              <td className="c-time">{a.dep}</td>
              <td>
                <span className="to-city">
                  {a.fcEn} &middot; {a.fcZh}
                </span>
                <span className="to-stn">
                  {a.fsZh}
                  {a.fsEn ? " · " + a.fsEn : ""}
                </span>
              </td>
              <td className="c-time">
                {a.arr}
                {a.dayOff > 0 ? (
                  <span className="plus"> +{a.dayOff}d</span>
                ) : null}
              </td>
              <td className="c-time">{fmtTime(a.dur)}</td>
              <td className="num c-time">{fmtDist(a.km, unit)}</td>
              <td className="num">{a.stops}</td>
              <RunsCell atlas={atlas} t={a.t} />
            </tr>
          ))}{w.bottom}</>
        )}
      </tbody>
      </>
      )}
    </WindowedTable>
  );
  return { heading, depNote, stations, count, total: arrs.length, showingNote, tableNode };
}
