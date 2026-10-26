import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Direction } from "../types";
import type { MapApi } from "../components/MapCanvas";

/** Start the clock at `mins` and play: the animation is enabled, the clock is
    set to the minute, then it runs (setAnimEnabled first, since it sets the
    start time itself). */
export function startPlayback(
  api: { setAnimEnabled?: (on: boolean) => void; setTime?: (m: number) => void; setPlaying?: (on: boolean) => void } | null | undefined,
  mins: number,
): void {
  api?.setAnimEnabled?.(true);
  api?.setTime?.(mins);
  api?.setPlaying?.(true);
}

/* The 24h animation bar: whether it is collapsed and the commands that
   start / stop the clock on the map. The clock itself lives in the map
   engine (components/map/anim.ts). The origin animation is outbound-only,
   so switching to inbound collapses the bar and stops the clock. National
   mode uses the same bar and buttons (an animation in either direction);
   entering or leaving it starts from a stopped clock, and the animation
   starts only when the user presses the expand button. */
export function useAnimationClock(
  mapRef: RefObject<MapApi | null>,
  direction: Direction,
  national: boolean,
) {
  const [isTimelineCollapsed, setIsTimelineCollapsed] = useState<boolean>(true);

  const wasNational = useRef(national);
  useEffect(() => {
    const modeChanged = wasNational.current !== national;
    wasNational.current = national;
    if (direction === "in" || modeChanged) {
      setIsTimelineCollapsed(true);
      mapRef.current?.setPlaying?.(false);
      mapRef.current?.setAnimEnabled?.(false);
    }
  }, [direction, national, mapRef]);

  const expandTimeline = () => {
    setIsTimelineCollapsed(false);
    // Turning the animation on sets its start time (anim.ts animStartMins).
    mapRef.current?.setAnimEnabled?.(true);
    mapRef.current?.setSpeed?.(30);
    mapRef.current?.setPlaying?.(true);
  };

  // "Play from origin": open the bar and run the clock from this minute.
  const playFrom = (mins: number) => {
    setIsTimelineCollapsed(false);
    startPlayback(mapRef.current, mins);
  };

  const collapseTimeline = () => {
    setIsTimelineCollapsed(true);
    mapRef.current?.setPlaying?.(false);
    mapRef.current?.setAnimEnabled?.(false);
  };

  return { isTimelineCollapsed, expandTimeline, collapseTimeline, playFrom };
}
