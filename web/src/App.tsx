import { useEffect, useMemo, useRef, useState } from "react";
import type { DecodedAtlas, Direction, DistUnit, OriginVM } from "./types";
import { buildOrigin, natCityCounts, natFlowCounts, stationName } from "./lib";
import type { NatFilter } from "./lib";
import { useAtlasData } from "./hooks/useAtlasData";
import {
  initialNational,
  usePrefs,
  useUrlSync,
  writeNationalParam,
} from "./hooks/useUrlState";
import { clearOriginSelection, useFilters, useCityPanel, useTrainSelection } from "./hooks/useSelection";
import { useAnimationClock } from "./hooks/useAnimationClock";
import { useNationalMode } from "./hooks/useNationalMode";
import MapHost, { type MapApi } from "./components/MapHost";
import Legend, { type LegendHandle } from "./components/Legend";
import DestinationPanel from "./components/DestinationPanel";
import DeparturesTable from "./components/DeparturesTable";
import Footnote from "./components/Footnote";
import TimelineScrubber from "./components/TimelineScrubber";
import TrainScheduleModal from "./components/TrainScheduleModal";
import AppHeader, { compactStats } from "./components/AppHeader";
import Toolbar from "./components/Toolbar";
import ActiveFilterBar from "./components/ActiveFilterBar";
import { MapCardSlot, cardBand } from "./components/MapCards";
import { IsolationChip, TimelineExpandButton } from "./components/MapOverlays";
import type { CityPointVM } from "./types";
import { useNationalTable } from "./hooks/useNationalTable";

