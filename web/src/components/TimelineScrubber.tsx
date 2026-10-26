import {
  useEffect,
  useRef,
  useState,
  type FC,
  type RefObject,
} from "react";
import type { MapApi, AnimState } from "./MapCanvas";
import type { Direction } from "../types";

export interface TimelineScrubberProps {
  mapRef: RefObject<MapApi | null>;
  dark: boolean;
  direction: Direction;
  originZh?: string;
  onCollapse?: () => void;
}

// 75% of slider track visual width is dedicated to Day 1 (0–24h)
// 25% is dedicated to the trans-continental tail (24h–55h+)
const SPLIT_SLIDER = 750; // out of 1000

// Day 1 always takes the first 75%, so the fixed ticks and rush zones line
// up; an origin whose trains all arrive by 24:00 has an empty tail.
function timeToSlider(tMins: number, totalMins: number): number {
  const tot = Math.max(1440, totalMins);
  if (tMins <= 1440 || tot <= 1440) {
    return Math.max(0, Math.min(SPLIT_SLIDER, (tMins / 1440) * SPLIT_SLIDER));
  }
  const fracTail = Math.max(0, Math.min(1, (tMins - 1440) / (tot - 1440)));
  return SPLIT_SLIDER + fracTail * (1000 - SPLIT_SLIDER);
}

function sliderToTime(sliderVal: number, totalMins: number): number {
  const tot = Math.max(1440, totalMins);
  const s = Math.max(0, Math.min(1000, sliderVal));
  if (s <= SPLIT_SLIDER || tot <= 1440) {
    return (Math.min(s, SPLIT_SLIDER) / SPLIT_SLIDER) * 1440;
  }
  const fracTail = (s - SPLIT_SLIDER) / (1000 - SPLIT_SLIDER);
  return 1440 + fracTail * (tot - 1440);
}

/** Format minutes from midnight across multiple days (Day 1, Day 2, Day 3). */
function fmtTimelineClock(mins: number, totalMins: number = 1440): string {
  const m = Math.max(0, Math.floor(mins));
  const day = Math.floor(m / 1440) + 1;
  const minsInDay = m % 1440;
  const hh = Math.floor(minsInDay / 60);
  const mm = minsInDay % 60;
  const clock = `${hh < 10 ? "0" : ""}${hh}:${mm < 10 ? "0" : ""}${mm}`;
  if (totalMins > 1440) {
    return `Day ${day} · ${clock}`;
  }
  if (m >= 1440) return "24:00";
  return clock;
}

