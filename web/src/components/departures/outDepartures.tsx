/* Outbound, no destination: every train departing the origin city. */
import { fmtDist, fmtTime, runRank } from "../../lib";
import WindowedTable, { ORIGIN_ROW_H } from "./WindowedTable";
import EmptyMessage from "./EmptyMessage";
import TrainCell from "./TrainCell";
import RunsCell from "./RunsCell";
import HeadCount from "./HeadCount";
import { byClass, classTag, depDayOffset } from "./helpers";
import { ariaSort, nextSort, sortArrow } from "./sorting";
import { depStations } from "../../stationBreakdown";
import type { DepCtx, ModeView, SortKey } from "./types";

export function outDeparturesMode(ctx: DepCtx): ModeView {
  const {
    unit,
    q,
    hasExtraFilters,
    matchesRowFilters,
    selectedTrainCodes,
    handleRowClick,
    onSelectTrain,
    sort,
    setSort,
    emptyProps,
    cur,
    atlas,
  } = ctx;
  let showingNote: string;
  const deps = cur ? cur.deps : [];
  const stations = depStations(deps, ctx.selectedClasses);
  const count = byClass(deps, ctx.selectedClasses, (d) => d.cls).length;
  const tag = classTag(ctx.selectedClasses);
  const list = deps.filter(
    (d) =>
      matchesRowFilters(d.dep, d.distKm, d.dur, d.cls, d.code) &&
      (!q || d.hay.indexOf(q) !== -1),
  );
  const { key, dir } = sort;
  list.sort((a, b) => {
    if (key === "runs") {
      const dd = runRank(atlas?.data.train_table[a.t], atlas?.data.calendar) - runRank(atlas?.data.train_table[b.t], atlas?.data.calendar);
      if (dd) return dd * dir;
    }
    if (key === "dur" || key === "km") {
      const va = key === "dur" ? a.dur : a.km;
      const vb = key === "dur" ? b.dur : b.km;
      if (va < 0 && vb < 0) {
        /* fall through to tie-break */
      } else if (va < 0) return 1;
      else if (vb < 0) return -1;
      else if (va !== vb) return (va < vb ? -1 : 1) * dir;
    } else if (a.dep !== b.dep) {
      return (a.dep < b.dep ? -1 : 1) * dir;
    }
    if (a.dep !== b.dep) return a.dep < b.dep ? -1 : 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });

  if (!cur) showingNote = "";
  else if (hasExtraFilters)
    showingNote =
      "Showing " + list.length + " of " + deps.length + " departures";
  else if (key === "dep")
    showingNote =
      deps.length +
      " departures, " +
      (dir === 1 ? "earliest first" : "latest first");
  else if (key === "km")
    showingNote =
      deps.length +
      " departures, " +
      (dir === 1 ? "shortest distance first" : "longest distance first");
  else
    showingNote =
      deps.length +
      " departures, " +
      (dir === 1 ? "shortest duration first" : "longest duration first");

  const onSort = (k: SortKey) => setSort((s) => nextSort(s, k));
  const arrow = (k: SortKey) => sortArrow(sort, k);
  const ariaOf = (k: SortKey) => ariaSort(sort, k);

  const heading = (
    <>
      {tag ? tag + " departures from" : "Departures from"}{" "}
      <span id="depCityName">
        {cur ? cur.en + " · " + cur.o.zh : "…"}
      </span>{" "}
      {cur ? <HeadCount n={count} total={deps.length} /> : <b className="dep-num-lead">…</b>}
    </>
  );
  const depNote = (
    <>
      Every train departing the selected city &mdash; from any of its
      stations &mdash; for every train in the timetable window.
    </>
  );
  const tableNode = (
    <WindowedTable n={list.length} rowH={ORIGIN_ROW_H} cols={9}>
      {(w) => (
      <>
      <thead>
        <tr>
          <th scope="col">Train</th>
          <th
            scope="col"
            className="sortable"
            data-sort="dep"
            aria-sort={ariaOf("dep")}
            onClick={() => onSort("dep")}
          >
            Departs <span className="arrow">{arrow("dep")}</span>
          </th>
          <th scope="col">From</th>
          <th scope="col">Arrives</th>
          <th scope="col">To</th>
          <th
            scope="col"
            className="sortable"
            data-sort="dur"
            aria-sort={ariaOf("dur")}
            onClick={() => onSort("dur")}
          >
            Duration <span className="arrow">{arrow("dur")}</span>
          </th>
          <th
            scope="col"
            className="num sortable"
            data-sort="km"
            aria-sort={ariaOf("km")}
            onClick={() => onSort("km")}
          >
            Distance <span className="arrow">{arrow("km")}</span>
          </th>
          <th scope="col" className="num">
            Stops
          </th>
          <th
            scope="col"
            className="sortable"
            data-sort="runs"
            aria-sort={ariaOf("runs")}
            onClick={() => onSort("runs")}
          >
            Runs <span className="arrow">{arrow("runs")}</span>
          </th>
        </tr>
      </thead>
      <tbody id="depBody">
        {!cur ? null : list.length === 0 ? (
          <tr>
            <td colSpan={9} className="dep-empty">
              <EmptyMessage {...emptyProps} />
            </td>
          </tr>
        ) : (
          <>{w.top}{list.map((d, i) => i < w.first || i >= w.last ? null : (
            <tr
              key={i}
              {...w.tr(i, selectedTrainCodes.includes(d.code) ? "dep-row-selected" : undefined)}
              onClick={(e) => handleRowClick(d.code, i, e, list)}
            >
              <td className="c-train">
                <TrainCell
                  d={d}
                  onClick={
                    onSelectTrain ? () => onSelectTrain(d.code) : undefined
                  }
                />
              </td>
              <td className="c-time">{d.dep}</td>
              <td>
                {d.fsZh}
                {d.fsEn ? <span className="to-stn">{d.fsEn}</span> : null}
              </td>
              <td className="c-time">
                {d.arr}
                {depDayOffset(d) > 0 ? (
                  <span className="plus"> +{depDayOffset(d)}d</span>
                ) : null}
              </td>
              <td>
                <span className="to-city">
                  {d.tcEn} &middot; {d.tcZh}
                </span>
                <span className="to-stn">
                  {d.tsZh}
                  {d.tsEn ? " · " + d.tsEn : ""}
                </span>
              </td>
              <td className="c-time">{fmtTime(d.dur)}</td>
              <td className="num c-time">{fmtDist(d.km, unit)}</td>
              <td className="num">{d.stops}</td>
              <RunsCell atlas={atlas} t={d.t} />
            </tr>
          ))}{w.bottom}</>
        )}
      </tbody>
      </>
      )}
    </WindowedTable>
  );
  return { heading, depNote, stations, count, total: deps.length, showingNote, tableNode };
}
