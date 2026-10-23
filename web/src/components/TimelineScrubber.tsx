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
// 25% is dedicated to the Day 2–3 transcontinental tail (24h–55h+)
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
  const timeDisplayRef = useRef<HTMLSpanElement | null>(null);
  const sliderRef = useRef<HTMLInputElement | null>(null);
  const fillTrackRef = useRef<HTMLDivElement | null>(null);
  const counterRef = useRef<HTMLSpanElement | null>(null);
  const rushBadgeRef = useRef<HTMLSpanElement | null>(null);

  // Un-rendered transient state kept in refs for 60fps direct-DOM execution
  const currentPlayingRef = useRef(false);
  const currentTimeRef = useRef(360); // default 06:00 AM
  const currentSpeedRef = useRef(30);
  const totalMinsRef = useRef(1440);
  const totalDaysRef = useRef(1);

  // Minimal React state — only toggled on user interactions or discrete state flips
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(30);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Subscribe to MapCanvas animation ticks with direct DOM updates (0% React re-render overhead)
  useEffect(() => {
    const handleAnimUpdate = (state: AnimState) => {
      const totM = state.totalMins || 1440;
      totalMinsRef.current = totM;
      totalDaysRef.current = state.totalDays || Math.max(1, Math.ceil(totM / 1440));

      const t = Math.max(0, Math.min(totM, state.time));
      currentTimeRef.current = t;

      // 1. Time display clock
      if (timeDisplayRef.current) {
        timeDisplayRef.current.textContent = fmtTimelineClock(t, totM);
      }

      // 2. Non-linear slider input value & fill progress bar
      const sliderVal = timeToSlider(t, totM);
      if (sliderRef.current) {
        sliderRef.current.value = String(Math.round(sliderVal));
      }
      if (fillTrackRef.current) {
        fillTrackRef.current.style.width = `${(sliderVal / 10).toFixed(2)}%`;
      }

      // 3. Trains counter HUD
      if (counterRef.current) {
        const dep = state.departed ?? 0;
        const arr = state.arrived ?? 0;
        const tot = state.total ?? 0;
        if (t <= 1440) {
          const verb = direction === "out" ? "Departed" : "Boarded";
          counterRef.current.textContent = `${dep.toLocaleString("en-US")} ${verb} · ${arr.toLocaleString("en-US")} Arrived / ${tot.toLocaleString("en-US")} Total`;
        } else if (t >= totM) {
          counterRef.current.textContent = `All ${tot.toLocaleString("en-US")} Trains Arrived · 100% Complete`;
        } else {
          const pct = Math.round((arr / Math.max(1, tot)) * 100);
          counterRef.current.textContent = `${arr.toLocaleString("en-US")} / ${tot.toLocaleString("en-US")} Arrived (${pct}%) · In Transit`;
        }
      }

      // 4. Time period / Rush hour badge
      if (rushBadgeRef.current) {
        if (t >= totM) {
          rushBadgeRef.current.textContent = "All Trips Completed";
          rushBadgeRef.current.className = "ts-badge";
        } else {
          const day = Math.floor(t / 1440) + 1;
          const minsInDay = t % 1440;
          if (day === 1) {
            if (minsInDay >= 420 && minsInDay <= 570) {
              rushBadgeRef.current.textContent = "Morning Rush";
              rushBadgeRef.current.className = "ts-badge ts-badge-rush";
            } else if (minsInDay >= 1050 && minsInDay <= 1230) {
              rushBadgeRef.current.textContent = "Evening Rush";
              rushBadgeRef.current.className = "ts-badge ts-badge-rush";
            } else if (minsInDay < 360) {
              rushBadgeRef.current.textContent = "Night Services";
              rushBadgeRef.current.className = "ts-badge";
            } else {
              rushBadgeRef.current.textContent = "Day 1 Regular";
              rushBadgeRef.current.className = "ts-badge";
            }
          } else if (day === 2) {
            rushBadgeRef.current.textContent = "Day 2 Cross-Country";
            rushBadgeRef.current.className = "ts-badge ts-badge-rush";
          } else {
            rushBadgeRef.current.textContent = `Day ${day} Distal Terminus`;
            rushBadgeRef.current.className = "ts-badge";
          }
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
  }, [mapRef, direction]);

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
        if (timeDisplayRef.current) timeDisplayRef.current.textContent = fmtTimelineClock(prevT, totM);
        if (sliderRef.current) sliderRef.current.value = String(Math.round(prevS));
        if (fillTrackRef.current) fillTrackRef.current.style.width = `${(prevS / 10).toFixed(2)}%`;
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        const curS = timeToSlider(currentTimeRef.current, totM);
        const nextS = Math.min(1000, curS + 10);
        const nextT = sliderToTime(nextS, totM);
        currentTimeRef.current = nextT;
        mapRef.current?.setTime?.(nextT);
        if (timeDisplayRef.current) timeDisplayRef.current.textContent = fmtTimelineClock(nextT, totM);
        if (sliderRef.current) sliderRef.current.value = String(Math.round(nextS));
        if (fillTrackRef.current) fillTrackRef.current.style.width = `${(nextS / 10).toFixed(2)}%`;
      } else if (e.code === "Home") {
        e.preventDefault();
        currentTimeRef.current = 0;
        mapRef.current?.setTime?.(0);
        if (timeDisplayRef.current) timeDisplayRef.current.textContent = fmtTimelineClock(0, totM);
        if (sliderRef.current) sliderRef.current.value = "0";
        if (fillTrackRef.current) fillTrackRef.current.style.width = "0%";
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
    if (timeDisplayRef.current) {
      timeDisplayRef.current.textContent = fmtTimelineClock(tMins, totM);
    }
    if (fillTrackRef.current) {
      fillTrackRef.current.style.width = `${(val / 10).toFixed(2)}%`;
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
    mapRef.current?.setTime?.(totM);
    if (timeDisplayRef.current) {
      timeDisplayRef.current.textContent = fmtTimelineClock(totM, totM);
    }
    if (sliderRef.current) {
      sliderRef.current.value = "1000";
    }
    if (fillTrackRef.current) {
      fillTrackRef.current.style.width = "100%";
    }
  };

  const handleCollapse = () => {
    setIsCollapsed(true);
    // When collapsed, pause playback and show the full extent of the network
    mapRef.current?.setPlaying?.(false);
    const totM = totalMinsRef.current || 1440;
    mapRef.current?.setTime?.(totM);
  };

  const handleExpand = () => {
    setIsCollapsed(false);
  };

  // If user collapsed the timeline in-place: show only the clean expand button
  // (no time on page; network map remains in full extent)
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
            background: dark
              ? "rgba(26, 27, 30, 0.94)"
              : "rgba(255, 255, 255, 0.95)",
            color: dark ? "#EDEDEA" : "#111111",
            border: dark
              ? "1px solid rgba(255, 255, 255, 0.18)"
              : "1px solid rgba(0, 0, 0, 0.15)",
            borderRadius: "24px",
            padding: "8px 20px",
            fontSize: "12px",
            fontWeight: 700,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.32)",
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
              background: "#F59E0B",
              boxShadow: "0 0 6px #F59E0B",
            }}
          />
          <span>24h Flow Animation</span>
          <span style={{ opacity: 0.6, fontWeight: 500 }}>·</span>
          <span style={{ color: "var(--rust, #C8302A)", fontWeight: 800 }}>
            Expand ▴
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={`timeline-scrubber-dock ${dark ? "ts-dark" : "ts-light"}`}
      role="region"
      aria-label="24-hour train flow simulation controls"
    >
      <style>{`
        .timeline-scrubber-dock {
          position: absolute;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          width: calc(100% - 32px);
          max-width: 920px;
          border-radius: 14px;
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
          padding: 10px 16px 8px 16px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          z-index: 40;
          user-select: none;
          box-sizing: border-box;
          transition: background 0.2s ease, border-color 0.2s ease;
        }

        .timeline-scrubber-dock.ts-dark {
          background: rgba(26, 27, 30, 0.88);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #EDEDEA;
        }

        .timeline-scrubber-dock.ts-light {
          background: rgba(255, 255, 255, 0.90);
          border: 1px solid rgba(0, 0, 0, 0.10);
          color: #111111;
        }

        .ts-top-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          flex-wrap: nowrap;
        }

        .ts-left-group {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .ts-play-btn {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          border: none;
          background: var(--rust, #C8302A);
          color: #FFFFFF;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: transform 0.1s ease, background 0.15s ease;
          box-shadow: 0 2px 8px rgba(200, 48, 42, 0.4);
          flex-shrink: 0;
        }

        .ts-play-btn:hover {
          transform: scale(1.06);
          background: #E54035;
        }

        .ts-clock {
          font-family: var(--sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
          font-variant-numeric: tabular-nums;
          font-weight: 800;
          font-size: 19px;
          letter-spacing: -0.3px;
          min-width: 110px;
        }

        .ts-badge {
          display: inline-flex;
          align-items: center;
          padding: 2px 7px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.2px;
          background: rgba(128, 128, 128, 0.15);
          color: inherit;
          white-space: nowrap;
        }

        .ts-badge-rush {
          background: rgba(227, 166, 63, 0.22);
          color: #E3A63F;
          border: 1px solid rgba(227, 166, 63, 0.35);
        }

        .ts-right-group {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .ts-counter-wrap {
          font-variant-numeric: tabular-nums;
          font-size: 12px;
          font-weight: 600;
          opacity: 0.85;
          white-space: nowrap;
        }

        .ts-speed-control {
          display: flex;
          align-items: center;
          border-radius: 6px;
          background: rgba(128, 128, 128, 0.12);
          padding: 2px 4px;
          gap: 2px;
        }

        .ts-speed-label {
          font-size: 10px;
          font-weight: 700;
          opacity: 0.65;
          margin-right: 2px;
        }

        .ts-speed-btn {
          border: none;
          background: transparent;
          font-size: 11px;
          font-weight: 700;
          padding: 3px 6px;
          border-radius: 4px;
          cursor: pointer;
          color: inherit;
          opacity: 0.7;
          transition: background 0.12s ease, opacity 0.12s ease;
        }

        .ts-speed-btn.active {
          background: var(--rust, #C8302A);
          color: #FFFFFF;
          opacity: 1;
        }

        .ts-jump-group {
          display: flex;
          align-items: center;
          gap: 3px;
        }

        .ts-jump-btn {
          border: 1px solid rgba(128, 128, 128, 0.26);
          background: transparent;
          border-radius: 5px;
          font-size: 11px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          padding: 4px 8px;
          cursor: pointer;
          color: inherit;
          transition: background 0.15s ease;
        }

        .ts-jump-btn:hover {
          background: rgba(128, 128, 128, 0.16);
          color: var(--rust, #C8302A);
        }

        .ts-collapse-btn {
          border: 1px solid rgba(128, 128, 128, 0.26);
          background: transparent;
          border-radius: 5px;
          font-size: 11px;
          font-weight: 700;
          padding: 4px 8px;
          cursor: pointer;
          color: inherit;
          display: flex;
          align-items: center;
          gap: 3px;
          opacity: 0.8;
          transition: opacity 0.15s ease, background 0.15s ease;
        }

        .ts-collapse-btn:hover {
          opacity: 1;
          background: rgba(128, 128, 128, 0.16);
        }

        .ts-slider-container {
          position: relative;
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .ts-slider-track-wrap {
          position: relative;
          height: 18px;
          display: flex;
          align-items: center;
          width: 100%;
        }

        .ts-track-bg {
          position: absolute;
          left: 0;
          right: 0;
          height: 6px;
          border-radius: 3px;
          background: rgba(128, 128, 128, 0.22);
          overflow: hidden;
          pointer-events: none;
        }

        .ts-zone-am {
          position: absolute;
          left: 21.87%;
          width: 7.81%;
          height: 100%;
          background: rgba(227, 166, 63, 0.42);
        }

        .ts-zone-pm {
          position: absolute;
          left: 54.68%;
          width: 9.38%;
          height: 100%;
          background: rgba(227, 166, 63, 0.42);
        }

        .ts-zone-tail {
          position: absolute;
          left: 75%;
          width: 25%;
          height: 100%;
          background: rgba(100, 116, 139, 0.25);
        }

        .ts-split-divider {
          position: absolute;
          left: 75%;
          top: 0;
          bottom: 0;
          width: 1px;
          background: rgba(255, 255, 255, 0.45);
          pointer-events: none;
        }

        .ts-track-fill {
          position: absolute;
          left: 0;
          top: 0;
          height: 100%;
          width: 25%;
          border-radius: 3px;
          background: linear-gradient(90deg, var(--rust, #C8302A) 0%, var(--saffron, #E3A63F) 75%, #06B6D4 100%);
          pointer-events: none;
        }

        .ts-range-input {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 18px;
          margin: 0;
          background: transparent;
          outline: none;
          cursor: pointer;
          position: relative;
          z-index: 2;
        }

        .ts-range-input::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: var(--rust, #C8302A);
          border: 2px solid #FFFFFF;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
          cursor: grab;
          transition: transform 0.1s ease;
        }

        .ts-range-input:active::-webkit-slider-thumb {
          cursor: grabbing;
          transform: scale(1.22);
        }

        .ts-range-input::-moz-range-thumb {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: var(--rust, #C8302A);
          border: 2px solid #FFFFFF;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
          cursor: grab;
        }

        .ts-ticks-row {
          position: relative;
          width: 100%;
          height: 14px;
          font-size: 10px;
          font-weight: 500;
          font-variant-numeric: tabular-nums;
          opacity: 0.75;
          margin-top: -1px;
        }

        .ts-tick-pos {
          position: absolute;
          transform: translateX(-50%);
          cursor: pointer;
          white-space: nowrap;
          transition: color 0.15s ease, opacity 0.15s ease;
        }

        .ts-tick-pos:hover {
          color: var(--rust, #C8302A);
          opacity: 1;
        }

        .ts-tick-highlight {
          font-weight: 700;
          color: var(--rust, #C8302A);
          opacity: 0.95;
        }

        @media (max-width: 680px) {
          .timeline-scrubber-dock {
            bottom: 12px;
            width: calc(100% - 20px);
            padding: 8px 12px;
            gap: 5px;
          }
          .ts-clock {
            font-size: 16px;
            min-width: 80px;
          }
          .ts-badge {
            display: none;
          }
          .ts-counter-wrap {
            font-size: 11px;
          }
          .ts-speed-label {
            display: none;
          }
        }
      `}</style>

      {/* Top HUD & Controls row */}
      <div className="ts-top-row">
        <div className="ts-left-group">
          <button
            type="button"
            className="ts-play-btn"
            onClick={handleTogglePlay}
            aria-label={isPlaying ? "Pause timeline (Space)" : "Play timeline (Space)"}
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <rect x="5" y="4" width="4" height="16" rx="1" />
                <rect x="15" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <polygon points="6,4 20,12 6,20" />
              </svg>
            )}
          </button>

          <span ref={timeDisplayRef} className="ts-clock">
            Day 1 · 06:00
          </span>

          <span ref={rushBadgeRef} className="ts-badge">
            Morning Rush
          </span>
        </div>

        <div className="ts-right-group">
          <div className="ts-counter-wrap">
            <span ref={counterRef}>
              0 Departed · 0 / 0 Arrived
            </span>
          </div>

          <div
            className="ts-speed-control"
            role="group"
            aria-label="Playback cycle speed (seconds per 24 hours)"
            title="Real-world seconds to simulate a 24-hour cycle"
          >
            <span className="ts-speed-label">Speed:</span>
            <button
              type="button"
              className={`ts-speed-btn ${speed === 15 ? "active" : ""}`}
              onClick={() => handleSetSpeed(15)}
              title="15 seconds per day (Fast)"
            >
              15s
            </button>
            <button
              type="button"
              className={`ts-speed-btn ${speed === 30 ? "active" : ""}`}
              onClick={() => handleSetSpeed(30)}
              title="30 seconds per day (Standard)"
            >
              30s
            </button>
            <button
              type="button"
              className={`ts-speed-btn ${speed === 60 ? "active" : ""}`}
              onClick={() => handleSetSpeed(60)}
              title="60 seconds per day (Relaxed)"
            >
              60s
            </button>
          </div>

          <div className="ts-jump-group">
            <button
              type="button"
              className="ts-jump-btn"
              onClick={handleJumpToFinish}
              title="Jump to finish when all trains have arrived"
            >
              Finish
            </button>
          </div>

          <button
            type="button"
            className="ts-collapse-btn"
            onClick={handleCollapse}
            title="Collapse animation bar and display full-extent static network"
          >
            ▾ Collapse
          </button>
        </div>
      </div>

      {/* Bottom Slider & Ticks row: 75% for 0–24h, 25% for 24h–55h+ tail */}
      <div className="ts-slider-container">
        <div className="ts-slider-track-wrap">
          <div className="ts-track-bg">
            <div className="ts-zone-am" title="Morning Rush Hour (07:00 – 09:30)" />
            <div className="ts-zone-pm" title="Evening Rush Hour (17:30 – 20:30)" />
            <div className="ts-zone-tail" title="Day 2–3 Trans-continental Terminal Arrivals" />
            <div className="ts-split-divider" />
            <div ref={fillTrackRef} className="ts-track-fill" />
          </div>

          <input
            ref={sliderRef}
            type="range"
            min="0"
            max="1000"
            step="1"
            defaultValue="188"
            className="ts-range-input"
            aria-label="Timeline time scrubber"
            onInput={(e) => handleSliderInput(Number(e.currentTarget.value))}
            onChange={(e) => handleSliderInput(Number(e.currentTarget.value))}
          />
        </div>

        <div className="ts-ticks-row">
          <span
            className="ts-tick-pos"
            style={{ left: "0%" }}
            onClick={() => handleSliderInput(0)}
            title="Day 1 00:00 midnight"
          >
            00:00
          </span>
          <span
            className="ts-tick-pos ts-tick-highlight"
            style={{ left: "18.75%" }}
            onClick={() => handleSliderInput(188)}
            title="Day 1 06:00 AM"
          >
            06:00 Peak
          </span>
          <span
            className="ts-tick-pos"
            style={{ left: "37.5%" }}
            onClick={() => handleSliderInput(375)}
            title="Day 1 12:00 Midday"
          >
            12:00
          </span>
          <span
            className="ts-tick-pos ts-tick-highlight"
            style={{ left: "56.25%" }}
            onClick={() => handleSliderInput(562)}
            title="Day 1 18:00 PM"
          >
            18:00 Peak
          </span>
          <span
            className="ts-tick-pos ts-tick-highlight"
            style={{ left: "75%" }}
            onClick={() => handleSliderInput(750)}
            title="Day 1 24:00 (Departures complete)"
          >
            24:00 (D1 End)
          </span>
          <span
            className="ts-tick-pos"
            style={{ left: "100%", transform: "translateX(-100%)" }}
            onClick={handleJumpToFinish}
            title="All long-haul trans-continental trains arrived"
          >
            All Arrived
          </span>
        </div>
      </div>
    </div>
  );
};

export default TimelineScrubber;
