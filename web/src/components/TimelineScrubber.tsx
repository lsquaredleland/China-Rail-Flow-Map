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

      // 2. Slider input value, max & fill progress bar
      if (sliderRef.current) {
        sliderRef.current.max = String(totM);
        sliderRef.current.value = String(Math.round(t));
      }
      if (fillTrackRef.current) {
        const pct = (t / totM) * 100;
        fillTrackRef.current.style.width = `${pct}%`;
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
        const prev = Math.max(0, currentTimeRef.current - 15);
        currentTimeRef.current = prev;
        mapRef.current?.setTime?.(prev);
        if (timeDisplayRef.current) timeDisplayRef.current.textContent = fmtTimelineClock(prev, totM);
        if (sliderRef.current) sliderRef.current.value = String(prev);
        if (fillTrackRef.current) fillTrackRef.current.style.width = `${(prev / totM) * 100}%`;
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        const next = Math.min(totM, currentTimeRef.current + 15);
        currentTimeRef.current = next;
        mapRef.current?.setTime?.(next);
        if (timeDisplayRef.current) timeDisplayRef.current.textContent = fmtTimelineClock(next, totM);
        if (sliderRef.current) sliderRef.current.value = String(next);
        if (fillTrackRef.current) fillTrackRef.current.style.width = `${(next / totM) * 100}%`;
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
    currentTimeRef.current = val;
    mapRef.current?.setTime?.(val);
    const totM = totalMinsRef.current || 1440;
    if (timeDisplayRef.current) {
      timeDisplayRef.current.textContent = fmtTimelineClock(val, totM);
    }
    if (fillTrackRef.current) {
      fillTrackRef.current.style.width = `${(val / totM) * 100}%`;
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

  const handleJumpTo = (tMins: number) => {
    currentTimeRef.current = tMins;
    mapRef.current?.setTime?.(tMins);
    const totM = totalMinsRef.current || 1440;
    if (timeDisplayRef.current) {
      timeDisplayRef.current.textContent = fmtTimelineClock(tMins, totM);
    }
    if (sliderRef.current) {
      sliderRef.current.value = String(tMins);
    }
    if (fillTrackRef.current) {
      fillTrackRef.current.style.width = `${(tMins / totM) * 100}%`;
    }
  };

  // If user collapsed the timeline in-place, render a sleek floating pill dock
  if (isCollapsed) {
    return (
      <div
        style={{
          position: "absolute",
          bottom: "16px",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 40,
          background: dark ? "rgba(17, 24, 39, 0.92)" : "rgba(255, 255, 255, 0.92)",
          backdropFilter: "blur(12px)",
          border: `1px solid ${dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.12)"}`,
          borderRadius: "30px",
          padding: "6px 14px",
          boxShadow: "0 10px 25px -5px rgba(0,0,0,0.35)",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          cursor: "pointer",
          color: dark ? "#F3F4F6" : "#111827",
          fontSize: "12px",
        }}
        onClick={() => setIsCollapsed(false)}
        title="Click to expand timeline scrubber"
      >
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: isPlaying ? "#10B981" : "#F59E0B",
            boxShadow: `0 0 8px ${isPlaying ? "#10B981" : "#F59E0B"}`,
          }}
        />
        <span style={{ fontWeight: 700 }}>24h+ Flow Simulation</span>
        <span
          ref={timeDisplayRef}
          style={{
            fontFamily: "monospace",
            fontWeight: 800,
            padding: "2px 6px",
            borderRadius: "4px",
            background: dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.06)",
          }}
        >
          {fmtTimelineClock(currentTimeRef.current, totalMinsRef.current)}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsCollapsed(false);
          }}
          style={{
            border: "none",
            background: dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)",
            color: "inherit",
            cursor: "pointer",
            padding: "3px 8px",
            borderRadius: "12px",
            fontSize: "11px",
            fontWeight: 700,
          }}
        >
          Expand ▴
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
          padding: 2px;
          gap: 2px;
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
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          padding: 3px 6px;
          cursor: pointer;
          color: inherit;
          transition: background 0.15s ease;
        }

        .ts-jump-btn:hover {
          background: rgba(128, 128, 128, 0.16);
        }

        .ts-collapse-btn {
          border: 1px solid rgba(128, 128, 128, 0.26);
          background: transparent;
          border-radius: 5px;
          font-size: 11px;
          font-weight: 700;
          padding: 3px 8px;
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

        .ts-track-fill {
          position: absolute;
          left: 0;
          top: 0;
          height: 100%;
          width: 25%;
          border-radius: 3px;
          background: linear-gradient(90deg, var(--rust, #C8302A) 0%, var(--saffron, #E3A63F) 100%);
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
          display: flex;
          justify-content: space-between;
          font-size: 10px;
          font-weight: 500;
          font-variant-numeric: tabular-nums;
          opacity: 0.72;
          padding: 0 1px;
          margin-top: -1px;
        }

        .ts-tick {
          cursor: pointer;
          transition: opacity 0.15s ease, color 0.15s ease;
        }

        .ts-tick:hover {
          opacity: 1;
          color: var(--rust, #C8302A);
        }

        .ts-tick-highlight {
          font-weight: 700;
          color: var(--rust, #C8302A);
          opacity: 0.9;
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
          .ts-jump-group {
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
            aria-label="Playback cycle speed"
          >
            <button
              type="button"
              className={`ts-speed-btn ${speed === 15 ? "active" : ""}`}
              onClick={() => handleSetSpeed(15)}
              title="15s per day (Fast)"
            >
              15s
            </button>
            <button
              type="button"
              className={`ts-speed-btn ${speed === 30 ? "active" : ""}`}
              onClick={() => handleSetSpeed(30)}
              title="30s per day (Standard)"
            >
              30s
            </button>
            <button
              type="button"
              className={`ts-speed-btn ${speed === 60 ? "active" : ""}`}
              onClick={() => handleSetSpeed(60)}
              title="60s per day (Relaxed)"
            >
              60s
            </button>
          </div>

          <div className="ts-jump-group">
            <button
              type="button"
              className="ts-jump-btn"
              onClick={() => handleJumpTo(360)}
              title="Jump to Day 1 06:00 (Start of morning rush)"
            >
              D1 06:00
            </button>
            <button
              type="button"
              className="ts-jump-btn"
              onClick={() => handleJumpTo(1440)}
              title="Jump to 24:00 (End of Day 1 departures)"
            >
              24h
            </button>
            <button
              type="button"
              className="ts-jump-btn"
              onClick={() => handleJumpTo(totalMinsRef.current)}
              title="Jump to finish when all trans-continental trains arrive"
            >
              Finish
            </button>
          </div>

          <button
            type="button"
            className="ts-collapse-btn"
            onClick={() => setIsCollapsed(true)}
            title="Collapse animation controls into a compact dock"
          >
            ▾ Collapse
          </button>
        </div>
      </div>

      {/* Bottom Slider & Ticks row */}
      <div className="ts-slider-container">
        <div className="ts-slider-track-wrap">
          <div className="ts-track-bg">
            <div ref={fillTrackRef} className="ts-track-fill" />
          </div>

          <input
            ref={sliderRef}
            type="range"
            min="0"
            max="1440"
            step="1"
            defaultValue="360"
            className="ts-range-input"
            aria-label="Timeline time scrubber"
            onInput={(e) => handleSliderInput(Number(e.currentTarget.value))}
            onChange={(e) => handleSliderInput(Number(e.currentTarget.value))}
          />
        </div>

        <div className="ts-ticks-row">
          <span className="ts-tick" onClick={() => handleJumpTo(0)} title="Jump to Day 1 00:00">
            D1 00:00
          </span>
          <span
            className="ts-tick ts-tick-highlight"
            onClick={() => handleJumpTo(360)}
            title="Jump to Day 1 06:00 (Peak)"
          >
            D1 06:00 Peak
          </span>
          <span className="ts-tick" onClick={() => handleJumpTo(1440)} title="Jump to Day 1 24:00">
            D1 24:00
          </span>
          <span
            className="ts-tick ts-tick-highlight"
            onClick={() => handleJumpTo(Math.min(totalMinsRef.current, 2880))}
            title="Jump to Day 2 24:00"
          >
            D2 24:00
          </span>
          <span
            className="ts-tick"
            onClick={() => handleJumpTo(totalMinsRef.current)}
            title="Jump to complete terminus arrivals"
          >
            All Arrived
          </span>
        </div>
      </div>
    </div>
  );
};

export default TimelineScrubber;