export default function App() {
  const atlasRef = useRef<DecodedAtlas | null>(null);
  const mapRef = useRef<MapApi | null>(null);
  const legendRef = useRef<LegendHandle | null>(null);
  const [originIdx, setOriginIdx] = useState(-1);
  const [showOutline, setShowOutline] = useState(true);
  const [showNetwork, setShowNetwork] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [showTimeline] = useState<boolean>(true);
  // National mode (D11 / D13): every national train on one 24h clock, map-only.
  const [national, setNational] = useState<boolean>(initialNational);

  const prefs = usePrefs();
  const { showInfra, distUnit, direction, dark, setDark, toggleInfra } = prefs;
  const { selectedTrainCode, setSelectedTrainCode, isolatedTrainCode, setIsolatedTrainCode } =
    useTrainSelection();
  // Each click on a train opens a fresh timetable (expanded), even the same
  // train or one picked while another's card was minimised: the key remounts it.
  const [trainOpenSeq, setTrainOpenSeq] = useState(0);
  const toggleIsolate = (c: string) => setIsolatedTrainCode((prev) => (prev === c ? null : c));
  const openTrain = (code: string | null) => {
    setSelectedTrainCode(code);
    if (code) setTrainOpenSeq((n) => n + 1);
  };

  const { initialCamera, syncUrl, handleViewChange } = useUrlSync({
    atlasRef,
    mapRef,
    originIdx,
    onCityFromUrl: (idx) => {
      setPanelCity(null);
      setOriginIdx(idx);
    },
  });

  const {
    atlas,
    outline,
    loadError,
    outTablesReady,
    inMapReady,
    inTablesReady,
    inMapLoading,
    schedulesData,
    ensureOutTables,
    ensureInMap,
    nationalTrains,
    nationalTrainsFailed,
    ensureNationalTrains,
    nationalFlows,
    nationalEntries,
    nationalFlowsFailed,
    nationalIndex,
    nationalIndexFailed,
    ensureNationalIndex,
    ensureSchedules,
    ensureNationalFlows,
    ensureNationalEntries,
  } = useAtlasData({
    atlasRef,
    selectedTrainCode,
    onReady: (def) => {
      setOriginIdx(def);
      syncUrl(def, initialCamera);
    },
  });

  const cur: OriginVM | null = useMemo(
    () => (atlas && originIdx >= 0 ? buildOrigin(atlas, originIdx) : null),
    // The ready flags flip as each staged file merges in (in place), so they
    // are rebuild triggers, not inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [atlas, originIdx, outTablesReady, inMapReady, inTablesReady],
  );

  const filters = useFilters(cur, distUnit);
  const { viewCur, selectedClasses, setSelectedClasses, clearFilters } = filters;
  // National mode's filters: class plus the index-answered ones.
  const { hours, distBins, durBins, selectedTrainCodes } = filters;
  const natFilter: NatFilter = useMemo(
    () => ({ classes: selectedClasses, hours, distBins, durBins, trainCodes: selectedTrainCodes, unit: distUnit }),
    [selectedClasses, hours, distBins, durBins, selectedTrainCodes, distUnit],
  );

  const natData = useNationalTable(national, atlas, schedulesData, nationalIndex, natFilter);

  const selectedTrainVM = useMemo(() => {
    if (!selectedTrainCode || !cur || national) return null;
    const list = direction === "out" ? cur.deps : cur.arrs;
    return list.find((t) => t.code === selectedTrainCode) || null;
  }, [selectedTrainCode, cur, direction, national]);

  // The isolated train's card text (its route and fastest-time band colour).
  const isolatedVM = useMemo(
    () => (isolatedTrainCode && cur ? cur.deps.find((t) => t.code === isolatedTrainCode) ?? null : null),
    [isolatedTrainCode, cur],
  );
  const isolatedRoute = isolatedVM
    ? `${stationName(isolatedVM.fsZh, isolatedVM.fsEn, "zh-en")} → ${stationName(isolatedVM.tsZh, isolatedVM.tsEn, "zh-en")}`
    : "";
  const isolatedBand = cardBand(isolatedVM ? isolatedVM.dur : 0, dark);

  const { panelCity, setPanelCity, availableClasses, closePanel } = useCityPanel({
    cur,
    viewCur,
    direction,
    outTablesReady,
    inTablesReady,
    setSelectedClasses,
    mapRef,
    national,
  });

  const { isTimelineCollapsed, expandTimeline, collapseTimeline, playFrom } =
    useAnimationClock(mapRef, direction, national);
  const {
    natFlowsOn,
    toggleNatFlows,
    natLayersDrawn,
    natCity,
    setNatCity,
    natCityRow,
    nationalTrainT,
    natLoadError,
    retryNatLoad,
  } = useNationalMode({
    national,
    atlas,
    selectedTrainCode,
    isolatedTrainCode,
    isTimelineCollapsed,
    nationalFlowsFailed,
    nationalTrainsFailed,
    nationalIndexFailed,
    ensureNationalTrains,
    ensureNationalFlows,
    ensureNationalEntries,
    ensureNationalIndex,
    ensureSchedules,
  });
  // National numbers under every active filter: per-city departures / arrivals,
  // trains per section, and the header's three stats.
  const natSel = natData?.sel ?? null;
  const natCityLive = useMemo(
    () => (national && nationalFlows ? natCityCounts(nationalFlows, nationalIndex, natFilter, natSel) : null),
    [national, nationalFlows, nationalIndex, natFilter, natSel],
  );
  const natStats = useMemo(() => {
    if (!national || !nationalFlows) return null;
    let trains = atlas ? atlas.data.train_table.length : 0;
    if (natSel) {
      trains = 0;
      for (let t = 0; t < natSel.length; t++) trains += natSel[t];
    }
    let cities = 0;
    if (natCityLive) for (let i = 0; i < natCityLive.dep.length; i++) if (natCityLive.dep[i] + natCityLive.arr[i] > 0) cities++;
    const flows = natFlowCounts(nationalFlows, nationalIndex, natFilter, natSel);
    let maxFlow = 0;
    for (let i = 0; i < flows.length; i++) if (flows[i] > maxFlow) maxFlow = flows[i];
    return { trains, cities: nationalFlows.cities ? cities : null, maxFlow };
  }, [national, nationalFlows, nationalIndex, natFilter, natSel, natCityLive, atlas]);
  // The national city card: the same panel as the origin view's, with its own rows.
  const natCityNow = (() => {
    if (!natCity || !natCityLive) return natCity;
    const i = natCityLive.idx.indexOf(natCity.idx);
    return i < 0 ? { ...natCity, dep: 0, arr: 0 } : { idx: natCity.idx, dep: natCityLive.dep[i], arr: natCityLive.arr[i] };
  })();
  const natPoint = natCityNow && natCityRow ? { idx: natCityNow.idx, zh: natCityRow.zh, en: natCityRow.en, trains: 0 } : null;
  const natRows: [string, string][] | undefined = natCityNow
    ? [["Departures", String(natCityNow.dep)], ["Arrivals", String(natCityNow.arr)]]
    : undefined;
  const natSub = natCityNow ? `${natCityNow.dep} departures · ${natCityNow.arr} arrivals` : undefined;
  // The isolated train belongs to the outbound animation.
  useEffect(() => {
    if (direction === "in" && !national) setIsolatedTrainCode(null);
  }, [direction, national, setIsolatedTrainCode]);

  // A new origin starts clean: the selected / isolated train and the selected
  // destination belonged to the previous one (filters reset in selectOrigin).
  useEffect(() => {
    clearOriginSelection({ setSelectedTrainCode, setIsolatedTrainCode, setPanelCity });
  }, [originIdx, setSelectedTrainCode, setIsolatedTrainCode, setPanelCity]);

  // National mode closes the city panel.
  useEffect(() => {
    if (!national) return;
    setPanelCity(null);
  }, [national, setPanelCity]);
  const setNationalMode = (v: boolean) => {
    if (v === national) return;
    // A selected or isolated train belongs to the mode it was picked in.
    setSelectedTrainCode(null);
    setIsolatedTrainCode(null);
    setNational(v);
    writeNationalParam(v);
  };

  /* ---------- actions ---------- */
  const selectOrigin = (idx: number) => {
    setPanelCity(null);
    clearFilters();
    setOriginIdx(idx);
    syncUrl(idx);
  };

  // Debug / test handles on window.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__mapApi = mapRef.current;
    w.__selectOrigin = (zh: string) => {
      const origins = atlas?.data.origins || [];
      const idx = origins.findIndex((o) => o.zh === zh);
      if (idx >= 0) selectOrigin(idx);
    };
    w.__setShowOutline = setShowOutline;
    w.__setDark = setDark;
  });

  const handleSelectDest = (d: CityPointVM | null) => {
    if (d === null) {
      setPanelCity(null);
      return;
    }
    if (panelCity && panelCity.idx === d.idx) {
      const origins = atlas?.data.origins || [];
      const nextIdx = origins.findIndex((o) => o.zh === d.zh);
      if (nextIdx >= 0) {
        selectOrigin(nextIdx);
        setSelectedClasses([]);
        mapRef.current?.fitCountry();
      } else {
        setPanelCity(null);
      }
    } else {
      setPanelCity(d);
    }
  };

  // Switching direction keeps the selected city and re-renders from
  // the other direction's fields; the pinned city and the table's
  // filter/sort state reset (the table remounts on the direction key).
  // The first flip to a direction stages its files: map first (paint),
  // then its tables behind it; flipping back just ensures that
  // direction's tables are on their way.
  const setDirection = (d: Direction) => {
    if (d === direction) return;
    if (d === "in") {
      ensureInMap();
    } else {
      ensureOutTables();
    }
    setPanelCity(null);
    clearFilters();
    prefs.setDirection(d);
  };

  const setDistUnit = (u: DistUnit) => {
    if (u === distUnit) return;
    prefs.setDistUnit(u);
    // The open panel re-renders from state; refresh a visible tooltip too.
    if (mapRef.current) mapRef.current.refreshTooltip();
  };

  const timelineOpen = (direction === "out" || national) && showTimeline && !isTimelineCollapsed;
  const timelineRef = useRef<HTMLDivElement | null>(null);
  // Opening the panel scrolls the page just far enough that its bottom edge
  // meets the viewport bottom (instantly under reduced motion); closing it
  // leaves the scroll position alone.
  const wasOpen = useRef(timelineOpen);
  useEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = timelineOpen;
    if (!timelineOpen || was) return;
    const el = timelineRef.current;
    if (!el) return;
    const dy = el.getBoundingClientRect().bottom - window.innerHeight;
    if (dy <= 0) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollBy({ top: dy, behavior: still ? "auto" : "smooth" });
  }, [timelineOpen]);

  const origins = atlas ? atlas.data.origins : [];

  return (
    <>
      <div className="stage">
        <AppHeader
          compact={compactStats({
            cur: national ? null : cur,
            viewCur: national ? null : viewCur,
            direction,
            filtered: selectedClasses.length > 0 || filters.hasHistFilter,
            outTablesReady,
            inTablesReady,
            trainCount: national && natStats ? natStats.trains : atlas ? atlas.data.train_table.length : 0,
            national: national
              ? { cities: natStats?.cities ?? null, maxFlow: natStats?.maxFlow ?? null }
              : null,
          })}
          cur={national ? null : cur}
          viewCur={national ? null : viewCur}
          direction={direction}
          distUnit={distUnit}
          selectedClasses={selectedClasses}
          hasHistFilter={filters.hasHistFilter}
          selectedTrainCodes={filters.selectedTrainCodes}
          outTablesReady={outTablesReady}
          inTablesReady={inTablesReady}
          trainCount={national && natStats ? natStats.trains : atlas ? atlas.data.train_table.length : 0}
          isNational={national}
          onSetNational={setNationalMode}
          national={
            national
              ? { cities: natStats?.cities ?? null, maxFlow: natStats?.maxFlow ?? null }
              : null
          }
        />

        <Toolbar
          origins={origins}
          originIdx={originIdx}
          onSelectOrigin={selectOrigin}
          direction={direction}
          onSetDirection={setDirection}
          selectedClasses={selectedClasses}
          onClearClasses={() => setSelectedClasses([])}
          onToggleClass={filters.toggleClass}
          availableClasses={availableClasses}
          panelCity={panelCity}
          cur={cur}
          mapRef={mapRef}
          showNetwork={showNetwork}
          onToggleNetwork={() => setShowNetwork((v) => !v)}
          showLabels={showLabels}
          onToggleLabels={() => setShowLabels((v) => !v)}
          showInfra={showInfra}
          onToggleInfra={toggleInfra}
          distUnit={distUnit}
          onSetDistUnit={setDistUnit}
          dark={dark}
          onSetDark={setDark}
          national={national}
          showFlows={natFlowsOn}
          onToggleFlows={toggleNatFlows}
          activeFilterCount={
            selectedClasses.length +
            [filters.hours, filters.distBins, filters.durBins, filters.selectedTrainCodes].filter((a) => a && a.length > 0).length
          }
        />

        <MapHost
          ref={mapRef}
          atlas={atlas}
          outline={outline}
          showOutline={showOutline}
          baseCur={cur}
          cur={viewCur}
          direction={direction}
          dark={dark}
          showNetwork={showNetwork}
          showLabels={showLabels}
          showInfra={showInfra}
          distUnit={distUnit}
          panelDest={panelCity}
          loadError={loadError ?? natLoadError}
          onRetry={loadError ? undefined : retryNatLoad}
          inLoading={direction === "in" && inMapLoading && !national}
          national={national}
          nationalTrains={nationalTrains}
          nationalLayers={natLayersDrawn}
          nationalFlows={nationalFlows}
          nationalEntries={nationalEntries}
          nationalFilter={natFilter}
          nationalIndex={nationalIndex}
          onSelectDest={handleSelectDest}
          selectedTrainCode={selectedTrainCode}
          onSelectTrain={openTrain}
          isolatedTrainCode={isolatedTrainCode}
          onSelectIsolatedTrain={setIsolatedTrainCode}
          onSelectNatCity={setNatCity}
          legendRef={legendRef}
          initialCamera={initialCamera}
          onViewChange={handleViewChange}
        >
          <MapCardSlot />
          {(direction === "out" || national) && isolatedTrainCode && isolatedTrainCode !== selectedTrainCode && (
            <IsolationChip
              code={isolatedTrainCode}
              route={isolatedRoute}
              band={isolatedBand}
              onTimetable={() => openTrain(isolatedTrainCode)}
              onExit={() => setIsolatedTrainCode(null)}
            />
          )}
          <ActiveFilterBar
            classes={selectedClasses}
            hours={filters.hours}
            distBins={filters.distBins}
            durBins={filters.durBins}
            trainCodes={filters.selectedTrainCodes}
            onClearClass={(cls) =>
              setSelectedClasses((prev) => prev.filter((c) => c !== cls))
            }
            onClearHours={() => {
              filters.setSelectedHours([]);
              filters.setSelectedHour(null);
            }}
            onClearDist={() => {
              filters.setSelectedDistBins([]);
              filters.setSelectedDistBin(null);
            }}
            onClearDur={() => {
              filters.setSelectedDurBins([]);
              filters.setSelectedDurBin(null);
            }}
            onClearTrains={() => filters.setSelectedTrainCodes([])}
            onClearAll={clearFilters}
          />
          <DestinationPanel
            point={national ? natPoint : panelCity}
            rows={national ? natRows : undefined}
            sub={national ? natSub : undefined}
            link={(() => {
              if (!national || !natCityRow || !atlas) return null;
              const oi = atlas.data.origins.findIndex((o) => o.zh === natCityRow.zh);
              if (oi < 0) return null;
              return {
                label: "See all departures →",
                onClick: () => {
                  setNatCity(null);
                  setNationalMode(false);
                  selectOrigin(oi);
                },
              };
            })()}
            direction={national ? "out" : direction}
            cityEn={!national && cur ? cur.en : ""}
            cityZh={!national && cur ? cur.o.zh : ""}
            unit={distUnit}
            onClose={national ? () => setNatCity(null) : closePanel}
          />
          <div id="legendCol">
            <Legend
              ref={legendRef}
              national={national}
              title={
                national
                  ? "All trains of China Rail"
                  : direction === "out"
                  ? "Fastest time from origin"
                  : "Fastest time to " + (cur ? cur.en : "destination")
              }
            />
          </div>

          {(direction === "out" || national) && isTimelineCollapsed && (
            <TimelineExpandButton onExpand={expandTimeline} />
          )}
        </MapHost>

      </div>

      {/* The animation panel sits in the page flow under the map (outside
          the stage, so the map keeps its height), above the section below. */}
      {timelineOpen && (
        <div ref={timelineRef}>
          <TimelineScrubber
            mapRef={mapRef}
            dark={dark}
            direction={direction}
            originZh={cur?.o.zh}
            onCollapse={collapseTimeline}
          />
        </div>
      )}

      <DeparturesTable
        key={national ? "national" : direction}
        cur={national ? null : cur}
        national={natData}
        unit={distUnit}
        direction={direction}
        panelCity={panelCity}
        selectedClasses={selectedClasses}
        onSelectClasses={setSelectedClasses}
        outTablesReady={outTablesReady}
        inTablesReady={inTablesReady}
        atlas={atlas}
        onSelectOrigin={selectOrigin}
        onClearFilter={() => {
          closePanel();
          filters.setSelectedTrainCodes([]);
        }}
        onSelectTrain={openTrain}
        onToggleIsolate={toggleIsolate}
        isolatedTrainCode={isolatedTrainCode}
        onClearTrainIsolation={() => setIsolatedTrainCode(null)}
        onSelectCity={(c) => handleSelectDest(c)}
        selectedHour={filters.selectedHour}
        selectedHours={filters.selectedHours}
        onSelectHour={filters.setSelectedHour}
        onSelectHours={filters.setSelectedHours}
        selectedDistBin={filters.selectedDistBin}
        selectedDistBins={filters.selectedDistBins}
        onSelectDistBin={filters.setSelectedDistBin}
        onSelectDistBins={filters.setSelectedDistBins}
        selectedDurBin={filters.selectedDurBin}
        selectedDurBins={filters.selectedDurBins}
        onSelectDurBin={filters.setSelectedDurBin}
        onSelectDurBins={filters.setSelectedDurBins}
        selectedTrainCodes={filters.selectedTrainCodes}
        onSelectTrainCodes={filters.setSelectedTrainCodes}
      />

      <footer id="pageFooter">
        {atlas ? atlas.data.about : ""}
      </footer>

      <Footnote national={national} />

      <TrainScheduleModal
        key={trainOpenSeq}
        code={selectedTrainCode}
        timelineOpen={timelineOpen}
        trainT={selectedTrainVM ? selectedTrainVM.t : nationalTrainT}
        trainRow={(() => {
          const t = selectedTrainVM ? selectedTrainVM.t : nationalTrainT;
          return t !== null && atlas ? atlas.data.train_table[t] : null;
        })()}
        calendar={atlas?.data.calendar}
        onClose={() => setSelectedTrainCode(null)}
        schedulesData={schedulesData}
        stationTable={atlas ? atlas.data.station_table : []}
        dark={dark}
        unit={distUnit}
        trainVM={selectedTrainVM}
        national={national}
        isIsolated={isolatedTrainCode === selectedTrainCode}
        onToggleIsolate={toggleIsolate}
        onPlayFrom={(mins) => playFrom(national ? ((mins % 1440) + 1440) % 1440 : mins)}
        onJumpToTime={(mins) => {
          // The national clock is one day.
          mapRef.current?.setTime(national ? ((mins % 1440) + 1440) % 1440 : mins);
        }}
        mapRef={mapRef}
        originCityZh={national ? undefined : cur?.o.zh}
        originCityEn={national ? undefined : cur?.en}
        direction={national ? "out" : direction}
      />
    </>
  );
}
