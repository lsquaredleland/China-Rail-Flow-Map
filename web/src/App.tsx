import { useEffect, useMemo, useRef, useState } from "react";
import type { DecodedAtlas, Direction, DistUnit, OriginVM } from "./types";
import { buildOrigin } from "./lib";
import { useAtlasData } from "./hooks/useAtlasData";
import { usePrefs, useUrlSync } from "./hooks/useUrlState";
import { useFilters, useCityPanel, useTrainSelection } from "./hooks/useSelection";
import { useAnimationClock } from "./hooks/useAnimationClock";
import MapCanvas, { type MapApi } from "./components/MapCanvas";
import Legend, { type LegendHandle } from "./components/Legend";
import DestinationPanel from "./components/DestinationPanel";
import DeparturesTable from "./components/DeparturesTable";
import Footnote from "./components/Footnote";
import TimelineScrubber from "./components/TimelineScrubber";
import TrainScheduleModal from "./components/TrainScheduleModal";
import AppHeader from "./components/AppHeader";
import Toolbar from "./components/Toolbar";
import ActiveFilterBar from "./components/ActiveFilterBar";
import { IsolationChip, TimelineExpandButton } from "./components/MapOverlays";
import type { CityPointVM } from "./types";

// The deck.gl renderer is the default; ?renderer=canvas is the Canvas 2D escape hatch (until P1c.2).
const RENDERER: "canvas" | "deck" =
  new URLSearchParams(location.search).get("renderer") === "canvas" ? "canvas" : "deck";

export default function App() {
  const atlasRef = useRef<DecodedAtlas | null>(null);
  const mapRef = useRef<MapApi | null>(null);
  const legendRef = useRef<LegendHandle | null>(null);
  const [originIdx, setOriginIdx] = useState(-1);
  const [showOutline, setShowOutline] = useState(true);
  const [showNetwork, setShowNetwork] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [showTimeline] = useState<boolean>(true);

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

  const selectedTrainVM = useMemo(() => {
    if (!selectedTrainCode || !cur) return null;
    const list = direction === "out" ? cur.deps : cur.arrs;
    return list.find((t) => t.code === selectedTrainCode) || null;
  }, [selectedTrainCode, cur, direction]);

  const { panelCity, setPanelCity, availableClasses, closePanel } = useCityPanel({
    cur,
    viewCur,
    direction,
    outTablesReady,
    inTablesReady,
    setSelectedClasses,
    mapRef,
  });

  const { isTimelineCollapsed, expandTimeline, collapseTimeline } =
    useAnimationClock(mapRef, direction);
  // The isolated train belongs to the outbound animation.
  useEffect(() => {
    if (direction === "in") setIsolatedTrainCode(null);
  }, [direction, setIsolatedTrainCode]);

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

  const origins = atlas ? atlas.data.origins : [];

  return (
    <>
      <div className="stage">
        <AppHeader
          cur={cur}
          viewCur={viewCur}
          direction={direction}
          distUnit={distUnit}
          selectedClasses={selectedClasses}
          hasHistFilter={filters.hasHistFilter}
          selectedTrainCodes={filters.selectedTrainCodes}
          outTablesReady={outTablesReady}
          inTablesReady={inTablesReady}
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
        />

        <MapCanvas
          ref={mapRef}
          renderer={RENDERER}
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
          inLoading={direction === "in" && inMapLoading}
          onSelectDest={handleSelectDest}
          selectedTrainCode={selectedTrainCode}
          onSelectTrain={setSelectedTrainCode}
          isolatedTrainCode={isolatedTrainCode}
          onSelectIsolatedTrain={setIsolatedTrainCode}
          legendRef={legendRef}
          initialCamera={initialCamera}
          onViewChange={handleViewChange}
        >
          {direction === "out" && isolatedTrainCode && (
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
          <DestinationPanel
            point={panelCity}
            direction={direction}
            cityEn={cur ? cur.en : ""}
            cityZh={cur ? cur.o.zh : ""}
            unit={distUnit}
            onClose={closePanel}
          />
          <div id="legendCol">
            <Legend
              ref={legendRef}
              title={
                direction === "out"
                  ? "Fastest time from origin"
                  : "Fastest time to " + (cur ? cur.en : "destination")
              }
            />
          </div>

          {direction === "out" && isTimelineCollapsed && (
            <TimelineExpandButton onExpand={expandTimeline} />
          )}
        </MapCanvas>

        {direction === "out" && showTimeline && !isTimelineCollapsed && (
          <TimelineScrubber
            mapRef={mapRef}
            dark={dark}
            direction={direction}
            originZh={cur?.o.zh}
            onCollapse={collapseTimeline}
          />
        )}
      </div>

      <DeparturesTable
        key={direction}
        cur={cur}
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

      <footer id="pageFooter">
        {atlas ? atlas.data.about : ""}
      </footer>

      <Footnote cur={cur} direction={direction} />

      <TrainScheduleModal
        code={selectedTrainCode}
        trainT={selectedTrainVM ? selectedTrainVM.t : null}
        onClose={() => setSelectedTrainCode(null)}
        schedulesData={schedulesData}
        stationTable={atlas ? atlas.data.station_table : []}
        dark={dark}
        unit={distUnit}
        trainVM={selectedTrainVM}
        isIsolated={isolatedTrainCode === selectedTrainCode}
        onToggleIsolate={(c) => {
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
