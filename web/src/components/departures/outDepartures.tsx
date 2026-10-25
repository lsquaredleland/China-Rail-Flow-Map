/* Outbound, no destination: every train departing the origin city. */
import { fmtDist, fmtTime } from "../../lib";
import EmptyMessage from "./EmptyMessage";
import TrainCell from "./TrainCell";
import { depDayOffset } from "./helpers";
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
  } = ctx;
  let showingNote: string;
  const deps = cur ? cur.deps : [];
  const stations = depStations(deps);
  const list = deps.filter(
    (d) =>
      matchesRowFilters(d.dep, d.distKm, d.dur, d.cls, d.code) &&
      (!q || d.hay.indexOf(q) !== -1),
  );
  const { key, dir } = sort;
  list.sort((a, b) => {
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
      Departures from{" "}
      <span id="depCityName">
        {cur ? cur.en + " · " + cur.o.zh : "…"}
      </span>{" "}
      <b className="dep-num-lead">{cur ? cur.deps.length : "…"}</b>
    </>
  );
  const depNote = (
    <>
      Every train departing the selected city &mdash; from any of its
      stations &mdash; across the two timetable dates &mdash; Wednesday 21
      October 2026 (national) and Wednesday 28 October 2026 (intercity
      C/S). &ldquo;Stops&rdquo; counts the stops the train makes after leaving
      its origin-city station.
    </>
  );
  const tableNode = (
    <table id="depTable">
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
          <th scope="col">To</th>
          <th scope="col">Arrives</th>
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
        </tr>
      </thead>
      <tbody id="depBody">
        {!cur ? null : list.length === 0 ? (
          <tr>
            <td colSpan={8} className="dep-empty">
              <EmptyMessage {...emptyProps} />
            </td>
          </tr>
        ) : (
          list.map((d, i) => (
            <tr
              key={i}
              className={
                selectedTrainCodes.includes(d.code)
                  ? "dep-row-selected"
                  : undefined
              }
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
              <td>
                <span className="to-city">
                  {d.tcEn} &middot; {d.tcZh}
                </span>
                <span className="to-stn">
                  {d.tsZh}
                  {d.tsEn ? " · " + d.tsEn : ""}
                </span>
              </td>
              <td className="c-time">
                {d.arr}
                {depDayOffset(d) > 0 ? (
                  <span className="plus"> +{depDayOffset(d)}d</span>
                ) : null}
              </td>
              <td className="c-time">{fmtTime(d.dur)}</td>
              <td className="num c-time">{fmtDist(d.km, unit)}</td>
              <td className="num">{d.stops}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
  return { heading, depNote, stations, showingNote, tableNode };
}
