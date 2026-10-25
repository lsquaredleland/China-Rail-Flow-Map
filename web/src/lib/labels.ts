/* City-label placement: which labels appear and where, with collision care.
   Labels are off by default; the origin's own name is always placed.
   When labels are on, the candidate set stays sparse: at the national
   view only the top ~22 destinations by trains/day, plus every
   substantial route terminus (5+ trains ending there) — and the
   collision pass, not the candidate list, decides which of those
   actually appear, so the result is never a wall of names. Zooming
   in admits progressively smaller cities; every candidate still has
   to win a collision-free spot, and unplaced termini get smaller /
   stepped-out last tries. Pure: text measuring is injected. */
import type { CityPointVM } from "../types";
import { stationR, stationZoomK } from "./palette";

export interface LabelStyle {
  fs: number;
  weight: string;
  pad: number;
  off: number;
  far?: boolean;
  isBoxed?: boolean;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedLabel {
  text: string;
  /** Text anchor (canvas textAlign = align). */
  x: number;
  y: number;
  align: "left" | "right" | "center";
  box: Box;
  style: LabelStyle;
}

export interface LabelOptions {
  origin: { zh: string; en: string; pt: [number, number] };
  panelDest: { zh: string; en: string; pt: [number, number]; trains: number } | null;
  /** Destination labels on; off leaves only the origin (and selected city). */
  showDest: boolean;
  fitScale: number;
  /** stationT of the current zoom. */
  sk: number;
}

/** `measure(text, fs, weight)` is the rendered text width in px. */
export type Measure = (text: string, fs: number, weight: string) => number;

export function placeLabels(
  points: CityPointVM[],
  view: { scale: number; tx: number; ty: number },
  W: number,
  H: number,
  measure: Measure,
  opts: LabelOptions,
): PlacedLabel[] {
  const { origin, panelDest, showDest, fitScale, sk } = opts;
  const X = (lon: number) => lon * view.scale + view.tx;
  const Y = (lat: number) => -lat * view.scale + view.ty;
  const out: PlacedLabel[] = [];
  const placed: Box[] = [];
  function hits(box: Box) {
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      if (
        box.x < p.x + p.w &&
        box.x + box.w > p.x &&
        box.y < p.y + p.h &&
        box.y + box.h > p.y
      )
        return true;
    }
    return false;
  }
  function place(
    c: { zh: string; en: string; pt: [number, number] },
    style: LabelStyle,
  ): boolean {
    const x = X(c.pt[0]),
      y = Y(c.pt[1]);
    if (x < -90 || x > W + 90 || y < -30 || y > H + 30) return false;
    const text = c.en + " · " + c.zh;
    const fs = style.fs;
    const tw = measure(text, fs, style.weight);
    const r = style.off;
    const dyD = r + fs * 0.72;
    let offs: { dx: number; dy: number; align: "left" | "right" | "center" }[];
    if (style.far) {
      // Last-resort ring: labels for termini whose dot is a few pixels
      // from a big neighbour's dot (Hong Kong beside Shenzhen) — the
      // label steps ~30 px out into open space, still collision-checked.
      const R = 30;
      offs = [
        { dx: R * 0.75, dy: R * 0.75, align: "left" },
        { dx: R * 0.75, dy: -R * 0.75, align: "left" },
        { dx: -R * 0.75, dy: R * 0.75, align: "right" },
        { dx: -R * 0.75, dy: -R * 0.75, align: "right" },
        { dx: R, dy: 0, align: "left" },
        { dx: -R, dy: 0, align: "right" },
        { dx: 0, dy: R, align: "center" },
        { dx: 0, dy: -R, align: "center" },
      ];
    } else {
      offs = [
        { dx: r + 4, dy: 0, align: "left" },
        { dx: -(r + 4), dy: 0, align: "right" },
        { dx: 0, dy: -(r + fs * 0.75), align: "center" },
        { dx: 0, dy: r + fs * 0.75, align: "center" },
        { dx: r + 3, dy: dyD, align: "left" },
        { dx: r + 3, dy: -dyD, align: "left" },
        { dx: -(r + 3), dy: dyD, align: "right" },
        { dx: -(r + 3), dy: -dyD, align: "right" },
      ];
    }
    for (let i = 0; i < offs.length; i++) {
      const o = offs[i];
      const bx =
        o.align === "left"
          ? x + o.dx
          : o.align === "right"
            ? x + o.dx - tw
            : x + o.dx - tw / 2;
      const box = {
        x: bx - 1.5 - style.pad,
        y: y + o.dy - fs * 0.62 - style.pad * 0.4,
        w: tw + 3 + style.pad * 2,
        h: fs * 1.24 + style.pad * 0.8,
      };
      if (box.x < 2 || box.x + box.w > W - 2) continue;
      if (hits(box)) continue;
      placed.push(box);
      out.push({ text, x: x + o.dx, y: y + o.dy, align: o.align, box, style });
      return true;
    }
    return false;
  }
  const off = (t: { trains: number }, extra: number) =>
    stationR(t.trains) * stationZoomK(stationR(t.trains), sk) + extra;

