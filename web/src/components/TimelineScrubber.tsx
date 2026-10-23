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

/** Format minutes from midnight (0..1440) as "HH:MM". */
function fmtClock(mins: number): string {
  const m = Math.max(0, Math.min(1440, Math.floor(mins)));
  if (m === 1440) return "24:00";
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${hh < 10 ? "0" : ""}${hh}:${mm < 10 ? "0" : ""}${mm}`;
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

  // Minimal React state — only toggled on user interactions or discrete state flips
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(30);

  // Subscribe to MapCanvas animation ticks with direct DOM updates (0% React re-render overhead)
  useEffect(() => {
    const handleAnimUpdate = (state: AnimState) => {
      const t = Math.max(0, Math.min(1440, state.time));
      currentTimeRef.current = t;

      // 1. Time display clock
      if (timeDisplayRef.current) {
        timeDisplayRef.current.textContent = fmtClock(t);
      }

      // 2. Slider input value & fill progress bar
      if (sliderRef.current) {
        sliderRef.current.value = String(Math.round(t));
      }
      if (fillTrackRef.current) {
        const pct = (t / 1440) * 100;
        fillTrackRef.current.style.width = `${pct}%`;
      }

      // 3. Trains counter HUD
      if (counterRef.current) {
        const dep = state.departed ?? (state as any).departedCount ?? 0;
        const tot = state.total ?? (state as any).totalTrains ?? 0;
        const verb = direction === "out" ? "Departed" : "Arrived";
        counterRef.current.textContent = `${dep.toLocaleString("en-US")} / ${tot.toLocaleString("en-US")} Trains ${verb}`;
      }

      // 4. Time period / Rush hour badge
      if (rushBadgeRef.current) {
        if (t >= 1440) {
          rushBadgeRef.current.textContent = "Full 24h Day";
          rushBadgeRef.current.className = "ts-badge";
        } else if (t >= 420 && t <= 570) {
          rushBadgeRef.current.textContent = "Morning Rush";
          rushBadgeRef.current.className = "ts-badge ts-badge-rush";
        } else if (t >= 1050 && t <= 1230) {
          rushBadgeRef.current.textContent = "Evening Rush";
          rushBadgeRef.current.className = "ts-badge ts-badge-rush";
        } else if (t < 360) {
          rushBadgeRef.current.textContent = "Night Services";
          rushBadgeRef.current.className = "ts-badge";
        } else {
          rushBadgeRef.current.textContent = "Day Regular";
          rushBadgeRef.current.className = "ts-badge";
        }
      }

      // 5. Flip play button icon only when playing boolean state changes
      if (state.isPlaying !== currentPlayingRef.current) {
        currentPlayingRef.current = state.isPlaying;
        setIsPlaying(state.isPlaying);
      }

      // 6. Sync speed preset button if changed externally
      const spd = state.speed ?? (state as any).speedSec;
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

      if (e.code === "Space") {
        e.preventDefault();
        mapRef.current?.togglePlaying?.();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        const prev = Math.max(0, currentTimeRef.current - 15);
        currentTimeRef.current = prev;
        mapRef.current?.setTime?.(prev);
        if (timeDisplayRef.current) timeDisplayRef.current.textContent = fmtClock(prev);
        if (sliderRef.current) sliderRef.current.value = String(prev);
        if (fillTrackRef.current) fillTrackRef.current.style.width = `${(prev / 1440) * 100}%`;
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        const next = Math.min(1440, currentTimeRef.current + 15);
        currentTimeRef.current = next;
        mapRef.current?.setTime?.(next);
        if (timeDisplayRef.current) timeDisplayRef.current.textContent = fmtClock(next);
        if (sliderRef.current) sliderRef.current.value = String(next);
        if (fillTrackRef.current) fillTrackRef.current.style.width = `${(next / 1440) * 100}%`;
      } else if (e.code === "Home") {
        e.preventDefault();
        currentTimeRef.current = 0;
        mapRef.current?.setTime?.(0);
        if (timeDisplayRef.current) timeDisplayRef.current.textContent = fmtClock(0);
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
    if (timeDisplayRef.current) {
      timeDisplayRef.current.textContent = fmtClock(val);
    }
    if (fillTrackRef.current) {
      fillTrackRef.current.style.width = `${(val / 1440) * 100}%`;
    }
  };

  const handleTogglePlay = () => {
    mapRef.current?.togglePlaying?.();
  };

  const handleSetSpeed = (s: number) => {
    currentSpeedRef.current = s;
    setSpeed(s);
    mapRef.current?.setSpeed?.(s);
  };

  const handleJumpTo = (t: number) => {
    currentTimeRef.current = t;
    mapRef.current?.setTime?.(t);
    if (timeDisplayRef.current) {
      timeDisplayRef.current.textContent = fmtClock(t);
    }
    if (sliderRef.current) {
      sliderRef.current.value = String(t);
    }
    if (fillTrackRef.current) {
      fillTrackRef.current.style.width = `${(t / 1440) * 100}%`;
    }
  };

  return (
    <div
      className={`timeline-scrubber-dock ${dark ? "theme-dark" : "theme-light"}`}
      role="region"
      aria-label="24-hour train flow timeline playback"
    >
      <style>{`
        .timeline-scrubber-dock {
          position: absolute;
          bottom: 22px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 100;
          width: calc(100% - 32px);
          max-width: 760px;
          border-radius: 14px;
          box-sizing: border-box;
          padding: 10px 16px 10px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          user-select: none;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08);
          backdrop-filter: blur(18px);
          -webkit-backdrop-filter: blur(18px);
          transition: background 0.2s ease, border-color 0.2s ease;
        }

        .timeline-scrubber-dock.theme-light {
          background: rgba(246, 245, 241, 0.88);
          border: 1.5px solid rgba(17, 17, 17, 0.18);
          color: #111111;
        }

        .timeline-scrubber-dock.theme-dark {
          background: rgba(26, 27, 30, 0.88);
          border: 1.5px solid rgba(237, 237, 234, 0.22);
          color: #EDEDEA;
        }

        .ts-top-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .ts-left-group {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .ts-play-btn {
          width: 34px;
          height: 34px;
          border-radius: 50%;
          border: none;
          background: var(--rust, #C8302A);
          color: #FFFFFF;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(200, 48, 42, 0.35);
          transition: transform 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
          padding: 0;
          flex-shrink: 0;
        }

        .ts-play-btn:hover {
          transform: scale(1.06);
          background: var(--rust-dark, #8E1B17);
          box-shadow: 0 4px 10px rgba(200, 48, 42, 0.5);
        }

        .ts-play-btn:active {
          transform: scale(0.96);
        }

        .ts-clock {
          font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
          font-size: 21px;
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          letter-spacing: -0.02em;
          line-height: 1;
        }

        .ts-badge {
          font-size: 10.5px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          padding: 2.5px 7px;
          border-radius: 9999px;
          line-height: 1;
          background: rgba(128, 128, 128, 0.15);
          color: var(--ink-soft, #666666);
          transition: all 0.2s ease;
        }

        .ts-badge.ts-badge-rush {
          background: rgba(200, 48, 42, 0.16);
          color: var(--rust, #C8302A);
          border: 1px solid rgba(200, 48, 42, 0.3);
        }

        .ts-right-group {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .ts-counter-wrap {
          font-size: 12.5px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
          color: inherit;
        }

        .ts-speed-control {
          display: flex;
          background: rgba(128, 128, 128, 0.15);
          border-radius: 6px;
          padding: 2px;
          gap: 2px;
        }

        .ts-speed-btn {
          border: none;
          background: transparent;
          font-size: 11px;
          font-weight: 600;
          padding: 3px 7px;
          border-radius: 4px;
          cursor: pointer;
          color: inherit;
          transition: background 0.15s ease, color 0.15s ease;
        }

        .ts-speed-btn.active {
          background: var(--btn-on, #111111);
          color: var(--btn-on-ink, #FFFFFF);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
        }

        .ts-jump-group {
          display: flex;
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
          left: 29.17%;
          width: 10.42%;
          height: 100%;
          background: rgba(227, 166, 63, 0.42);
        }

        .ts-zone-pm {
          position: absolute;
          left: 72.92%;
          width: 12.5%;
          height: 100%;
          background: rgba(227, 166, 63, 0.42);
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
            font-size: 18px;
          }
          .ts-badge {
            display: none;
          }
          .ts-counter-wrap {
            font-size: 11.5px;
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
            06:00
          </span>

          <span ref={rushBadgeRef} className="ts-badge">
            Morning Rush
          </span>
        </div>

        <div className="ts-right-group">
          <div className="ts-counter-wrap">
            <span ref={counterRef}>
              0 / 0 Trains {direction === "out" ? "Departed" : "Arrived"}
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
              title="15 seconds per 24 hours (Fast)"
            >
              15s
            </button>
            <button
              type="button"
              className={`ts-speed-btn ${speed === 30 ? "active" : ""}`}
              onClick={() => handleSetSpeed(30)}
              title="30 seconds per 24 hours (Standard)"
            >
              30s
            </button>
            <button
              type="button"
              className={`ts-speed-btn ${speed === 60 ? "active" : ""}`}
              onClick={() => handleSetSpeed(60)}
              title="60 seconds per 24 hours (Relaxed)"
            >
              60s
            </button>
          </div>

          <div className="ts-jump-group">
            <button
              type="button"
              className="ts-jump-btn"
              onClick={() => handleJumpTo(360)}
              title="Jump to 06:00 (Start of high-speed morning rush)"
            >
              06:00
            </button>
            <button
              type="button"
              className="ts-jump-btn"
              onClick={() => handleJumpTo(0)}
              title="Reset to 00:00 midnight (Home key)"
            >
              00:00
            </button>
          </div>
        </div>
      </div>

      {/* Bottom Slider & Ticks row */}
      <div className="ts-slider-container">
        <div className="ts-slider-track-wrap">
          <div className="ts-track-bg">
            <div className="ts-zone-am" title="Morning Rush Hour (07:00 – 09:30)" />
            <div className="ts-zone-pm" title="Evening Rush Hour (17:30 – 20:30)" />
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
          <span className="ts-tick" onClick={() => handleJumpTo(0)} title="Jump to 00:00">
            00:00
          </span>
          <span
            className="ts-tick ts-tick-highlight"
            onClick={() => handleJumpTo(360)}
            title="Jump to 06:00 (AM Peak)"
          >
            06:00 Peak
          </span>
          <span className="ts-tick" onClick={() => handleJumpTo(720)} title="Jump to 12:00">
            12:00 Midday
          </span>
          <span
            className="ts-tick ts-tick-highlight"
            onClick={() => handleJumpTo(1080)}
            title="Jump to 18:00 (PM Peak)"
          >
            18:00 Peak
          </span>
          <span className="ts-tick" onClick={() => handleJumpTo(1440)} title="Jump to 24:00">
            24:00
          </span>
        </div>
      </div>
    </div>
  );
};

export default TimelineScrubber;
