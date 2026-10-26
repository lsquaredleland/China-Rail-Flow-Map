import { useMemo } from "react";
import type { DecodedAtlas, NationalIndexPack, SchedulesData } from "../types";
import { FLOW_CLASSES, buildNatRows, classIndex, natHistRows, natSelect } from "../lib";
import type { NatFilter } from "../lib";
import type { NatData } from "../components/departures/natTrains";

/** National mode's rows for the shared departures section: every train read
    off the schedules, the same trains as histogram rows, and the selection the
    filters make by lookup in the index. undefined outside national mode. */
export function useNationalTable(
  national: boolean,
  atlas: DecodedAtlas | null,
  schedules: SchedulesData | null,
  index: NationalIndexPack | null,
  filter: NatFilter,
): NatData | undefined {
  const trainTable = atlas?.data.train_table;
  const stationTable = atlas?.data.station_table;
  const calendar = atlas?.data.calendar;
  const rows = useMemo(
    () =>
      national && trainTable && stationTable && schedules
        ? buildNatRows(trainTable, stationTable, schedules, calendar)
        : null,
    [national, trainTable, stationTable, schedules, calendar],
  );
  const histRows = useMemo(() => (rows ? natHistRows(rows, index, filter.unit) : []), [rows, index, filter.unit]);
  const sel = useMemo(
    () => (national && trainTable ? natSelect(trainTable, index, filter) : null),
    [national, trainTable, index, filter],
  );
  const classCounts = useMemo(() => {
    const out: Record<string, number> = {};
    if (rows) for (const r of rows) out[FLOW_CLASSES[classIndex(r.cls)]] = (out[FLOW_CLASSES[classIndex(r.cls)]] || 0) + 1;
    return out;
  }, [rows]);
  return useMemo(
    () => (national && trainTable ? { rows, histRows, sel, trainTable, calendar, classCounts } : undefined),
    [national, rows, histRows, sel, trainTable, calendar, classCounts],
  );
}
