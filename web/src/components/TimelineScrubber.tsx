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
}

// 75% of slider track visual width is dedicated to Day 1 (0–24h)
// 25% is dedicated to the trans-continental tail (24h–55h+)
const SPLIT_SLIDER = 750; // out of 1000

function timeToSlider(tMins: number, totalMins: number): number {
  const tot = Math.max(1440, totalMins);
  if (tot <= 1440) {
    return Math.max(0, Math.min(1000, (tMins / 1440) * 1000));
  }
  if (tMins <= 1440) {
    return Math.max(0, Math.min(SPLIT_SLIDER, (tMins / 1440) * SPLIT_SLIDER));
  }
  const fracTail = Math.max(0, Math.min(1, (tMins - 1440) / (tot - 1440)));
  return SPLIT_SLIDER + fracTail * (1000 - SPLIT_SLIDER);
}

function sliderToTime(sliderVal: number, totalMins: number): number {
  const tot = Math.max(1440, totalMins);
  const s = Math.max(0, Math.min(1000, sliderVal));
  if (tot <= 1440) {
    return (s / 1000) * 1440;
  }
  if (s <= SPLIT_SLIDER) {
    return (s / SPLIT_SLIDER) * 1440;
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
  const currentTimeRef = useRef(0);
  const currentSpeedRef = useRef(15);
  const totalMinsRef = useRef(1440);
  const totalDaysRef = useRef(1);

  // Minimal React state — only toggled on user interactions or discrete state flips
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(15);
  const [isCollapsed, setIsCollapsed] = useState(true);

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
        if (t >= totM) {
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

      // 6. Sync speed preset button if changed externally
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
  }, [mapRef, direction, dark]);

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
    setIsCollapsed(true);
    mapRef.current?.setPlaying?.(false);
    mapRef.current?.setAnimEnabled?.(false);
  };

  const handleExpand = () => {
    setIsCollapsed(false);
    currentTimeRef.current = 0;
    mapRef.current?.setAnimEnabled?.(true);
    mapRef.current?.setTime?.(0);
    mapRef.current?.setPlaying?.(true);
  };

  // If user collapsed the timeline in-place: show only the clean expand button
  if (isCollapsed) {
    return (
      <div
        style={{
          position: "absolute",
          bottom: "16px",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 40,
        }}
      >
        <button
          type="button"
          onClick={handleExpand}
          style={{
            background: dark ? "rgba(24, 24, 27, 0.96)" : "rgba(255, 255, 255, 0.98)",
            color: dark ? "#EDEDEA" : "#111111",
            border: dark ? "1.5px solid rgba(255, 255, 255, 0.2)" : "1.5px solid #111111",
            borderRadius: "24px",
            padding: "8px 22px",
            fontSize: "12px",
            fontWeight: 700,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            transition: "transform 0.12s ease, background 0.15s ease",
          }}
          title="Expand 24h train flow animation controls"
        >
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: "#C8302A",
              boxShadow: "0 0 6px #C8302A",
            }}
          />
          <span>24h Flow Animation · Expand ▴</span>
        </button>
      </div>
    );
  }

  const redAccent = dark ? "#E54035" : "#C8302A";

  return (
    <div
      className="timeline-bar-dock"
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        width: "100%",
        background: dark ? "#18181B" : "#FFFFFF",
        color: dark ? "#EDEDEA" : "#111111",
        borderTop: dark ? "1px solid rgba(255,255,255,0.18)" : "1.5px solid #111111",
        boxShadow: "0 -4px 16px rgba(0, 0, 0, 0.10)",
        padding: "8px 24px 6px 24px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        zIndex: 40,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        userSelect: "none",
        boxSizing: "border-box",
      }}
    >
      <style>{`
        .tb-day-label {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.8px;
          color: ${dark ? "#A1A1AA" : "#71717A"};
          text-transform: uppercase;
        }
        .tb-clock {
          font-size: 24px;
          font-weight: 800;
          line-height: 1;
          color: ${dark ? "#EDEDEA" : "#111111"};
          font-variant-numeric: tabular-nums;
          letter-spacing: -0.5px;
        }
        .tb-badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          border: 1.5px solid ${redAccent};
          color: ${redAccent};
          padding: 3px 8px;
          font-size: 9px;
          font-weight: 800;
          letter-spacing: 0.6px;
          text-transform: uppercase;
        }
        .tb-badge-icon {
          font-size: 7px;
          line-height: 1;
        }
        .tb-metric-col {
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .tb-metric-val {
          font-size: 20px;
          font-weight: 800;
          line-height: 1;
          font-variant-numeric: tabular-nums;
          letter-spacing: -0.5px;
        }
        .tb-metric-lbl {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.6px;
          color: ${dark ? "#A1A1AA" : "#71717A"};
          text-transform: uppercase;
          margin-top: 2px;
        }
        .tb-speed-caption {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.8px;
          color: ${dark ? "#A1A1AA" : "#71717A"};
          text-transform: uppercase;
        }
        .tb-speed-btn {
          height: 28px;
          padding: 0 10px;
          border: none;
          background: transparent;
          color: ${dark ? "#EDEDEA" : "#111111"};
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.12s ease, color 0.12s ease;
        }
        .tb-speed-btn:not(:last-child) {
          border-right: 1.5px solid ${dark ? "rgba(255,255,255,0.25)" : "#111111"};
        }
        .tb-speed-btn.active {
          background: ${dark ? "#EDEDEA" : "#111111"};
          color: ${dark ? "#111111" : "#FFFFFF"};
        }
        .tb-btn-action {
          height: 28px;
          border: 1.5px solid ${dark ? "rgba(255,255,255,0.25)" : "#111111"};
          background: transparent;
          color: ${dark ? "#EDEDEA" : "#111111"};
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: background 0.12s ease;
        }
        .tb-btn-action:hover {
          background: ${dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.04)"};
        }
        .tb-tick-item {
          position: absolute;
          cursor: pointer;
          white-space: nowrap;
          font-size: 9px;
          font-weight: 700;
          color: ${dark ? "#EDEDEA" : "#111111"};
          transition: color 0.15s ease;
        }
        .tb-tick-item:hover {
          color: ${redAccent};
        }
        @media (max-width: 900px) {
          .tb-metrics-group {
            display: none !important;
          }
          .tb-speed-caption {
            display: none !important;
          }
        }
      `}</style>

      {/* Top Row: Play / Clock / Rush Badge / Stats / Speed / Finish / Collapse */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
        }}
      >
        {/* Left: Play button + Clock + Rush Badge */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button
            type="button"
            onClick={handleTogglePlay}
            aria-label={isPlaying ? "Pause timeline" : "Play timeline"}
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
            style={{
              width: "36px",
              height: "36px",
              background: dark ? "#EDEDEA" : "#111111",
              color: dark ? "#111111" : "#FFFFFF",
              border: "none",
              borderRadius: "0",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
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

          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
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
        <div
          className="tb-metrics-group"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "24px",
          }}
        >
          <div className="tb-metric-col">
            <span
              ref={departedValRef}
              className="tb-metric-val"
              style={{ color: redAccent }}
            >
              0
            </span>
            <span className="tb-metric-lbl">
              {direction === "out" ? "DEPARTED" : "BOARDED"}
            </span>
          </div>

          <div className="tb-metric-col">
            <span
              ref={arrivedValRef}
              className="tb-metric-val"
              style={{ color: dark ? "#EDEDEA" : "#111111" }}
            >
              0
            </span>
            <span className="tb-metric-lbl">ARRIVED</span>
          </div>

          <div className="tb-metric-col">
            <span
              ref={totalValRef}
              className="tb-metric-val"
              style={{ color: dark ? "#9CA3AF" : "#4B5563" }}
            >
              0
            </span>
            <span className="tb-metric-lbl">TOTAL</span>
          </div>
        </div>

        {/* Right: A DAY IN / 15s 30s 60s / Finish / Collapse */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span className="tb-speed-caption">A DAY IN</span>

          <div
            style={{
              display: "flex",
              border: dark
                ? "1.5px solid rgba(255,255,255,0.25)"
                : "1.5px solid #111111",
              borderRadius: "0",
              overflow: "hidden",
            }}
          >
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
            className="tb-btn-action"
            onClick={handleJumpToFinish}
            style={{ padding: "0 12px" }}
            title="Jump simulation to finish when all trains have arrived"
          >
            Finish
          </button>

          <button
            type="button"
            className="tb-btn-action"
            onClick={handleCollapse}
            style={{ width: "28px" }}
            title="Collapse animation bar"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
        </div>
      </div>

      {/* Bottom Scrubber: Zones Header + Track with Hatched Tail + Tick Labels */}
      <div style={{ width: "100%", display: "flex", flexDirection: "column" }}>
        {/* Zones row (Morning Rush, Evening Rush, Arrivals Only) */}
        <div style={{ position: "relative", width: "100%", height: "14px", marginBottom: "2px" }}>
          {/* Morning Rush (07:00–09:30): 07:00 / 24 * 75% = 21.875%, width 7.8125% */}
          <div
            style={{
              position: "absolute",
              left: "21.875%",
              width: "7.8125%",
              height: "100%",
              background: dark ? "rgba(229, 64, 53, 0.16)" : "rgba(200, 48, 42, 0.12)",
              display: "flex",
              alignItems: "center",
              padding: "0 4px",
              boxSizing: "border-box",
            }}
          >
            <span
              style={{
                fontSize: "8px",
                fontWeight: 800,
                color: redAccent,
                letterSpacing: "0.5px",
                whiteSpace: "nowrap",
              }}
            >
              MORNING RUSH
            </span>
          </div>

          {/* Evening Rush (17:30–20:30): 17.5 / 24 * 75% = 54.6875%, width 9.375% */}
          <div
            style={{
              position: "absolute",
              left: "54.6875%",
              width: "9.375%",
              height: "100%",
              background: dark ? "rgba(229, 64, 53, 0.16)" : "rgba(200, 48, 42, 0.12)",
              display: "flex",
              alignItems: "center",
              padding: "0 4px",
              boxSizing: "border-box",
            }}
          >
            <span
              style={{
                fontSize: "8px",
                fontWeight: 800,
                color: redAccent,
                letterSpacing: "0.5px",
                whiteSpace: "nowrap",
              }}
            >
              EVENING RUSH
            </span>
          </div>

          {/* Arrivals Only (24:00+ extended tail) */}
          <div
            style={{
              position: "absolute",
              left: "76%",
              height: "100%",
              display: "flex",
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontSize: "8px",
                fontWeight: 800,
                color: dark ? "#A1A1AA" : "#71717A",
                letterSpacing: "0.6px",
                whiteSpace: "nowrap",
              }}
            >
              ARRIVALS ONLY
            </span>
          </div>
        </div>

        {/* Track Bar */}
        <div style={{ position: "relative", width: "100%", height: "8px" }}>
          {/* Track Background: Day 1 (0-75%) + Diagonally Hatched Tail (75-100%) */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: dark ? "#2E3035" : "#E5E3DC",
              borderRadius: "0",
              overflow: "hidden",
            }}
          >
            {/* Extended Hatched Tail from 75% to 100% */}
            <div
              style={{
                position: "absolute",
                left: "75%",
                right: 0,
                top: 0,
                bottom: 0,
                background: dark
                  ? "repeating-linear-gradient(45deg, #3A3D44, #3A3D44 2px, #26282D 2px, #26282D 6px)"
                  : "repeating-linear-gradient(45deg, #D4D2CA, #D4D2CA 2px, #E5E3DC 2px, #E5E3DC 6px)",
              }}
            />

            {/* Red Filled Progress */}
            <div
              ref={fillTrackRef}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: "0%",
                background: redAccent,
                transition: "width 0.05s linear",
              }}
            />
          </div>

          {/* Vertical Divider Line at 75% (24:00 Day 1 ends) */}
          <div
            style={{
              position: "absolute",
              left: "75%",
              top: "-2px",
              width: "2px",
              height: "12px",
              background: dark ? "#EDEDEA" : "#111111",
              zIndex: 3,
            }}
          />

          {/* Needle & Square Thumb Handle */}
          <div
            ref={needleRef}
            style={{
              position: "absolute",
              left: "0%",
              top: "-6px",
              transform: "translateX(-50%)",
              pointerEvents: "none",
              zIndex: 5,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              transition: "left 0.05s linear",
            }}
          >
            <div
              style={{
                width: "10px",
                height: "10px",
                background: dark ? "#EDEDEA" : "#111111",
                borderRadius: "1px",
              }}
            />
            <div
              style={{
                width: "2px",
                height: "12px",
                background: dark ? "#EDEDEA" : "#111111",
              }}
            />
          </div>

          {/* Interactive Range Input on top */}
          <input
            ref={sliderRef}
            type="range"
            min="0"
            max="1000"
            step="1"
            defaultValue="0"
            style={{
              position: "absolute",
              left: 0,
              top: "-6px",
              width: "100%",
              height: "20px",
              opacity: 0,
              cursor: "pointer",
              zIndex: 10,
              margin: 0,
            }}
            aria-label="Timeline scrubber"
            onInput={(e) => handleSliderInput(Number(e.currentTarget.value))}
            onChange={(e) => handleSliderInput(Number(e.currentTarget.value))}
          />
        </div>

        {/* Ticks & Labels Row */}
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "14px",
            marginTop: "4px",
          }}
        >
          <span
            className="tb-tick-item"
            style={{ left: "0%" }}
            onClick={() => handleSliderInput(0)}
            title="Day 1 00:00"
          >
            00:00
          </span>
          <span
            className="tb-tick-item"
            style={{ left: "18.75%", transform: "translateX(-50%)" }}
            onClick={() => handleSliderInput(188)}
            title="Day 1 06:00"
          >
            06:00
          </span>
          <span
            className="tb-tick-item"
            style={{ left: "37.5%", transform: "translateX(-50%)" }}
            onClick={() => handleSliderInput(375)}
            title="Day 1 12:00"
          >
            12:00
          </span>
          <span
            className="tb-tick-item"
            style={{ left: "56.25%", transform: "translateX(-50%)" }}
            onClick={() => handleSliderInput(562)}
            title="Day 1 18:00"
          >
            18:00
          </span>
          <span
            className="tb-tick-item"
            style={{ left: "75%", transform: "translateX(-50%)", fontWeight: 800 }}
            onClick={() => handleSliderInput(750)}
            title="Day 1 24:00 (Day 1 departures complete)"
          >
            24:00 · Day 1 ends
          </span>
          <span
            ref={finishTickRef}
            className="tb-tick-item"
            style={{ right: 0 }}
            onClick={handleJumpToFinish}
            title="All trains arrived"
          >
            All arrived
          </span>
        </div>
      </div>
    </div>
  );
};

export default TimelineScrubber;