  // The origin first, so its label always wins a spot — and it is the
  // only label drawn while destination labels are toggled off.
  place(origin, { fs: 13, weight: "700", pad: 5, off: 13, isBoxed: true });
  if (panelDest) {
    place(panelDest, { fs: 12.5, weight: "700", pad: 5, off: off(panelDest, 5), isBoxed: true });
  }
  if (!showDest) return out;
  // Candidate set by zoom (points are already sorted by trains/day).
  // "Termini" here are route ends in the current direction: trains
  // ending at the city outbound, starting there inbound.
  const all = points;
  const ratio = view.scale / fitScale;
  const cands: CityPointVM[] = [];
  let j: number;
  let c: CityPointVM;
  if (ratio < 2) {
    for (j = 0; j < all.length && cands.length < 22; j++)
      cands.push(all[j]);
    // Every substantial terminus joins the candidates, however far
    // down the trains list it sits — whether it is actually drawn is
    // decided by the collision pass, not by a candidate cap, so a
    // terminus in open country (Beijing) is never crowded out by
    // candidates that were only ever going to collide near the origin.
    for (j = 0; j < all.length; j++) {
      c = all[j];
      if (c.endpoint >= 5 && cands.indexOf(c) === -1) cands.push(c);
    }
  } else if (ratio < 5) {
    for (j = 0; j < all.length; j++) {
      c = all[j];
      if (c.trains >= 15 || (c.endpoint >= 1 && c.trains >= 6))
        cands.push(c);
    }
  } else if (ratio < 14) {
    for (j = 0; j < all.length; j++) {
      c = all[j];
      if (c.trains >= 5 || (c.endpoint >= 1 && c.trains >= 3))
        cands.push(c);
    }
  } else {
    cands.push(...all);
  }
  // Within a size tier, termini go first, and the most squeezed
  // terminus of the tier goes before its neighbours (Hong Kong's dot
  // sits ~5 px from Shenzhen's at national scale).
  function tier(c2: CityPointVM) {
    return c2.trains >= 50 ? 0 : c2.trains >= 20 ? 1 : 2;
  }
  cands.sort((a, b) => {
    const ta = tier(a),
      tb = tier(b);
    if (ta !== tb) return ta - tb;
    const ea = a.endpoint >= 1 ? 0 : 1,
      eb = b.endpoint >= 1 ? 0 : 1;
    if (ea !== eb) return ea - eb;
    if (ea === 0 && a.nn !== b.nn) return a.nn - b.nn;
    return b.trains - a.trains;
  });
  const unplacedTermini: CityPointVM[] = [];
  for (let k = 0; k < cands.length; k++) {
    const t = cands[k];
    let ok: boolean;
    if (t.trains >= 50)
      ok = place(t, { fs: 14, weight: "700", pad: 4, off: off(t, 2) });
    else if (t.trains >= 20)
      ok = place(t, { fs: 12, weight: "600", pad: 2.5, off: off(t, 2) });
    else if (t.trains >= 5)
      ok = place(t, { fs: 11, weight: "600", pad: 2, off: off(t, 2) });
    else ok = place(t, { fs: 11, weight: "", pad: 2, off: off(t, 2) });
    if (!ok && t.endpoint >= 1) unplacedTermini.push(t);
  }
  // Candidates that lost every spot at full size and end routes get
  // two last tries a touch smaller, the second stepped ~30 px out
  // into open space — a terminus label matters more than its size.
  for (let k = 0; k < unplacedTermini.length; k++) {
    const u = unplacedTermini[k];
    if (!place(u, { fs: 10.5, weight: "600", pad: 1.2, off: off(u, 1.5) })) {
      place(u, { fs: 10.5, weight: "600", pad: 1.2, off: off(u, 1.5), far: true });
    }
  }
  return out;
}
