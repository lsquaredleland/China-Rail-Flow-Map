import { useEffect, useMemo, useState } from "react";
import type { DecodedAtlas, NatLayers } from "../types";
import { initialNatFlows, writeNatFlowsParam } from "./useUrlState";

export interface NationalModeInput {
  national: boolean;
  atlas: DecodedAtlas | null;
  selectedTrainCode: string | null;
  isolatedTrainCode: string | null;
  /** The animation bar is collapsed; national mode draws its trains only while it is open. */
  isTimelineCollapsed: boolean;
  nationalFlowsFailed: boolean;
  nationalTrainsFailed: boolean;
  ensureNationalTrains: () => void;
  ensureNationalFlows: () => void;
  ensureNationalEntries: () => void;
  ensureNationalIndex: () => void;
  ensureSchedules: () => void;
}

/** National mode's own state and loading (D11 / D13): the Flows toggle, what the map draws,
    the clicked city circle, the train behind a selected dot, load errors, and the effects
    that fetch the national files only when the mode asks for them. */
export function useNationalMode(i: NationalModeInput) {
  const { national, atlas, selectedTrainCode, isolatedTrainCode } = i;
  // National flows (with the city circles): a map toggle, on by default
  // (?natLayer=none starts with them off).
  const [natFlowsOn, setNatFlowsOn] = useState<boolean>(initialNatFlows);
  // The animation is the origin view's: its bar is open while it plays.
  const natTrainsOn = national && !i.isTimelineCollapsed;

  // The clicked city circle, shown as the collapsed city card.
  const [natCity, setNatCity] = useState<{ idx: number; dep: number; arr: number } | null>(null);
  useEffect(() => {
    if (!national) setNatCity(null);
  }, [national]);
  const natCityRow = natCity && atlas ? atlas.data.city_table[natCity.idx] : null;

  // The dot's train is not in the origin's departures, so the schedule key is
  // found by code in the shared train table (codes are unique).
  const nationalTrainT = useMemo(() => {
    if (!national || !selectedTrainCode || !atlas) return null;
    const t = atlas.data.train_table.findIndex((r) => r.code === selectedTrainCode);
    return t >= 0 ? t : null;
  }, [national, selectedTrainCode, atlas]);

  const { ensureNationalTrains, ensureNationalFlows, ensureNationalEntries, ensureNationalIndex, ensureSchedules } = i;
  // The trains file loads only when the animation is turned on (never in the
  // origin view); it also gives an isolated train its path.
  useEffect(() => {
    if (national && (natTrainsOn || isolatedTrainCode)) ensureNationalTrains();
  }, [national, natTrainsOn, isolatedTrainCode, ensureNationalTrains]);
  // The per-train index (hour / distance / duration / code filters): national mode only.
  useEffect(() => {
    if (national) ensureNationalIndex();
  }, [national, ensureNationalIndex]);
  // The national table is timed by the schedules asset.
  useEffect(() => {
    if (national) ensureSchedules();
  }, [national, ensureSchedules]);
  // The flows files load only when national mode asks to draw them: the
  // day's totals for Flows, the entry ticks too when the animation is on
  // (the flows then build up with the clock).
  useEffect(() => {
    if (!national || !natFlowsOn) return;
    ensureNationalFlows();
    if (natTrainsOn) ensureNationalEntries();
  }, [national, natFlowsOn, natTrainsOn, ensureNationalFlows, ensureNationalEntries]);

  const toggleNatFlows = () => {
    setNatFlowsOn(!natFlowsOn);
    writeNatFlowsParam(!natFlowsOn);
  };
  // What the map draws; a flows file that failed leaves the trains drawn.
  const flowsDrawn = natFlowsOn && !i.nationalFlowsFailed;
  const natLayersDrawn: NatLayers = useMemo(() => ({ flows: flowsDrawn, trains: natTrainsOn }), [flowsDrawn, natTrainsOn]);
  // A load failure is reported where the origin view reports one.
  const natLoadError = !national
    ? null
    : i.nationalFlowsFailed && natFlowsOn
      ? "The national flow data could not be loaded."
      : i.nationalTrainsFailed && natTrainsOn
        ? "The national train data could not be loaded."
        : null;

  return { natFlowsOn, toggleNatFlows, natLayersDrawn, natCity, setNatCity, natCityRow, nationalTrainT, natLoadError };
}
