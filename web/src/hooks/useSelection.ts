import { useCallback, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import type {
  CityPointVM,
  DestVM,
  Direction,
  DistBinFilter,
  DistUnit,
  DurBinFilter,
  OriginVM,
  SrcVM,
} from "../types";
import { FLOW_CLASSES, classIndex, filterOrigin } from "../lib";
import type { MapApi } from "../components/MapCanvas";

/* Selection state: the selected / isolated train, the class + histogram
   filters, and the pinned city panel. */

export function useTrainSelection() {
  const [selectedTrainCode, setSelectedTrainCode] = useState<string | null>(null);
  const [isolatedTrainCode, setIsolatedTrainCode] = useState<string | null>(null);
  return {
    selectedTrainCode,
    setSelectedTrainCode,
    isolatedTrainCode,
    setIsolatedTrainCode,
  };
}

/* Class and histogram filters. The single-value (`selectedHour`, ...) and
   multi-value (`selectedHours`, ...) forms coexist because the histograms
   and the table drive them separately; `hours` / `distBins` / `durBins`
   are the effective lists the map and filter bar read. */
export function useFilters(cur: OriginVM | null, distUnit: DistUnit) {
  const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [selectedHours, setSelectedHours] = useState<number[]>([]);
  const [selectedDistBin, setSelectedDistBin] =
    useState<DistBinFilter | null>(null);
  const [selectedDistBins, setSelectedDistBins] = useState<DistBinFilter[]>([]);
  const [selectedDurBin, setSelectedDurBin] = useState<DurBinFilter | null>(
    null,
  );
  const [selectedDurBins, setSelectedDurBins] = useState<DurBinFilter[]>([]);
  const [selectedTrainCodes, setSelectedTrainCodes] = useState<string[]>([]);

  const hours = useMemo(
    () =>
      selectedHours.length > 0
        ? selectedHours
        : selectedHour !== null
          ? [selectedHour]
          : [],
    [selectedHours, selectedHour],
  );
  const distBins = useMemo(
    () =>
      selectedDistBins.length > 0
        ? selectedDistBins
        : selectedDistBin
          ? [selectedDistBin]
          : [],
    [selectedDistBins, selectedDistBin],
  );
  const durBins = useMemo(
    () =>
      selectedDurBins.length > 0
        ? selectedDurBins
        : selectedDurBin
          ? [selectedDurBin]
          : [],
    [selectedDurBins, selectedDurBin],
  );

  const viewCur: OriginVM | null = useMemo(
    () =>
      cur
        ? filterOrigin(cur, {
            classes: selectedClasses,
            hours,
            distBins,
            durBins,
            trainCodes: selectedTrainCodes,
            unit: distUnit,
          })
        : null,
    [cur, selectedClasses, hours, distBins, durBins, selectedTrainCodes, distUnit],
  );

  const clearFilters = () => {
    setSelectedClasses([]);
    setSelectedHour(null);
    setSelectedHours([]);
    setSelectedDistBin(null);
    setSelectedDistBins([]);
    setSelectedDurBin(null);
    setSelectedDurBins([]);
    setSelectedTrainCodes([]);
  };

  const toggleClass = (cls: string) => {
    setSelectedClasses((prev) =>
      prev.includes(cls) ? prev.filter((c) => c !== cls) : [...prev, cls],
    );
  };

  const hasHistFilter =
    selectedHour !== null ||
    selectedHours.length > 0 ||
    selectedDistBin !== null ||
    selectedDistBins.length > 0 ||
    selectedDurBin !== null ||
    selectedDurBins.length > 0 ||
    selectedTrainCodes.length > 0;

  return {
    selectedClasses,
    setSelectedClasses,
    selectedHour,
    setSelectedHour,
    selectedHours,
    setSelectedHours,
    selectedDistBin,
    setSelectedDistBin,
    selectedDistBins,
    setSelectedDistBins,
    selectedDurBin,
    setSelectedDurBin,
    selectedDurBins,
    setSelectedDurBins,
    selectedTrainCodes,
    setSelectedTrainCodes,
    hours,
    distBins,
    durBins,
    viewCur,
    clearFilters,
    toggleClass,
    hasHistFilter,
  };
}

/* The pinned city panel (destinations outbound, sources inbound). Pinning
   a city also filters the table below the map to it; the filter lives
   exactly as long as the panel does. Also derives which train classes the
   current origin / pinned city actually has. */
export function useCityPanel({
  cur,
  viewCur,
  direction,
  outTablesReady,
  inTablesReady,
  setSelectedClasses,
  mapRef,
  national = false,
}: {
  cur: OriginVM | null;
  viewCur: OriginVM | null;
  direction: Direction;
  outTablesReady: boolean;
  inTablesReady: boolean;
  setSelectedClasses: (f: (prev: string[]) => string[]) => void;
  mapRef: RefObject<MapApi | null>;
  national?: boolean;
}) {
  const [panelCity, setPanelCity] = useState<CityPointVM | null>(null);

  const availableClasses: Set<string> = useMemo(() => {
    // National mode: the filter drives the national flows, which carry every
    // class; leaving it drops what the origin does not have (effect below).
    if (!cur || national) return new Set(FLOW_CLASSES);

    const originClasses = new Set<string>();
    const flows = direction === "out" ? cur.flows : cur.inFlows;
    for (const f of flows) {
      for (let i = 0; i < FLOW_CLASSES.length; i++) {
        if (f.byClass[i] > 0) originClasses.add(FLOW_CLASSES[i]);
      }
    }
    if (direction === "out" && outTablesReady && cur.deps) {
      for (const d of cur.deps) {
        originClasses.add(FLOW_CLASSES[classIndex(d.cls)]);
      }
    } else if (direction === "in" && inTablesReady && cur.arrs) {
      for (const a of cur.arrs) {
        originClasses.add(FLOW_CLASSES[classIndex(a.cls)]);
      }
    }

    if (panelCity) {
      const baseList: CityPointVM[] =
        direction === "out" ? cur.dests : cur.srcs;
      const baseCity = baseList.find((c) => c.idx === panelCity.idx);
      if (direction === "out" && outTablesReady && baseCity) {
        const set = new Set<string>();
        for (const c of (baseCity as DestVM).calls) {
          if (c.dep) set.add(FLOW_CLASSES[classIndex(c.dep.cls)]);
        }
        return set;
      } else if (direction === "in" && inTablesReady && baseCity) {
        const set = new Set<string>();
        for (const c of (baseCity as SrcVM).inCalls) {
          if (c.arr) set.add(FLOW_CLASSES[classIndex(c.arr.cls)]);
        }
        return set;
      }
      return originClasses;
    }

    return originClasses;
  }, [cur, direction, panelCity, outTablesReady, inTablesReady, national]);

  // A class that the new origin / city does not have drops out of the filter.
  useEffect(() => {
    setSelectedClasses((prev) => {
      const next = prev.filter((c) => availableClasses.has(c));
      return next.length === prev.length ? prev : next;
    });
  }, [availableClasses, setSelectedClasses]);

  /* ---------- pinned city follows view-model rebuilds ---------- */
  // Pinning a city keeps that city's view-model object; when a staged
  // merge or class filter rebuilds the current origin, re-point the pin
  // at the fresh object for the same city.
  useEffect(() => {
    if (!viewCur || !panelCity) return;
    const list: CityPointVM[] =
      direction === "out" ? viewCur.dests : viewCur.srcs;
    const fresh = list.find((c) => c.idx === panelCity.idx);
    if (fresh) {
      if (fresh !== panelCity) setPanelCity(fresh);
    } else if (cur && panelCity.trains !== 0) {
      const baseList: CityPointVM[] =
        direction === "out" ? cur.dests : cur.srcs;
      const base = baseList.find((c) => c.idx === panelCity.idx);
      if (base) {
        setPanelCity(
          direction === "out"
            ? ({
                ...(base as DestVM),
                trains: 0,
                fast: 0,
                endpoint: 0,
                terminating: 0,
                calls: [],
              } as CityPointVM)
            : ({
                ...(base as SrcVM),
                trains: 0,
                fast: 0,
                endpoint: 0,
                originating: 0,
                inCalls: [],
              } as CityPointVM),
        );
      }
    }
  }, [viewCur, cur, panelCity, direction]);

  const closePanel = useCallback(() => {
    setPanelCity(null);
    if (mapRef.current) mapRef.current.clearStationHover();
  }, [mapRef]);

  // Esc dismisses the city panel (and its table filter).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && panelCity) closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelCity, closePanel]);

  return { panelCity, setPanelCity, availableClasses, closePanel };
}
