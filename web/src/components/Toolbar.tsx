import { useState } from "react";
import type { RefObject } from "react";
import type { CityPointVM, Direction, DistUnit, OriginVM, RawOrigin } from "../types";
import { FLOW_CLASSES } from "../lib";
import CityPicker from "./CityPicker";
import type { MapApi } from "./MapCanvas";

export default function Toolbar({
  origins,
  originIdx,
  onSelectOrigin,
  direction,
  onSetDirection,
  selectedClasses,
  onClearClasses,
  onToggleClass,
  availableClasses,
  panelCity,
  cur,
  mapRef,
  showNetwork,
  onToggleNetwork,
  showLabels,
  onToggleLabels,
  showInfra,
  onToggleInfra,
  distUnit,
  onSetDistUnit,
  dark,
  onSetDark,
  national,
  activeFilterCount,
}: {
  origins: RawOrigin[];
  originIdx: number;
  onSelectOrigin: (idx: number) => void;
  direction: Direction;
  onSetDirection: (d: Direction) => void;
  selectedClasses: string[];
  onClearClasses: () => void;
  onToggleClass: (cls: string) => void;
  availableClasses: Set<string>;
  panelCity: CityPointVM | null;
  cur: OriginVM | null;
  mapRef: RefObject<MapApi | null>;
  showNetwork: boolean;
  onToggleNetwork: () => void;
  showLabels: boolean;
  onToggleLabels: () => void;
  showInfra: boolean;
  onToggleInfra: () => void;
  distUnit: DistUnit;
  onSetDistUnit: (u: DistUnit) => void;
  dark: boolean;
  onSetDark: (d: boolean) => void;
  /** National mode (D11: "National · beta", D13 map-only). */
  national: boolean;
  /** Filters in force (class + histogram + train-code filters), for the narrow-screen badge. */
  activeFilterCount: number;
}) {
  // Narrow screens (CSS, <= 640px): the filters and the map / display
  // controls fold into two dropdown panels; wider screens show them inline
  // (the panels are `display: contents` there).
  const [panel, setPanel] = useState<"filters" | "more" | null>(null);
  const toggle = (p: "filters" | "more") => setPanel((v) => (v === p ? null : p));
  return (
    <div className="toolbar">
      {!national && (
      <>
      <div className="group city-picker">
        <label htmlFor="originSearch">Origin city</label>
        <CityPicker
          origins={origins}
          curIdx={originIdx}
          onSelect={onSelectOrigin}
        />
      </div>
      <div className="group units" role="group" aria-label="Direction">
        <button
          id="dirOut"
          type="button"
          aria-pressed={direction === "out" ? "true" : "false"}
          onClick={() => onSetDirection("out")}
        >
          Outbound
        </button>
        <button
          id="dirIn"
          type="button"
          aria-pressed={direction === "in" ? "true" : "false"}
          onClick={() => onSetDirection("in")}
        >
          Inbound
        </button>
      </div>
      </>
      )}
      <button
        id="filtersBtn"
        type="button"
        className="tb-mob-btn"
        aria-expanded={panel === "filters" ? "true" : "false"}
        aria-controls="tbFilters"
        onClick={() => toggle("filters")}
      >
        Filters
        {activeFilterCount > 0 && <span className="tb-badge">{activeFilterCount}</span>}
        <span aria-hidden="true"> ▾</span>
      </button>
      <button
        id="moreBtn"
        type="button"
        className="tb-mob-btn"
        aria-expanded={panel === "more" ? "true" : "false"}
        aria-controls="tbMore"
        onClick={() => toggle("more")}
      >
        Map options<span aria-hidden="true"> ▾</span>
      </button>
      <div id="tbFilters" className={"tb-panel" + (panel === "filters" ? " open" : "")}>
      <div
        className="group cls-filter"
        role="group"
        aria-label="Filter map and table by train class"
      >
        <span className="cls-label">Class:</span>
        <button
          type="button"
          className="cls-btn"
          aria-pressed={selectedClasses.length === 0 ? "true" : "false"}
          onClick={() => onClearClasses()}
        >
          All
        </button>
        {FLOW_CLASSES.map((cls) => {
          const active = selectedClasses.includes(cls);
          const label = cls === "plain" ? "普" : cls;
          const enabled = availableClasses.has(cls);
          return (
            <button
              key={cls}
              type="button"
              className="cls-btn"
              aria-pressed={active ? "true" : "false"}
              disabled={!enabled}
              title={
                !enabled
                  ? panelCity
                    ? `No ${label} trains between ${cur?.en || "origin"} and ${panelCity.en}`
                    : `No ${label} trains for ${cur?.en || "origin"}`
                  : undefined
              }
              onClick={() => onToggleClass(cls)}
            >
              {label}
            </button>
          );
        })}
      </div>
      </div>
      <div id="tbMore" className={"tb-panel" + (panel === "more" ? " open" : "")}>
      <div className="group">
        <button
          id="btnCountry"
          type="button"
          onClick={() => mapRef.current?.fitCountry()}
        >
          National view
        </button>
        {!national && (
          <button
            id="btnHome"
            type="button"
            onClick={() => mapRef.current?.fitHome()}
          >
            Origin close-up
          </button>
        )}
      </div>
      <div className="spacer"></div>
      <div className="group">
        <button
          id="tglNetwork"
          type="button"
          aria-pressed={showNetwork ? "true" : "false"}
          onClick={() => onToggleNetwork()}
        >
          Rail network
        </button>
        <button
          id="tglLabels"
          type="button"
          aria-pressed={showLabels ? "true" : "false"}
          onClick={() => onToggleLabels()}
        >
          City labels
        </button>
        <button
          id="tglInfra"
          type="button"
          aria-pressed={showInfra ? "true" : "false"}
          onClick={onToggleInfra}
        >
          Infrastructure
        </button>
        <button
          id="btnOut"
          type="button"
          aria-label="Zoom out"
          onClick={() => mapRef.current?.zoomCenter(1 / 1.45)}
        >
          &minus;
        </button>
        <button
          id="btnIn"
          type="button"
          aria-label="Zoom in"
          onClick={() => mapRef.current?.zoomCenter(1.45)}
        >
          +
        </button>
      </div>
      <div className="group units" role="group" aria-label="Distance units">
        <button
          id="unitKm"
          type="button"
          aria-pressed={distUnit === "km" ? "true" : "false"}
          onClick={() => onSetDistUnit("km")}
        >
          km
        </button>
        <button
          id="unitMi"
          type="button"
          aria-pressed={distUnit === "mi" ? "true" : "false"}
          onClick={() => onSetDistUnit("mi")}
        >
          mi
        </button>
      </div>
      <div
        id="themeToggle"
        className="group theme-toggle"
        role="group"
        aria-label="Day or night mode"
      >
        <button
          id="themeDay"
          type="button"
          aria-pressed={!dark ? "true" : "false"}
          onClick={() => onSetDark(false)}
          title="Day mode"
        >
          Day
        </button>
        <button
          id="themeNight"
          type="button"
          aria-pressed={dark ? "true" : "false"}
          onClick={() => onSetDark(true)}
          title="Night mode"
        >
          Night
        </button>
      </div>
      <span className="hint">
        Drag to pan &middot; scroll or pinch to zoom
        {national ? " · hover a city for its trains" : " · click a city for its distances"}
      </span>
      </div>
    </div>
  );
}
