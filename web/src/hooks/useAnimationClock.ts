import { useEffect, useState } from "react";
import type { RefObject } from "react";
import type { Direction } from "../types";
import type { MapApi } from "../components/MapCanvas";

/* The 24h animation bar: whether it is collapsed and the commands that
   start / stop the clock on the map. The clock itself lives in the map
   engine (components/map/anim.ts). The animation is outbound-only, so
   switching to inbound collapses the bar and stops the clock. */
export function useAnimationClock(
  mapRef: RefObject<MapApi | null>,
  direction: Direction,
) {
  const [isTimelineCollapsed, setIsTimelineCollapsed] = useState<boolean>(true);

  useEffect(() => {
    if (direction === "in") {
      setIsTimelineCollapsed(true);
      mapRef.current?.setPlaying?.(false);
      mapRef.current?.setAnimEnabled?.(false);
    }
  }, [direction, mapRef]);

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
