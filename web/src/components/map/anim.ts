/* The 24h animation clock: play / pause / seek / speed and listeners. */
import type { MapCtx, AnimState, AnimListener } from "./context";
import { getSelCache } from "../../lib";


/* ---------- 24h timeline animation controls ---------- */

/** Where the clock starts (and wraps back to): midnight in national mode;
    for an origin, the first departure of the trains on show: those to the
    selected city when one is selected, else the whole (filtered) timeline. */
function animStartMins(M: MapCtx): number {
  if (M.P.current.national) return 0;
  const tl = M.activeTimeline();
  if (!tl) return 0;
  const allowed = getSelCache(M.P.current, M.S.current)?.allowedCodes;
  if (allowed && allowed.size) {
    let first = Infinity;
    for (const code of allowed) {
      const pt = tl.getPrepTrain(code);
      if (pt && pt.depMins < first) first = pt.depMins;
    }
    if (isFinite(first)) return Math.floor(first);
  }
  return Math.floor(tl.firstDepMins);
}

/** The isolated train's run on the clock, or null when no train is isolated: from its departure
    (origin view) or first stop (national) for `dur` minutes. The national clock is one wrapping day. */
function isoRun(M: MapCtx): { start: number; dur: number; wrap: boolean } | null {
  const code = M.P.current.isolatedTrainCode;
  if (!code) return null;
  if (M.P.current.national) {
    const r = M.S.current.natLoop;
    return r && r.dur > 0 ? { start: ((r.start % 1440) + 1440) % 1440, dur: r.dur, wrap: true } : null;
  }
  const pt = M.activeTimeline()?.getPrepTrain(code);
  return pt && pt.arrMins > pt.depMins ? { start: pt.depMins, dur: pt.arrMins - pt.depMins, wrap: false } : null;
}

/** Where the clock goes `deltaMins` after `t` when an isolated train passes its final stop: back
    to its start. Null when no train is isolated or the train is not mid-run. */
export function isoLoopTime(M: MapCtx, t: number, deltaMins: number): number | null {
  const run = isoRun(M);
  if (!run) return null;
  const e = run.wrap ? (((t - run.start) % 1440) + 1440) % 1440 : t - run.start;
  return e >= 0 && e < run.dur && e + deltaMins >= run.dur ? run.start : null;
}

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
      const looped = isoLoopTime(M, st.animTime, deltaMins);
      st.animTime = looped ?? st.animTime + deltaMins;
      if (looped === null && st.animTime >= totalMins) {
        st.animTime = animStartMins(M);
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
      st.animTime = animStartMins(M);
    }
    if (st.animTime >= totalMins) {
      st.animTime = animStartMins(M);
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
  if (enabled && !st.animEnabled) st.animTime = animStartMins(M);
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
