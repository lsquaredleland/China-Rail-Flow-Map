/* Inbound with a source: every train arriving from that city. */
import type { OriginVM, SrcVM } from "../../types";
import { fmtTime, runRank } from "../../lib";
import HeadCount, { OfTotal } from "./HeadCount";
import WindowedTable, { ORIGIN_ROW_H } from "./WindowedTable";
import TrainCell from "./TrainCell";
import RunsCell from "./RunsCell";
import { byClass, classTag } from "./helpers";
import { ariaSort, nextSort, sortArrow } from "./sorting";
import { inCallStations } from "../../stationBreakdown";
import type { DepCtx, ModeView, InCallSortKey } from "./types";

export function inCallsMode(ctx: DepCtx, cur: OriginVM, srcFilter: SrcVM): ModeView {
  const {
    q,
    hasExtraFilters,
    matchesRowFilters,
    selectedTrainCodes,
    handleRowClick,
    onSelectTrain,
    handleClearChip,
    inCallSort,
    setInCallSort,
    atlas,
  } = ctx;
  const calls = srcFilter.inCalls;
  const stations = inCallStations(calls, ctx.selectedClasses);
  const classCalls = byClass(calls, ctx.selectedClasses, (c) => c.arr.cls);
  const count = classCalls.length;
  const originating = classCalls.filter((c) => c.started).length;
  const tag = classTag(ctx.selectedClasses);
  const list = calls.filter((c) => {
    if (
      !matchesRowFilters(
        c.arr.arr,
        c.arr.distKm,
        c.arr.dur,
        c.arr.cls,
        c.arr.code,
      )
    )
      return false;
    if (!q) return true;
    if (c.arr.hay.indexOf(q) !== -1) return true;
    if ((c.bsZh + " " + c.bsEn).toLowerCase().indexOf(q) !== -1)
      return true;
    // Searching the selected source's own name keeps every call.
    return (srcFilter.en + " " + srcFilter.zh).toLowerCase().indexOf(q) !== -1;
  });
  const { key: ik, dir: idir } = inCallSort;
  list.sort((a, b) => {
    if (ik === "runs") {
      const dd = runRank(atlas?.data.train_table[a.arr.t], atlas?.data.calendar) - runRank(atlas?.data.train_table[b.arr.t], atlas?.data.calendar);
      if (dd) return dd * idir;
    }
    if (ik === "dur") {
      const va = a.dur;
      const vb = b.dur;
      if (va < 0 && vb < 0) {
        /* fall through */
      } else if (va < 0) return 1;
      else if (vb < 0) return -1;
      else if (va !== vb) return (va < vb ? -1 : 1) * idir;
    } else if (ik === "arr") {
      if (a.dayOff !== b.dayOff) return (a.dayOff - b.dayOff) * idir;
      if (a.arrTime !== b.arrTime)
        return (a.arrTime < b.arrTime ? -1 : 1) * idir;
    } else if (a.board !== b.board) {
      return (a.board < b.board ? -1 : 1) * idir;
    }
    if (a.board !== b.board) return a.board < b.board ? -1 : 1;
    if (a.arrTime !== b.arrTime) return a.arrTime < b.arrTime ? -1 : 1;
    return a.arr.code < b.arr.code ? -1 : a.arr.code > b.arr.code ? 1 : 0;
  });

  const showingNote = hasExtraFilters
    ? "Showing " +
      list.length +
      " of " +
      calls.length +
      " trains arriving from " +
      srcFilter.en
    : calls.length +
      " trains, " +
      (ik === "arr"
        ? idir === 1
          ? "earliest arrival in " + cur.en + " first"
          : "latest arrival in " + cur.en + " first"
        : ik === "dur"
          ? idir === 1
            ? "shortest journey from " + srcFilter.en + " first"
            : "longest journey from " + srcFilter.en + " first"
          : idir === 1
            ? "earliest departure from " + srcFilter.en + " first"
            : "latest departure from " + srcFilter.en + " first");

  const onInCallSort = (k: InCallSortKey) => setInCallSort((s) => nextSort(s, k));
  const iArrow = (k: InCallSortKey) => sortArrow(inCallSort, k);
  const iAriaSort = (k: InCallSortKey) => ariaSort(inCallSort, k);

  const heading = (
    <>
      <span id="depCityName">
        <HeadCount n={count} total={calls.length} withOf={false} />{tag ? " " + tag : ""} trains arrive from {srcFilter.en} &middot;{" "}
        {srcFilter.zh}
        <OfTotal n={count} total={calls.length} />
      </span>{" "}
      &mdash;{" "}
      <span id="depCount">
        {originating > 0
          ? originating + " start there"
          : "none start there"}
      </span>
    </>
  );
  const depNote = (
    <>
      Every train from {srcFilter.en} that arrives in {cur.en} &mdash;
      whether it starts in {srcFilter.en} or only calls there on the
      way in. &ldquo;Departs {srcFilter.en}&rdquo; is the boarding time
      at {srcFilter.en}&rsquo;s station; &ldquo;Duration&rdquo; is the
      travel time from {srcFilter.en} to {cur.en}; &ldquo;Origin&rdquo; is
      where the train truly starts.
    </>
  );
  const chipNode = (
    <span className="dep-chip" id="depChip">
      Arriving from:{" "}
      <b id="depChipName">
        {srcFilter.en} &middot; {srcFilter.zh}
      </b>
      <button
        id="depChipClear"
        type="button"
        aria-label="Clear source filter"
        onClick={handleClearChip}
      >
        &times;
      </button>
    </span>
  );
  const tableNode = (
    <WindowedTable n={list.length} rowH={ORIGIN_ROW_H} cols={7} className="calls">
      {(w) => (
      <>
      <thead>
        <tr>
          <th scope="col">Train</th>
          <th
            scope="col"
            className="sortable"
            data-sort="board"
            aria-sort={iAriaSort("board")}
            onClick={() => onInCallSort("board")}
          >
            Departs {srcFilter.en}{" "}
            <span className="arrow">{iArrow("board")}</span>
          </th>
          <th
            scope="col"
            className="sortable"
            data-sort="arr"
            aria-sort={iAriaSort("arr")}
            onClick={() => onInCallSort("arr")}
          >
            Arrives {cur.en}{" "}
            <span className="arrow">{iArrow("arr")}</span>
          </th>
          <th
            scope="col"
            className="sortable"
            data-sort="dur"
            aria-sort={iAriaSort("dur")}
            onClick={() => onInCallSort("dur")}
          >
            Duration <span className="arrow">{iArrow("dur")}</span>
          </th>
          <th scope="col">Origin</th>
          <th scope="col">Status</th>
          <th
            scope="col"
            className="sortable"
            data-sort="runs"
            aria-sort={iAriaSort("runs")}
            onClick={() => onInCallSort("runs")}
          >
            Runs <span className="arrow">{iArrow("runs")}</span>
          </th>
        </tr>
      </thead>
      <tbody id="depBody">
        {list.length === 0 ? (
          <tr>
            <td colSpan={7} className="dep-empty">
              No trains match that filter.
            </td>
          </tr>
        ) : (
          <>{w.top}{list.map((c, i) => {
          if (i < w.first || i >= w.last) return null;
            const a = c.arr;
            const isSelected = selectedTrainCodes.includes(a.code);
            return (
              <tr
                key={i}
                {...w.tr(i, isSelected ? "dep-row-selected" : undefined)}
                onClick={(e) =>
                  handleRowClick(
                    a.code,
                    i,
                    e,
                    list.map((item) => ({ code: item.arr.code })),
                  )
                }
              >
                <td className="c-train">
                  <TrainCell
                    d={a}
                    onClick={
                      onSelectTrain ? () => onSelectTrain(a.code) : undefined
                    }
                  />
                </td>
                <td className="c-time">
                  {c.board}
                  <span className="to-stn">
                    {c.bsZh}
                    {c.bsEn ? " · " + c.bsEn : ""}
                  </span>
                </td>
                <td className="c-time">
                  {c.arrTime}
                  {c.dayOff > 0 ? (
                    <span className="plus"> +{c.dayOff}d</span>
                  ) : null}
                </td>
                <td className="c-time">{fmtTime(c.dur)}</td>
                <td>
                  <span className="to-city">
                    {a.fcEn} &middot; {a.fcZh}
                  </span>
                  <span className="to-stn">
                    {a.fsZh}
                    {a.fsEn ? " · " + a.fsEn : ""}
                  </span>
                </td>
                <td>
                  <span
                    className={
                      "status-chip " +
                      (c.started ? "status-term" : "status-mid")
                    }
                  >
                    {c.started ? "Originates here" : "Through train"}
                  </span>
                </td>
                <RunsCell atlas={atlas} t={a.t} />
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
