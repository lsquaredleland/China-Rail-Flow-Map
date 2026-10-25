/* The 24h animation clock: play / pause / seek / speed and listeners. */
import type { MapCtx, AnimState, AnimListener } from "./context";
import { getSelCache } from "../../lib";


/* ---------- 24h timeline animation controls ---------- */
export function getAnimState(M: MapCtx): AnimState {
  const { S, P, activeTimeline } = M;
  const st = S.current;
  if (P.current.national) {
    // National mode (D13): no origin timeline, so the clock is one day and
    // wraps; the counters are the dots on the line and the trains drawn.
    return {
      time: st.animTime,
      totalMins: 1440,
      totalDays: 1,
      isPlaying: st.animPlaying,
      speed: st.animSpeed,
      departed: st.natRunning,
      arrived: 0,
      total: st.natN,
      enabled: st.animEnabled,
      national: true,
      running: st.natRunning,
    };
  }
  const cur = P.current.cur;
  const tl = activeTimeline();
  let total = tl ? tl.totalTrains : 0;
  let departed = tl ? tl.getDepartedCount(st.animTime) : 0;
  let arrived = tl ? tl.getArrivedCount(st.animTime) : 0;
  const totalMins = tl ? tl.totalMins : 1440;
  const totalDays = tl ? tl.totalDays : 1;

  const sel = getSelCache(P.current, st);
  const allowedCodes = sel?.allowedCodes ?? null;
  if (allowedCodes && cur && tl) {
    total = allowedCodes.size;
    let depCount = 0;
    let arrCount = 0;
    for (const code of allowedCodes) {
      const pt = tl.getPrepTrain(code);
      if (!pt) continue;
      if (pt.depMins <= st.animTime) depCount++;
      // With a destination chosen a train's journey ends there.
      const endMins = sel?.win?.get(code)?.arrMins ?? pt.arrMins;
      if (endMins <= st.animTime) arrCount++;
    }
    departed = depCount;
    arrived = arrCount;
  }

  return {
    time: st.animTime,
    totalMins,
    totalDays,
    isPlaying: st.animPlaying,
    speed: st.animSpeed,
    departed,
    arrived,
    total,
    enabled: st.animEnabled,
    national: false,
    running: 0,
  };
}


export function notifyAnimListeners(M: MapCtx) {
  const { S } = M;
  const state = getAnimState(M);
  S.current.animListeners.forEach((listener) => {
    try {
      listener(state);
    } catch (err) {
      console.error("AnimListener error:", err);
    }
  });
}


export function animLoop(M: MapCtx, timestamp: number) {
  const { S, activeTimeline } = M;
  const st = S.current;
  if (!st.animPlaying) {
    st.animRafId = null;
    st.lastRafTimestamp = null;
    return;
  }
  const tl = activeTimeline();
  const totalMins = tl ? tl.totalMins : 1440;

  if (st.lastRafTimestamp !== null) {
    const dt = (timestamp - st.lastRafTimestamp) / 1000;
    if (dt > 0 && dt < 2) {
      // Accelerate tail playback (Day 2-3) by 2.5x so watching terminal arrivals stays dynamic
      const tailMult = st.animTime > 1440 ? 2.5 : 1.0;
      const deltaMins = (dt / Math.max(1, st.animSpeed)) * 1440 * tailMult;
      st.animTime = st.animTime + deltaMins;
      if (st.animTime >= totalMins) {
        st.animTime = 0;
      }
      M.render();
      notifyAnimListeners(M);
    }
  }
  st.lastRafTimestamp = timestamp;
  st.animRafId = requestAnimationFrame((ts) => animLoop(M, ts));
}


export function setPlaying(M: MapCtx, playing: boolean) {
  const { S, activeTimeline } = M;
  const st = S.current;
  if (st.animPlaying === playing) return;
  st.animPlaying = playing;
  const tl = activeTimeline();
  const totalMins = tl ? tl.totalMins : 1440;

  if (playing) {
    if (!st.animEnabled) {
      st.animEnabled = true;
    }
    if (st.animTime >= totalMins) {
      st.animTime = 0;
    }
    st.lastRafTimestamp = null;
    if (st.animRafId !== null) {
      cancelAnimationFrame(st.animRafId);
    }
    st.animRafId = requestAnimationFrame((ts) => animLoop(M, ts));
  } else {
    if (st.animRafId !== null) {
      cancelAnimationFrame(st.animRafId);
      st.animRafId = null;
    }
    st.lastRafTimestamp = null;
  }
  notifyAnimListeners(M);
}


export function togglePlaying(M: MapCtx) {
  const { S } = M;
  setPlaying(M, !S.current.animPlaying);
}


export function setTime(M: MapCtx, tMins: number) {
  const { S, activeTimeline } = M;
  const st = S.current;
  const tl = activeTimeline();
  const totalMins = tl ? tl.totalMins : 1440;
  st.animTime = Math.max(0, Math.min(totalMins, tMins));
  M.render();
  notifyAnimListeners(M);
}


export function setSpeed(M: MapCtx, secPerDay: number) {
  const { S } = M;
  S.current.animSpeed = Math.max(1, secPerDay);
  notifyAnimListeners(M);
}


export function setAnimEnabled(M: MapCtx, enabled: boolean) {
  const { S } = M;
  const st = S.current;
  st.animEnabled = enabled;
  M.render();
  notifyAnimListeners(M);
}


export function subscribeAnim(M: MapCtx, listener: AnimListener): () => void {
  const { S } = M;
  S.current.animListeners.add(listener);
  listener(getAnimState(M));
  return () => {
    S.current.animListeners.delete(listener);
  };
}
