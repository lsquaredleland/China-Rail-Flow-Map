/* Hit-test priority, pure. The deck renderer's GPU picking yields a handful of
   candidates near the cursor; this decides which one wins by recomputing the
   exact screen distances, with the order and tie rules of the former Canvas picker:

     train (14 px, paused only) > station (14·zoomK) / origin (15 px, origin
     wins ties) > section (10 px, a busier section wins within ±0.75 px) >
     chord (10 px, outbound, no destination selected)

   Candidates carry geometry in lon/lat; `view` is the camera (px = lon·scale +
   tx, py = −lat·scale + ty). `index` is the candidate's rank in the Canvas
   iteration order (points() / pickableFlows / activeTrains), which decides
   exact ties. */

export type PickKind = "train" | "station" | "origin" | "section" | "chord";

export interface PickLine {
  /** lon, lat pairs: a polyline at pts[off .. off + 2·count). */
  pts: ArrayLike<number>;
  off: number;
  count: number;
}

export interface PickCandidate {
  kind: PickKind;
  index: number;
  /** Train count (sections: the busier one wins a near tie). */
  n?: number;
  /** Point candidates (train, station, origin): lon/lat. */
  pos?: [number, number];
  /** Section and chord candidates. */
  line?: PickLine;
  /** Hit radius in px; defaults: train 14, station 14, origin 15, section/chord 10. */
  radius?: number;
  /** Pre-computed screen distance; wins over the geometry (tests, callers that measured). */
  distance?: number;
}

export interface PickView {
  scale: number;
  tx: number;
  ty: number;
}

export interface PickOptions {
  /** Trains are pickable only while the clock is paused. Default true. */
  paused?: boolean;
  /** Chords are pickable only outbound. Default "out". */
  direction?: "out" | "in";
  /** A destination (city pair) is selected: chords are not pickable. Default false. */
  destSelected?: boolean;
}

/** Slop within which the busier of two sections wins, px. */
export const SEG_TIE_PX = 0.75;
export const TRAIN_RADIUS = 14;
export const STATION_RADIUS = 14;
export const ORIGIN_RADIUS = 15;
export const SEG_RADIUS = 10;

export function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px,
    ey = ay + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Minimum screen distance from (px, py) to a lon/lat polyline under `view`. */
export function distToLine(px: number, py: number, line: PickLine, view: PickView): number {
  const { pts, off, count } = line;
  const { scale, tx, ty } = view;
  let best = Infinity;
  for (let k = 0; k + 1 < count; k++) {
    const i = off + k * 2;
    const d = distToSeg(
      px,
      py,
      pts[i] * scale + tx,
      -pts[i + 1] * scale + ty,
      pts[i + 2] * scale + tx,
      -pts[i + 3] * scale + ty,
    );
    if (d < best) best = d;
  }
  return best;
}

function distanceOf(c: PickCandidate, px: number, py: number, view: PickView): number {
  if (c.distance !== undefined) return c.distance;
  if (c.pos) return Math.hypot(px - (c.pos[0] * view.scale + view.tx), py - (-c.pos[1] * view.scale + view.ty));
  if (c.line) return distToLine(px, py, c.line, view);
  return Infinity;
}

/** The winning candidate, or null. `view` may be omitted when every candidate carries `distance`. */
export function pickPriority(
  candidates: readonly PickCandidate[],
  px: number,
  py: number,
  view: PickView = { scale: 1, tx: 0, ty: 0 },
  opts: PickOptions = {},
): PickCandidate | null {
  const paused = opts.paused ?? true;
  const dir = opts.direction ?? "out";
  // Sections with geometry are walked segment by segment below, not reduced to a distance here.
  const dist = candidates.map((c) =>
    c.kind === "section" && c.distance === undefined && c.line ? Infinity : distanceOf(c, px, py, view),
  );

  // 1. train: nearest within its radius (the lowest index wins an exact tie: Canvas takes the first).
  if (paused) {
    let best: PickCandidate | null = null;
    let bd = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (c.kind !== "train") continue;
      const d = dist[i];
      if (d < (c.radius ?? TRAIN_RADIUS) && (d < bd || (d === bd && best !== null && c.index < best.index))) {
        bd = d;
        best = c;
      }
    }
    if (best) return best;
  }

  // 2. station (nearest within its own radius; the later one wins an exact tie) vs origin (wins ties).
  {
    let st: PickCandidate | null = null;
    let sd = Infinity;
    let org: PickCandidate | null = null;
    let od = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const d = dist[i];
      if (c.kind === "station") {
        if (d <= (c.radius ?? STATION_RADIUS) && (d < sd || (d === sd && st !== null && c.index > st.index))) {
          st = c;
          sd = d;
        }
      } else if (c.kind === "origin") {
        if (d <= (c.radius ?? ORIGIN_RADIUS) && (org === null || d < od)) {
          org = c;
          od = d;
        }
      }
    }
    if (org && (st === null || od <= sd)) return org;
    if (st) return st;
  }

  // 3. section: nearest, but a busier section within ±0.75 px of the best takes over.
  //    Walked exactly as Canvas does: candidates in `index` order and, within one, its segments in
  //    order, each segment updating the running best. That makes the best "sticky" inside a polyline
  //    (a later segment must be 0.75 px nearer than the one that set it), so the polyline minimum is
  //    not enough. The first section must also be nearer than 9.25 px.
  let best: PickCandidate | null = null;
  let bd = SEG_RADIUS;
  const secs: number[] = [];
  for (let i = 0; i < candidates.length; i++) if (candidates[i].kind === "section") secs.push(i);
  secs.sort((a, b) => candidates[a].index - candidates[b].index);
  const step = (c: PickCandidate, d: number) => {
    const busier = best !== null && (c.n ?? 0) > (best.n ?? 0);
    if ((d < bd - SEG_TIE_PX || (d <= bd + SEG_TIE_PX && busier)) && (d < bd || busier)) {
      best = c;
      bd = Math.min(d, bd);
    }
  };
  for (const i of secs) {
    const c = candidates[i];
    if (c.distance === undefined && c.line) {
      const { pts, off, count } = c.line;
      const { scale, tx, ty } = view;
      for (let k = 0; k + 1 < count; k++) {
        const j = off + k * 2;
        step(
          c,
          distToSeg(px, py, pts[j] * scale + tx, -pts[j + 1] * scale + ty, pts[j + 2] * scale + tx, -pts[j + 3] * scale + ty),
        );
      }
    } else step(c, dist[i]);
  }
  if (best) return best;

  // 4. chord: only when nothing else hit, outbound, and no destination selected.
  if (dir !== "out" || opts.destSelected) return null;
  let cb: PickCandidate | null = null;
  let cd = SEG_RADIUS;
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].kind !== "chord") continue;
    if (dist[i] < cd || (dist[i] === cd && cb !== null && candidates[i].index < cb.index)) {
      cd = dist[i];
      cb = candidates[i];
    }
  }
  return cb;
}
