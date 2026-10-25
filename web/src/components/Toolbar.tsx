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
  onToggleNational,
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
  onToggleNational: () => void;
}) {
  return (
    <div className="toolbar">
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
      <div className="group">
        <button
          id="btnCountry"
          type="button"
          onClick={() => mapRef.current?.fitCountry()}
        >
          National view
        </button>
        <button
          id="btnHome"
          type="button"
          onClick={() => mapRef.current?.fitHome()}
        >
          Origin close-up
        </button>
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
        Drag to pan &middot; scroll or pinch to zoom &middot; click a city
        for its distances
      </span>
      {/* Last, so it takes free space at the row's end and moves nothing else. */}
      <div className="group">
        <button
          id="tglNational"
          type="button"
          aria-pressed={national ? "true" : "false"}
          onClick={() => onToggleNational()}
          title="Every covered train in China on one 24h clock (beta)"
        >
          National &middot; beta
        </button>
      </div>
    </div>
  );
}
