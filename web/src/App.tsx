import { useEffect, useMemo, useRef, useState } from "react";
import type { DecodedAtlas, Direction, DistUnit, NatLayer, OriginVM } from "./types";
import { buildOrigin, fmtCalendarSpan } from "./lib";
import type { NatFilter } from "./lib";
import { useAtlasData } from "./hooks/useAtlasData";
import {
  initialNatLayer,
  initialNational,
  usePrefs,
  useUrlSync,
  writeNatLayerParam,
  writeNationalParam,
} from "./hooks/useUrlState";
import { useFilters, useCityPanel, useTrainSelection } from "./hooks/useSelection";
import { useAnimationClock } from "./hooks/useAnimationClock";
import MapCanvas, { type MapApi } from "./components/MapCanvas";
import Legend, { type LegendHandle } from "./components/Legend";
import DestinationPanel from "./components/DestinationPanel";
import DeparturesTable from "./components/DeparturesTable";
import Footnote from "./components/Footnote";
import TimelineScrubber from "./components/TimelineScrubber";
import TrainScheduleModal from "./components/TrainScheduleModal";
import AnimAnnouncer from "./components/AnimAnnouncer";
import AppHeader from "./components/AppHeader";
import Toolbar from "./components/Toolbar";
import ActiveFilterBar from "./components/ActiveFilterBar";
import { IsolationChip, NationalNote, TimelineExpandButton } from "./components/MapOverlays";
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
  // What national mode draws: flows (with the city circles) and / or the
  // trains' animation. Default: flows only, no animation.
  const [natLayer, setNatLayer] = useState<NatLayer>(initialNatLayer);
  const natFlowsOn = natLayer === "flows" || natLayer === "both";
  const natTrainsOn = natLayer === "trains" || natLayer === "both";

  const prefs = usePrefs();
  const { showInfra, distUnit, direction, dark, setDark, toggleInfra } = prefs;
  const { selectedTrainCode, setSelectedTrainCode, isolatedTrainCode, setIsolatedTrainCode } =
    useTrainSelection();

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
    if (!selectedTrainCode || !cur) return null;
    const list = direction === "out" ? cur.deps : cur.arrs;
    return list.find((t) => t.code === selectedTrainCode) || null;
  }, [selectedTrainCode, cur, direction]);

  // National mode: the dot's train is not in the origin's departures, so the
  // schedule key is found by code in the shared train table (codes are unique).
  const nationalTrainT = useMemo(() => {
    if (!national || !selectedTrainCode || !atlas) return null;
    const t = atlas.data.train_table.findIndex((r) => r.code === selectedTrainCode);
    return t >= 0 ? t : null;
  }, [national, selectedTrainCode, atlas]);

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

  const { isTimelineCollapsed, expandTimeline, collapseTimeline } =
    useAnimationClock(mapRef, direction, national, natTrainsOn);
  // The isolated train belongs to the outbound animation.
  useEffect(() => {
    if (direction === "in") setIsolatedTrainCode(null);
  }, [direction, setIsolatedTrainCode]);

  // National mode closes the city panel; its trains file loads only when the
  // animation is turned on (never in the origin view).
  useEffect(() => {
    if (!national) return;
    setPanelCity(null);
  }, [national, setPanelCity]);
  useEffect(() => {
    if (national && natTrainsOn) ensureNationalTrains();
  }, [national, natTrainsOn, ensureNationalTrains]);
  // The per-train index (hour / distance / duration / code filters): national mode only.
  useEffect(() => {
    if (national) ensureNationalIndex();
  }, [national, ensureNationalIndex]);
  // The national table is timed by the schedules asset.
  useEffect(() => {
    if (national) ensureSchedules();
  }, [national, ensureSchedules]);
  const setNationalMode = (v: boolean) => {
    if (v === national) return;
    setNational(v);
    writeNationalParam(v);
  };
  // The flows files load only when national mode asks to draw them: the
  // day's totals for Flows, the entry ticks too when the animation is on
  // (the flows then build up with the clock).
  useEffect(() => {
    if (!national || !natFlowsOn) return;
    ensureNationalFlows();
    if (natTrainsOn) ensureNationalEntries();
  }, [national, natFlowsOn, natTrainsOn, ensureNationalFlows, ensureNationalEntries]);
  const chooseNatLayer = (flows: boolean, trains: boolean) => {
    const v: NatLayer = flows ? (trains ? "both" : "flows") : trains ? "trains" : "none";
    setNatLayer(v);
    writeNatLayerParam(v);
  };
  // A flows file that failed leaves the trains drawn (the note says why).
  const natLayerDrawn: NatLayer = nationalFlowsFailed ? (natTrainsOn ? "trains" : "none") : natLayer;
  // The animation button and the timeline bar are one switch in national mode.
  const natAnimate = (on: boolean) => chooseNatLayer(natFlowsOn, on);

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
  // The schedule window ("23 Oct – 6 Nov") of a train-export pack.
  const calendarSpan = atlas ? fmtCalendarSpan(atlas.data.calendar) : undefined;

  return (
    <>
      <div className="stage">
        <AppHeader
          cur={national ? null : cur}
          viewCur={national ? null : viewCur}
          direction={direction}
          distUnit={distUnit}
          selectedClasses={selectedClasses}
          hasHistFilter={filters.hasHistFilter}
          selectedTrainCodes={filters.selectedTrainCodes}
          outTablesReady={outTablesReady}
          inTablesReady={inTablesReady}
          trainCount={atlas ? atlas.data.train_table.length : 0}
          calendarSpan={calendarSpan}
          isNational={national}
          onSetNational={setNationalMode}
          national={
            national
              ? {
                  cities: nationalFlows?.cities ? nationalFlows.cities.idx.length : null,
                  maxFlow: nationalFlows ? nationalFlows.total.reduce((m, v) => (v > m ? v : m), 0) : null,
                }
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
          activeFilterCount={
            selectedClasses.length +
            [filters.hours, filters.distBins, filters.durBins, filters.selectedTrainCodes].filter((a) => a && a.length > 0).length
          }
        />

        <MapCanvas
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
          loadError={loadError}
          inLoading={direction === "in" && inMapLoading && !national}
          national={national}
          nationalTrains={nationalTrains}
          nationalLayer={natLayerDrawn}
          nationalFlows={nationalFlows}
          nationalEntries={nationalEntries}
          nationalFilter={natFilter}
          nationalIndex={nationalIndex}
          onSelectDest={handleSelectDest}
          selectedTrainCode={selectedTrainCode}
          onSelectTrain={setSelectedTrainCode}
          isolatedTrainCode={isolatedTrainCode}
          onSelectIsolatedTrain={setIsolatedTrainCode}
          legendRef={legendRef}
          initialCamera={initialCamera}
          onViewChange={handleViewChange}
        >
          {direction === "out" && !national && isolatedTrainCode && (
            <IsolationChip
              code={isolatedTrainCode}
              onTimetable={() => setSelectedTrainCode(isolatedTrainCode)}
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
          {!national && (
            <DestinationPanel
              point={panelCity}
              direction={direction}
              cityEn={cur ? cur.en : ""}
              cityZh={cur ? cur.o.zh : ""}
              unit={distUnit}
              onClose={closePanel}
            />
          )}
          {national && (
            <NationalNote
              trains={atlas ? atlas.data.train_table.length : 0}
              span={calendarSpan}
              failed={nationalTrainsFailed && natTrainsOn}
              flows={natFlowsOn}
              animate={natTrainsOn}
              onFlows={() => chooseNatLayer(!natFlowsOn, natTrainsOn)}
              onAnimate={() => natAnimate(!natTrainsOn)}
              flowsFailed={nationalFlowsFailed && natFlowsOn}
            />
          )}
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

          {direction === "out" && !national && isTimelineCollapsed && (
            <TimelineExpandButton onExpand={expandTimeline} />
          )}
        </MapCanvas>

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
            onCollapse={national ? () => natAnimate(false) : collapseTimeline}
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
        onSelectTrain={setSelectedTrainCode}
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

      <AnimAnnouncer mapRef={mapRef} national={national} />

      <footer id="pageFooter">
        {atlas ? atlas.data.about : ""}
      </footer>

      <Footnote cur={cur} direction={direction} />

      <TrainScheduleModal
        code={selectedTrainCode}
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
        trainVM={national ? null : selectedTrainVM}
        isIsolated={isolatedTrainCode === selectedTrainCode}
        onToggleIsolate={national ? undefined : (c) => {
          setIsolatedTrainCode((prev) => (prev === c ? null : c));
        }}
        onJumpToTime={(mins) => {
          mapRef.current?.setTime(mins);
        }}
        mapRef={mapRef}
        originCityZh={cur?.o.zh}
        originCityEn={cur?.en}
        direction={direction}
      />
    </>
  );
}
