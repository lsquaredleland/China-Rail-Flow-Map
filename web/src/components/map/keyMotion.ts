/* Smooth keyboard map motion. Every held key is one motion: it accelerates for
   RAMP ms, then runs at full speed, and after release (never before RAMP) it
   glides to rest with time constant GLIDE. So a tap is one smooth glide of
   about `tap` (an eighth of the view, or one zoom step), a hold is a steady
   pan or zoom, and keys combine (diagonals, pan while zooming). Positions are
   a closed-form function of time, so the frame rate does not change the
   distance. Pure; MapHost drives it from requestAnimationFrame. */

export const RAMP = 150;
export const GLIDE = 120;

/** Distance travelled `t` ms after the key went down, released at `tr` ms
    (null while held), for a motion whose tap covers `tap`. */
export function motionAt(t: number, tr: number | null, tap: number): number {
  // tap = V*RAMP/2 + V*GLIDE  ->  full speed V (per ms)
  const V = tap / (RAMP / 2 + GLIDE);
  const te = tr === null ? Infinity : Math.max(tr, RAMP);
  const ramp = (u: number) => (u <= RAMP ? (V * u * u) / (2 * RAMP) : (V * RAMP) / 2 + V * (u - RAMP));
  if (t <= te) return ramp(t);
  return ramp(te) + V * GLIDE * (1 - Math.exp(-(t - te) / GLIDE));
}

/** True once a released motion has (visibly) come to rest. */
export function motionDone(t: number, tr: number | null): boolean {
  return tr !== null && t - Math.max(tr, RAMP) > 6 * GLIDE;
}

export interface Motion {
  /** Pan direction (unit steps of x, y) or zoom (log factor per tap). */
  dir: [number, number];
  zoom: number;
  t0: number;
  tr: number | null;
  /** Distance already applied (pan: in taps, zoom: in log units). */
  applied: number;
}