export const TimelineScrubber: FC<TimelineScrubberProps> = ({
  mapRef,
  dark,
  direction,
  onCollapse,
}) => {
  const timeDayRef = useRef<HTMLSpanElement | null>(null);
  const timeDisplayRef = useRef<HTMLSpanElement | null>(null);
  const sliderRef = useRef<HTMLInputElement | null>(null);
  const fillTrackRef = useRef<HTMLDivElement | null>(null);
  const needleRef = useRef<HTMLDivElement | null>(null);

  const departedValRef = useRef<HTMLSpanElement | null>(null);
  const arrivedValRef = useRef<HTMLSpanElement | null>(null);
  const totalValRef = useRef<HTMLSpanElement | null>(null);

  const rushBadgeRef = useRef<HTMLDivElement | null>(null);
  const rushBadgeTextRef = useRef<HTMLSpanElement | null>(null);
  const finishTickRef = useRef<HTMLSpanElement | null>(null);

  // Un-rendered transient state kept in refs for 60fps direct-DOM execution
  const currentPlayingRef = useRef(false);
  const currentTimeRef = useRef(360);
  const currentSpeedRef = useRef(30);
  const totalMinsRef = useRef(1440);
  const totalDaysRef = useRef(1);

  // Minimal React state — only toggled on user interactions or discrete state flips
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(30);
  const [isCollapsed, setIsCollapsed] = useState(true);
  // National mode (D13): Running / Trains counters, a one-day clock with no finish.
  const [isNational, setIsNational] = useState(false);
  const currentNationalRef = useRef(false);

  // Subscribe to MapCanvas animation ticks with direct DOM updates (0% React re-render overhead)
  useEffect(() => {
    const handleAnimUpdate = (state: AnimState) => {
      const totM = state.totalMins || 1440;
      totalMinsRef.current = totM;
      totalDaysRef.current = state.totalDays || Math.max(1, Math.ceil(totM / 1440));

      const t = Math.max(0, Math.min(totM, state.time));
      currentTimeRef.current = t;

      const day = Math.floor(t / 1440) + 1;
      const minsInDay = Math.floor(t % 1440);
      const hh = Math.floor(minsInDay / 60);
      const mm = minsInDay % 60;
      const clockStr = `${hh < 10 ? "0" : ""}${hh}:${mm < 10 ? "0" : ""}${mm}`;

      // 1. Time display clock & day caption
      if (timeDayRef.current) {
        timeDayRef.current.textContent = `DAY ${day}`;
      }
      if (timeDisplayRef.current) {
        timeDisplayRef.current.textContent = clockStr;
      }
      if (finishTickRef.current) {
        finishTickRef.current.textContent = fmtTimelineClock(totM, totM);
      }

      // 2. Non-linear slider input value, fill progress bar, and custom needle handle
      const sliderVal = timeToSlider(t, totM);
      const pct = (sliderVal / 10).toFixed(2);
      if (sliderRef.current) {
        sliderRef.current.value = String(Math.round(sliderVal));
      }
      if (fillTrackRef.current) {
        fillTrackRef.current.style.width = `${pct}%`;
      }
      if (needleRef.current) {
        needleRef.current.style.left = `${pct}%`;
      }

      // 3. Train statistics (Departed, Arrived, Total)
      const dep = state.departed ?? 0;
      const arr = state.arrived ?? 0;
      const tot = state.total ?? 0;
      if (departedValRef.current) {
        departedValRef.current.textContent = dep.toLocaleString("en-US");
      }
      if (arrivedValRef.current) {
        arrivedValRef.current.textContent = arr.toLocaleString("en-US");
      }
      if (totalValRef.current) {
        totalValRef.current.textContent = tot.toLocaleString("en-US");
      }

      // 4. Time period / Rush hour badge
      if (rushBadgeRef.current && rushBadgeTextRef.current) {
        const rushColor = dark ? "#E54035" : "#C8302A";
        if (t >= totM && !state.national) {
          rushBadgeTextRef.current.textContent = "ALL ARRIVED";
          rushBadgeRef.current.style.borderColor = "#10B981";
          rushBadgeRef.current.style.color = "#10B981";
        } else if (day === 1 && minsInDay >= 420 && minsInDay <= 570) {
          rushBadgeTextRef.current.textContent = "MORNING RUSH";
          rushBadgeRef.current.style.borderColor = rushColor;
          rushBadgeRef.current.style.color = rushColor;
        } else if (day === 1 && minsInDay >= 1050 && minsInDay <= 1230) {
          rushBadgeTextRef.current.textContent = "EVENING RUSH";
          rushBadgeRef.current.style.borderColor = rushColor;
          rushBadgeRef.current.style.color = rushColor;
        } else if (day === 1 && minsInDay < 360) {
          rushBadgeTextRef.current.textContent = "NIGHT SERVICES";
          rushBadgeRef.current.style.borderColor = dark ? "#6B7280" : "#9CA3AF";
          rushBadgeRef.current.style.color = dark ? "#6B7280" : "#9CA3AF";
        } else if (day > 1) {
          rushBadgeTextRef.current.textContent = `DAY ${day} TAIL`;
          rushBadgeRef.current.style.borderColor = dark ? "#F59E0B" : "#D97706";
          rushBadgeRef.current.style.color = dark ? "#F59E0B" : "#D97706";
        } else {
          rushBadgeTextRef.current.textContent = "DAY 1 REGULAR";
          rushBadgeRef.current.style.borderColor = dark ? "#4B5563" : "#6B7280";
          rushBadgeRef.current.style.color = dark ? "#4B5563" : "#6B7280";
        }
      }

      // 5. Flip play button icon only when playing boolean state changes
      if (state.isPlaying !== currentPlayingRef.current) {
        currentPlayingRef.current = state.isPlaying;
        setIsPlaying(state.isPlaying);
      }

      // 6. Flip the national labels only when the mode changes
      if (state.national !== currentNationalRef.current) {
        currentNationalRef.current = state.national;
        setIsNational(state.national);
      }

      // 7. Sync speed preset button if changed externally
      const spd = state.speed;
      if (spd && spd !== currentSpeedRef.current) {
        currentSpeedRef.current = spd;
        setSpeed(spd);
      }
    };

    let unsub: (() => void) | undefined;
    let pollInterval: number | undefined;

    const tryAttach = () => {
      if (mapRef.current?.subscribeAnim) {
        unsub = mapRef.current.subscribeAnim(handleAnimUpdate);
        const cur = mapRef.current.getAnimState?.();
        if (cur) handleAnimUpdate(cur);
        return true;
      }
      return false;
    };

    if (!tryAttach()) {
      pollInterval = window.setInterval(() => {
        if (tryAttach()) {
          clearInterval(pollInterval);
        }
      }, 80);
    }

    return () => {
      if (pollInterval) clearInterval(pollInterval);
      if (unsub) unsub();
    };
  }, [mapRef, direction, dark, isNational]); // a mode flip remounts counters: re-pull the state

  // Global Keyboard Shortcuts (Space, ArrowLeft, ArrowRight, Home)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.tagName === "SELECT" ||
          activeEl.isContentEditable)
      ) {
        if (activeEl !== sliderRef.current) {
          return;
        }
      }

      const totM = totalMinsRef.current || 1440;

      if (e.code === "Space") {
        e.preventDefault();
        mapRef.current?.togglePlaying?.();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        const curS = timeToSlider(currentTimeRef.current, totM);
        const prevS = Math.max(0, curS - 10);
        const prevT = sliderToTime(prevS, totM);
        currentTimeRef.current = prevT;
        mapRef.current?.setTime?.(prevT);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        const curS = timeToSlider(currentTimeRef.current, totM);
        const nextS = Math.min(1000, curS + 10);
        const nextT = sliderToTime(nextS, totM);
        currentTimeRef.current = nextT;
        mapRef.current?.setTime?.(nextT);
      } else if (e.code === "Home") {
        e.preventDefault();
        currentTimeRef.current = 0;
        mapRef.current?.setTime?.(0);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mapRef]);

  const handleSliderInput = (val: number) => {
    const totM = totalMinsRef.current || 1440;
    const tMins = sliderToTime(val, totM);
    currentTimeRef.current = tMins;
    mapRef.current?.setTime?.(tMins);
    const pct = (val / 10).toFixed(2);
    if (fillTrackRef.current) {
      fillTrackRef.current.style.width = `${pct}%`;
    }
    if (needleRef.current) {
      needleRef.current.style.left = `${pct}%`;
    }
  };

  const handleTogglePlay = () => {
    mapRef.current?.togglePlaying?.();
  };

  const handleSetSpeed = (s: number) => {
    setSpeed(s);
    currentSpeedRef.current = s;
    mapRef.current?.setSpeed?.(s);
  };

  const handleJumpToFinish = () => {
    const totM = totalMinsRef.current || 1440;
    currentTimeRef.current = totM;
    mapRef.current?.setPlaying?.(false);
    mapRef.current?.setTime?.(totM);
    if (sliderRef.current) {
      sliderRef.current.value = "1000";
    }
    if (fillTrackRef.current) {
      fillTrackRef.current.style.width = "100%";
    }
    if (needleRef.current) {
      needleRef.current.style.left = "100%";
    }
  };

  const handleCollapse = () => {
    if (onCollapse) {
      onCollapse();
    } else {
      setIsCollapsed(true);
    }
    mapRef.current?.setPlaying?.(false);
    mapRef.current?.setAnimEnabled?.(false);
  };

  const handleExpand = () => {
    setIsCollapsed(false);
    // Turning the animation on sets its start time (anim.ts animStartMins).
    mapRef.current?.setAnimEnabled?.(true);
    mapRef.current?.setSpeed?.(30);
    mapRef.current?.setPlaying?.(true);
  };

  // If user collapsed the timeline in-place without parent controlling collapse
  if (isCollapsed && !onCollapse) {
    return (
      <div className="timeline-collapsed-bar">
        <button
          type="button"
          className="tl-expand-btn"
          onClick={handleExpand}
          title="Expand 24h train flow animation controls"
        >
          <span className="tl-expand-dot" />
          <span>24h Flow Animation · Expand ▴</span>
        </button>
      </div>
    );
  }

  return (
    <div className="timeline-bar-dock">
      {/* Top Row: Play / Clock / Rush Badge / Stats / Speed / Finish / Collapse */}
      <div className="tb-row">
        {/* Left: Play button + Clock + Rush Badge */}
        <div className="tb-left">
          <button
            type="button"
            className="tb-play"
            onClick={handleTogglePlay}
            aria-label={isPlaying ? "Pause timeline" : "Play timeline"}
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <polygon points="7,4 20,12 7,20" />
              </svg>
            )}
          </button>

          <div className="tb-time">
            <span ref={timeDayRef} className="tb-day-label">
              DAY 1
            </span>
            <span ref={timeDisplayRef} className="tb-clock">
              00:00
            </span>
          </div>

          <div ref={rushBadgeRef} className="tb-badge">
            <span className="tb-badge-icon">■</span>
            <span ref={rushBadgeTextRef}>DAY 1 REGULAR</span>
          </div>
        </div>

        {/* Center: Departed / Arrived / Total columnar stats */}
        <div className="tb-metrics-group">
          <div className="tb-metric-col">
            <span ref={departedValRef} className="tb-metric-val is-accent">
              0
            </span>
            <span className="tb-metric-lbl">
              {isNational ? "RUNNING" : direction === "out" ? "DEPARTED" : "BOARDED"}
            </span>
          </div>

          {!isNational && (
            <div className="tb-metric-col">
              <span ref={arrivedValRef} className="tb-metric-val is-ink">
                0
              </span>
              <span className="tb-metric-lbl">ARRIVED</span>
            </div>
          )}

          <div className="tb-metric-col">
            <span ref={totalValRef} className="tb-metric-val is-total">
              0
            </span>
            <span className="tb-metric-lbl">{isNational ? "TRAINS" : "TOTAL"}</span>
          </div>
        </div>

        {/* Right: A DAY IN / 15s 30s 60s / Finish / Collapse */}
        <div className="tb-right">
          <span className="tb-speed-caption">A DAY IN</span>

          <div className="tb-speed-group">
            <button
              type="button"
              className={`tb-speed-btn ${speed === 15 ? "active" : ""}`}
              onClick={() => handleSetSpeed(15)}
              title="Simulate 24 hours in 15 seconds"
            >
              15s
            </button>
            <button
              type="button"
              className={`tb-speed-btn ${speed === 30 ? "active" : ""}`}
              onClick={() => handleSetSpeed(30)}
              title="Simulate 24 hours in 30 seconds"
            >
              30s
            </button>
            <button
              type="button"
              className={`tb-speed-btn ${speed === 60 ? "active" : ""}`}
              onClick={() => handleSetSpeed(60)}
              title="Simulate 24 hours in 60 seconds"
            >
              60s
            </button>
          </div>

          <button
            type="button"
            className="tb-btn-action is-text"
            onClick={handleJumpToFinish}
            title="Jump simulation to finish when all trains have arrived"
          >
            Finish
          </button>

          <button
            type="button"
            className="tb-btn-action is-icon"
            onClick={handleCollapse}
            title="Collapse animation bar"
          >
            <svg viewBox="0 0 24 24" width="16" height="16">
              <polyline
                points="6 9 12 15 18 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Bottom Scrubber: Zones Header + Track with Hatched Tail + Tick Labels */}
      <div className="tb-scrub">
        {/* Zones row (Morning Rush, Evening Rush, Arrivals Only) */}
        <div className="tb-zones">
          <div className="tb-zone is-rush is-morning">
            <span className="tb-zone-label">MORNING RUSH</span>
          </div>
          <div className="tb-zone is-rush is-evening">
            <span className="tb-zone-label">EVENING RUSH</span>
          </div>
          <div className="tb-zone is-tail">
            <span className="tb-zone-label">ARRIVALS ONLY</span>
          </div>
        </div>

        {/* Track Bar */}
        <div className="tb-track">
          {/* Track Background: Day 1 (0-75%) + Diagonally Hatched Tail (75-100%) */}
          <div className="tb-track-bg">
            <div className="tb-track-tail" />
            {/* Red Filled Progress */}
            <div
              ref={fillTrackRef}
              className="tb-track-fill"
              style={{ width: "0%" }}
            />
          </div>

          {/* Vertical Divider Line at 75% (24:00 Day 1 ends) */}
          <div className="tb-day-end" />

          {/* Needle & Square Thumb Handle */}
          <div ref={needleRef} className="tb-needle" style={{ left: "0%" }}>
            <div className="tb-needle-head" />
            <div className="tb-needle-stem" />
          </div>

          {/* Interactive Range Input on top */}
          <input
            ref={sliderRef}
            className="tb-slider"
            type="range"
            min="0"
            max="1000"
            step="1"
            defaultValue="0"
            aria-label="Timeline scrubber"
            onInput={(e) => handleSliderInput(Number(e.currentTarget.value))}
            onChange={(e) => handleSliderInput(Number(e.currentTarget.value))}
          />
        </div>

        {/* Ticks & Labels Row */}
        <div className="tb-ticks">
          <span
            className="tb-tick-item at-0"
            onClick={() => handleSliderInput(0)}
            title="Day 1 00:00"
          >
            00:00
          </span>
          <span
            className="tb-tick-item at-6"
            onClick={() => handleSliderInput(188)}
            title="Day 1 06:00"
          >
            06:00
          </span>
          <span
            className="tb-tick-item at-12"
            onClick={() => handleSliderInput(375)}
            title="Day 1 12:00"
          >
            12:00
          </span>
          <span
            className="tb-tick-item at-18"
            onClick={() => handleSliderInput(562)}
            title="Day 1 18:00"
          >
            18:00
          </span>
          <span
            className="tb-tick-item at-24"
            onClick={() => handleSliderInput(750)}
            title="Day 1 24:00 (Day 1 departures complete)"
          >
            24:00 · Day 1 ends
          </span>
          {!isNational && (
            <span
              ref={finishTickRef}
              className="tb-tick-item at-end"
              onClick={handleJumpToFinish}
              title="All trains arrived"
            >
              All arrived
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default TimelineScrubber;
