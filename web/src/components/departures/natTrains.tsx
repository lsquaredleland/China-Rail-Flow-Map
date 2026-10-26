/* National mode, no city: every national train under the active filters. */
import type { NatRow, NatSortKey } from "../../lib";
import HeadCount from "./HeadCount";
import NatTable from "./NatTable";
import { classTag } from "./helpers";
import { nextSort } from "./sorting";
import type { DepCtx, ModeView, NatData } from "./types";

export function natTrainsMode(ctx: DepCtx, nat: NatData, list: NatRow[]): ModeView {
  const { hasExtraFilters, natSort, setNatSort, onSelectTrain, unit } = ctx;
  const total = nat.rows ? nat.rows.length : 0;
  const { key, dir } = natSort;
  const order: Record<NatSortKey, [string, string]> = {
    code: ["train code A–Z", "train code Z–A"],
    dep: ["earliest first", "latest first"],
    arr: ["earliest arrival first", "latest arrival first"],
    dur: ["shortest duration first", "longest duration first"],
    km: ["shortest distance first", "longest distance first"],
    runs: ["most regular first", "least regular first"],
  };
  const n = total.toLocaleString("en-US");
  const showingNote = !nat.rows
    ? ""
    : hasExtraFilters
      ? "Showing " + list.length.toLocaleString("en-US") + " of " + n + " trains"
      : n + " trains, " + order[key][dir === 1 ? 0 : 1];
  const tag = classTag(ctx.selectedClasses);
  const heading = (
    <>
      {tag ? tag + " trains of " : "All trains of "}
      <span id="depCityName">China Rail</span>{" "}
      <HeadCount n={nat.rows ? (hasExtraFilters ? list.length : total).toLocaleString("en-US") : "…"} total={total} withOf={false} />
    </>
  );
  const depNote = (
    <>
      Every passenger train running at least one day of the schedule window,
      with its first and last stop. Filter by the histograms, the class
      buttons or the search box; click a train for its timetable.
    </>
  );
  const tableNode = (
    <NatTable
      list={list}
      sort={natSort}
      onSort={(k) => setNatSort((s) => nextSort(s, k))}
      unit={unit}
      trainTable={nat.trainTable}
      calendar={nat.calendar}
      loaded={!!nat.rows}
      onSelectTrain={onSelectTrain}
    />
  );
  return { heading, depNote, stations: null, count: total, total, showingNote, tableNode, scrollSelf: true };
}
