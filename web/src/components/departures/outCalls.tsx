/* Outbound with a destination: every train calling at that city. */
import type { DestVM, OriginVM } from "../../types";
import { fmtTime, runRank } from "../../lib";
import HeadCount, { OfTotal } from "./HeadCount";
import WindowedTable, { ORIGIN_ROW_H } from "./WindowedTable";
import TrainCell from "./TrainCell";
import RunsCell from "./RunsCell";
import { byClass, classTag } from "./helpers";
import { ariaSort, nextSort, sortArrow } from "./sorting";
import { callStation, callStations } from "../../stationBreakdown";
import type { DepCtx, ModeView, CallSortKey } from "./types";

export function outCallsMode(ctx: DepCtx, cur: OriginVM, destFilter: DestVM): ModeView {
  const {
    q,
    hasExtraFilters,
    matchesRowFilters,
    selectedTrainCodes,
    handleRowClick,
    onSelectTrain,
    handleClearChip,
    callSort,
    setCallSort,
    atlas,
  } = ctx;
  const calls = destFilter.calls;
  const stations = callStations(
    calls,
    atlas ? atlas.data.station_table : [],
    atlas?.schedules,
    ctx.selectedClasses,
  );
  const classCalls = byClass(calls, ctx.selectedClasses, (c) => c.dep.cls);
  const count = classCalls.length;
  const termCount = classCalls.filter((c) => c.term).length;
  const tag = classTag(ctx.selectedClasses);
  const list = calls.filter((c) => {
    if (
      !matchesRowFilters(
        c.dep.dep,
        c.dep.distKm,
        c.dep.dur,
        c.dep.cls,
        c.dep.code,
      )
    )
      return false;
    if (!q) return true;
    if (c.dep.hay.indexOf(q) !== -1) return true;
    // Searching the selected city's own name keeps every call.
    return (destFilter.en + " " + destFilter.zh).toLowerCase().indexOf(q) !== -1;
  });
  const { key: ck, dir: cdir } = callSort;
  list.sort((a, b) => {
    if (ck === "runs") {
      const dd = runRank(atlas?.data.train_table[a.dep.t], atlas?.data.calendar) - runRank(atlas?.data.train_table[b.dep.t], atlas?.data.calendar);
      if (dd) return dd * cdir;
    }
    if (ck === "dur") {
      const va = a.dur;
      const vb = b.dur;
      if (va < 0 && vb < 0) {
        /* fall through */
      } else if (va < 0) return 1;
      else if (vb < 0) return -1;
      else if (va !== vb) return (va < vb ? -1 : 1) * cdir;
    } else if (ck === "arr") {
      if (a.dayOff !== b.dayOff) return (a.dayOff - b.dayOff) * cdir;
      if (a.arr !== b.arr) return (a.arr < b.arr ? -1 : 1) * cdir;
    } else if (a.dep.dep !== b.dep.dep) {
      return (a.dep.dep < b.dep.dep ? -1 : 1) * cdir;
    }
    if (a.dep.dep !== b.dep.dep) return a.dep.dep < b.dep.dep ? -1 : 1;
    if (a.arr !== b.arr) return a.arr < b.arr ? -1 : 1;
    return a.dep.code < b.dep.code ? -1 : a.dep.code > b.dep.code ? 1 : 0;
  });

  const showingNote = hasExtraFilters
    ? "Showing " +
      list.length +
      " of " +
      calls.length +
      " trains calling at " +
      destFilter.en
    : calls.length +
      " trains, " +
      (ck === "arr"
        ? cdir === 1
          ? "earliest arrival at " + destFilter.en + " first"
          : "latest arrival at " + destFilter.en + " first"
        : ck === "dur"
          ? cdir === 1
            ? "shortest journey to " + destFilter.en + " first"
            : "longest journey to " + destFilter.en + " first"
          : cdir === 1
            ? "earliest departure first"
            : "latest departure first");

  const onCallSort = (k: CallSortKey) => setCallSort((s) => nextSort(s, k));
  const cArrow = (k: CallSortKey) => sortArrow(callSort, k);
  const cAriaSort = (k: CallSortKey) => ariaSort(callSort, k);

  const heading = (
    <>
      <span id="depCityName">
        <HeadCount n={count} total={calls.length} withOf={false} />{tag ? " " + tag : ""} trains call at {destFilter.en} &middot;{" "}
        {destFilter.zh}
        <OfTotal n={count} total={calls.length} />
      </span>{" "}
      <span id="depCount">
        {termCount > 0
          ? termCount + " terminate here"
          : "none terminate here — all intermediate stops"}
      </span>
    </>
  );
  const depNote = (
    <>
      Every train from {cur.en} that stops at {destFilter.en} &mdash;
      whether it ends its journey there or only calls on the way
      through. &ldquo;Arrives&rdquo; and &ldquo;Departs&rdquo; are the
      times at {destFilter.en}&rsquo;s station; &ldquo;Duration&rdquo; is
      the travel time from {cur.en} to {destFilter.en}; &ldquo;Station&rdquo;
      is the {destFilter.en} station the train stops at.
    </>
  );
  const chipNode = (
    <span className="dep-chip" id="depChip">
      Calling at:{" "}
      <b id="depChipName">
        {destFilter.en} &middot; {destFilter.zh}
      </b>
      <button
        id="depChipClear"
        type="button"
        aria-label="Clear destination filter"
        onClick={handleClearChip}
      >
        &times;
      </button>
    </span>
  );
  const tableNode = (
    <WindowedTable n={list.length} rowH={ORIGIN_ROW_H} cols={9} className="calls">
      {(w) => (
      <>
      <thead>
        <tr>
          <th scope="col">Train</th>
          <th
            scope="col"
            className="sortable"
            data-sort="dep"
            aria-sort={cAriaSort("dep")}
            onClick={() => onCallSort("dep")}
          >
            Departs <span className="arrow">{cArrow("dep")}</span>
          </th>
          <th scope="col">From</th>
          <th
            scope="col"
            className="sortable"
            data-sort="dur"
            aria-sort={cAriaSort("dur")}
            onClick={() => onCallSort("dur")}
          >
            Duration <span className="arrow">{cArrow("dur")}</span>
          </th>
          <th
            scope="col"
            className="sortable"
            data-sort="arr"
            aria-sort={cAriaSort("arr")}
            onClick={() => onCallSort("arr")}
          >
            Arrives <span className="arrow">{cArrow("arr")}</span>
          </th>
          <th scope="col">Departs</th>
          <th scope="col">Station</th>
          <th scope="col">Status</th>
          <th
            scope="col"
            className="sortable"
            data-sort="runs"
            aria-sort={cAriaSort("runs")}
            onClick={() => onCallSort("runs")}
          >
            Runs <span className="arrow">{cArrow("runs")}</span>
          </th>
        </tr>
      </thead>
      <tbody id="depBody">
        {list.length === 0 ? (
          <tr>
            <td colSpan={9} className="dep-empty">
              No trains match that filter.
            </td>
          </tr>
        ) : (
          <>{w.top}{list.map((c, i) => {
          if (i < w.first || i >= w.last) return null;
            const d = c.dep;
            const isSelected = selectedTrainCodes.includes(d.code);
            const st = callStation(c, atlas ? atlas.data.station_table : [], atlas?.schedules);
            return (
              <tr
                key={i}
                {...w.tr(i, isSelected ? "dep-row-selected" : undefined)}
                onClick={(e) =>
                  handleRowClick(
                    d.code,
                    i,
                    e,
                    list.map((item) => ({ code: item.dep.code })),
                  )
                }
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
                <td className="c-time">{fmtTime(c.dur)}</td>
                <td className="c-time">
                  {c.arr}
                  {c.dayOff > 0 ? (
                    <span className="plus"> +{c.dayOff}d</span>
                  ) : null}
                </td>
                <td className="c-time">{c.term ? "—" : c.depAt}</td>
                <td>
                  {st ? st.zh : null}
                  {st && st.en ? <span className="to-stn">{st.en}</span> : null}
                </td>
                <td>
                  <span
                    className={
                      "status-chip " + (c.term ? "status-term" : "status-mid")
                    }
                  >
                    {c.term ? "Terminates here" : "Intermediate stop"}
                  </span>
                </td>
                <RunsCell atlas={atlas} t={d.t} />
              </tr>
            );
          })}{w.bottom}</>
        )}
      </tbody>
      </>
      )}
    </WindowedTable>
  );
  return { heading, depNote, stations, chipNode, count, total: calls.length, showingNote, tableNode };
}
