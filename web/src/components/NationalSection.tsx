import { useMemo } from "react";
import type { DistBinFilter, DistUnit, DurBinFilter, NationalIndexPack, RawStation, SchedulesData, RawTrain } from "../types";
import { buildNatRows, natSelect } from "../lib";
import type { NatFilter } from "../lib";
import NationalFilters from "./NationalFilters";
import NationalTable from "./NationalTable";

/* National mode's section below the map, where the origin view has its
   departures: the hour / distance / duration histograms and the train-code
   box, then the table of every train the filters leave. */
export default function NationalSection({
  index,
  indexFailed,
  trainTable,
  stationTable,
  calendar,
  schedules,
  filter,
  unit,
  onHours,
  onDistBins,
  onDurBins,
  onTrainCodes,
  onSelectTrain,
}: {
  index: NationalIndexPack | null;
  indexFailed: boolean;
  trainTable: readonly RawTrain[];
  stationTable: readonly RawStation[];
  calendar?: readonly string[];
  schedules: SchedulesData | null;
  filter: NatFilter;
  unit: DistUnit;
  onHours: (h: number[]) => void;
  onDistBins: (b: DistBinFilter[]) => void;
  onDurBins: (b: DurBinFilter[]) => void;
  onTrainCodes: (c: string[]) => void;
  onSelectTrain: (code: string) => void;
}) {
  const rows = useMemo(
    () => (schedules ? buildNatRows(trainTable, stationTable, schedules, calendar) : null),
    [trainTable, stationTable, schedules, calendar],
  );
  const sel = useMemo(() => natSelect(trainTable, index, filter), [trainTable, index, filter]);
  return (
    <section id="departures">
      <h2>All trains of China Rail</h2>
      <NationalFilters
        index={index}
        failed={indexFailed}
        trainTable={trainTable}
        filter={filter}
        unit={unit}
        onHours={onHours}
        onDistBins={onDistBins}
        onDurBins={onDurBins}
        onTrainCodes={onTrainCodes}
      />
      <NationalTable
        rows={rows}
        sel={sel}
        unit={unit}
        trainTable={trainTable}
        calendar={calendar}
        onSelectTrain={onSelectTrain}
      />
    </section>
  );
}
