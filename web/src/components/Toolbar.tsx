import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CityPointVM, Direction, DistUnit, OriginVM, RawOrigin } from "../types";
import { FLOW_CLASSES } from "../lib";
import CityPicker from "./CityPicker";
import type { MapApi } from "./MapHost";

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
  showFlows,
  onToggleFlows,
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
  /** National mode's flows (and city circles): a map toggle like the others, on by default. */
  showFlows: boolean;
  onToggleFlows: () => void;
  /** Filters in force (class + histogram + train-code filters), for the narrow-screen badge. */
  activeFilterCount: number;
}) {
  // Narrow screens (CSS, <= 640px): the filters and the map / display
  // controls fold into two dropdown panels; wider screens show them inline
  // (the panels are `display: contents` there).
  const [panel, setPanel] = useState<"filters" | "more" | null>(null);
  const toggle = (p: "filters" | "more") => setPanel((v) => (v === p ? null : p));
  // Wide screens: the layers panel is a popover. Esc closes it (focus returns
  // to its button) and so does a click anywhere outside it.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (panel !== "more") return;
    const wide = () => window.matchMedia("(min-width: 641px)").matches;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPanel(null);
      document.getElementById("moreBtn")?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (wide() && t && !t.closest("#tbMore, #moreBtn")) setPanel(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [panel]);
  // A dot on the layers button while any option differs from its default.
  const layersChanged = !showNetwork || showLabels || showInfra || (national && !showFlows) || distUnit !== "km";
  return (
    <div className="toolbar" ref={rootRef}>
      {!national && (
      <>
      <div className="group city-picker">
        <label htmlFor="originSearch"><span className="lb-long">Origin city</span><span className="lb-short">From</span></label>
        <CityPicker
          origins={origins}
          curIdx={originIdx}
          onSelect={onSelectOrigin}
        />
      </div>
      <button
        id="dirToggle"
        type="button"
        className="tb-mob-btn tb-dir-btn"
        aria-label={direction === "out" ? "Outbound (switch to inbound)" : "Inbound (switch to outbound)"}
        onClick={() => onSetDirection(direction === "out" ? "in" : "out")}
      >
        <svg className="tb-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M5 8h13M14 4l4 4-4 4M19 16H6M10 12l-4 4 4 4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="tb-dir-lbl">{direction === "out" ? "Out" : "In"}</span>
      </button>
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
        aria-label="Filters"
        className="tb-mob-btn"
        aria-expanded={panel === "filters" ? "true" : "false"}
        aria-controls="tbFilters"
        onClick={() => toggle("filters")}
      >
        <svg className="tb-ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="16" cy="7" r="2.4" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <circle cx="8" cy="17" r="2.4" fill="none" stroke="currentColor" strokeWidth="2.2" />
        </svg>
        <span className="tb-mob-lbl">Filters</span>
        {activeFilterCount > 0 && <span className="tb-badge">{activeFilterCount}</span>}
        <span className="tb-mob-lbl" aria-hidden="true"> ▾</span>
      </button>
      <button
        id="moreBtn"
        type="button"
        aria-label="Map options"
        title="Map options"
        className="tb-mob-btn tb-layers-btn"
        aria-expanded={panel === "more" ? "true" : "false"}
        aria-controls="tbMore"
        onClick={() => toggle("more")}
      >
        <svg className="tb-ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M12 3 3 8l9 5 9-5zM3 12.5l9 5 9-5M3 16.5l9 5 9-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <span className="tb-mob-lbl">Map options</span>
        {layersChanged && <span className="tb-dot" title="Some map options are changed" />}
        <span className="tb-mob-lbl" aria-hidden="true"> ▾</span>
      </button>
      <div id="tbMore" className={"tb-panel tb-pop" + (panel === "more" ? " open" : "")} role="group" aria-label="Map options">
      <span className="tb-pop-h">View</span>
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
      <span className="tb-pop-h">Map layers</span>
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
        {national && (
          <button
            id="tglFlows"
            type="button"
            aria-pressed={showFlows ? "true" : "false"}
            title="Trains per day on each section, and a circle per city sized by its departures and arrivals"
            onClick={onToggleFlows}
          >
            Flows
          </button>
        )}
        <button
          id="tglInfra"
          type="button"
          aria-pressed={showInfra ? "true" : "false"}
          onClick={onToggleInfra}
        >
          Infrastructure
        </button>
      </div>
      <span className="tb-pop-h">Units &amp; theme</span>
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
      </div>
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
    </div>
  );
}
