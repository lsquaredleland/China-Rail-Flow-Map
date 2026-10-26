/* Screen-reader live region for national mode's 24h animation (R5 / P2.4).
   Visually hidden, aria-live="polite". Announces the distinct trains on the
   line ("2,726 trains running at 18:15"): at most once per ANNOUNCE_GAP_MS
   while playing, and on pause or seek (after a short settle, so a dragged
   scrubber says one thing and the map's frame has landed). Origin view: silent. */
import { useEffect, useRef, type RefObject } from "react";
import type { MapApi } from "./MapHost";
import { fmtClock } from "../lib";

const ANNOUNCE_GAP_MS = 30000;
const SETTLE_MS = 400;

export default function AnimAnnouncer({
  mapRef,
  national,
}: {
  mapRef: RefObject<MapApi | null>;
  national: boolean;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const api = mapRef.current;
    const el = elRef.current;
    if (el) el.textContent = "";
    if (!national || !api || !el) return;
    let lastAt = -Infinity;
    let lastTime = -1;
    let wasPlaying = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const say = () => {
      timer = null;
      const s = api.getAnimState();
      if (!s.national || !s.total) return; // the trains are not drawn yet
      const n = s.running;
      el.textContent = `${n.toLocaleString("en-US")} ${n === 1 ? "train" : "trains"} running at ${fmtClock(Math.floor(s.time))}`;
      lastAt = performance.now();
    };
    const unsub = api.subscribeAnim((s) => {
      const moved = Math.abs(s.time - lastTime) > 1e-6;
      lastTime = s.time;
      if (s.isPlaying) {
        if (timer === null && performance.now() - lastAt >= ANNOUNCE_GAP_MS) say();
      } else if (wasPlaying || moved) {
        // Pause, or a seek while paused: say it once the dragging stops.
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(say, SETTLE_MS);
      }
      wasPlaying = s.isPlaying;
    });
    return () => {
      unsub();
      if (timer !== null) clearTimeout(timer);
    };
  }, [mapRef, national]);
  return <div ref={elRef} className="sr-only" role="status" aria-live="polite" aria-atomic="true" />;
}
