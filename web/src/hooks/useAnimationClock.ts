import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Direction } from "../types";
import type { MapApi } from "../components/MapCanvas";

/* The 24h animation bar: whether it is collapsed and the commands that
   start / stop the clock on the map. The clock itself lives in the map
   engine (components/map/anim.ts). The origin animation is outbound-only,
   so switching to inbound collapses the bar and stops the clock; national
   mode (D13) is an animation in either direction: it starts only when the
   user turns the animation on (`natTrains`), which opens the bar and plays
   from the current minute; turning it off, or leaving national mode,
   collapses the bar and stops the clock. */
export function useAnimationClock(
  mapRef: RefObject<MapApi | null>,
  direction: Direction,
  national: boolean,
  natTrains: boolean,
) {
  const [isTimelineCollapsed, setIsTimelineCollapsed] = useState<boolean>(true);

  const wasNational = useRef(false);
  useEffect(() => {
    if (national) {
      wasNational.current = true;
      setIsTimelineCollapsed(!natTrains);
      mapRef.current?.setAnimEnabled?.(natTrains);
      mapRef.current?.setPlaying?.(natTrains);
    } else if (direction === "in" || wasNational.current) {
      wasNational.current = false;
      setIsTimelineCollapsed(true);
      mapRef.current?.setPlaying?.(false);
      mapRef.current?.setAnimEnabled?.(false);
    }
  }, [direction, national, natTrains, mapRef]);

  const expandTimeline = () => {
    setIsTimelineCollapsed(false);
    mapRef.current?.setAnimEnabled?.(true);
    mapRef.current?.setSpeed?.(30);
    mapRef.current?.setTime?.(360);
    mapRef.current?.setPlaying?.(true);
  };

  const collapseTimeline = () => {
    setIsTimelineCollapsed(true);
    mapRef.current?.setPlaying?.(false);
    mapRef.current?.setAnimEnabled?.(false);
  };

  return { isTimelineCollapsed, expandTimeline, collapseTimeline };
}
