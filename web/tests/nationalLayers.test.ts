// National-mode deck layers (P2.2): the frame buffers from natPositions, the
// layer props, and the ?natSynth load. No GPU.
import { describe, expect, test } from "bun:test";
import { natPositions } from "../src/lib";
import type { NationalTrainsData } from "../src/types";
import { maxDots, nationalFrame, nationalLayers, nationalTimeline, synthNational } from "../src/components/map/deck/layers/national";
import { glowOf } from "../src/components/map/deck/layers/trains";
import { nationalTrains, pack } from "./fixture";

const { atlas } = pack();
const data: NationalTrainsData = { trains: nationalTrains().data, schedules: atlas.schedules! };
const { tl } = nationalTimeline(atlas, data)!;

describe("national layers", () => {
  test("the timeline is built once per (atlas, file)", () => {
    expect(nationalTimeline(atlas, data)!.tl).toBe(tl);
    expect(nationalTimeline(atlas, null)).toBeNull();
  });

  test("frame: every dot coloured by class, tails for movers, rings for dwellers", () => {
    const f = nationalFrame(tl, atlas, 1095, 100);
    const ref = new Float32Array(maxDots(tl) * 6);
    expect(f.count).toBe(natPositions(tl, atlas, 1095, ref));
    expect(f.buf.length).toBeGreaterThanOrEqual(f.count * 6);
    let dwell = 0, moving = 0;
    for (let i = 0; i < f.count; i++) {
      const flags = f.buf[i * 6 + 5];
      const g = glowOf(["G", "K", ""][flags & 15]);
      expect([...f.line.subarray(i * 4, i * 4 + 4)]).toEqual([g[0], g[1], g[2], 255]);
      if (flags & 16) dwell++;
      else if (Math.round(12 * f.buf[i * 6 + 4]) > 0) moving++;
    }
    expect(f.dwellCount).toBe(dwell);
    expect(f.tailCount).toBe(moving);
    expect(dwell).toBeGreaterThan(0);
    expect(moving).toBeGreaterThan(0);
    // a tail ends at its dot and is at most 12 px long at scale 100
    const L = Math.hypot(f.tailTgt[0] - f.tailSrc[0], f.tailTgt[1] - f.tailSrc[1]) * 100;
    expect(L).toBeLessThanOrEqual(12.001);
  });

  test("layers: strided dot positions, pickable only when asked", () => {
    const f = nationalFrame(tl, atlas, 1095, 100);
    const [tails, dots, rings] = nationalLayers(f, false);
    expect([tails.id, dots.id, rings.id]).toEqual(["nat-tails", "nat-trains", "nat-dwell"]);
    const pos = (dots.props.data as { attributes: { getPosition: { stride: number; value: Float32Array } } }).attributes.getPosition;
    expect([pos.stride, pos.value]).toEqual([24, f.buf]);
    expect(dots.props.pickable).toBe(false);
    expect(nationalLayers(f, true)[1].props.pickable).toBe(true);
    expect(tails.props.pickable).toBe(false);
  });

  test("natSynth: copies shifted by 37 min, positions of the originals unchanged", () => {
    const s = synthNational(tl, tl.n * 2 + 5);
    expect(s.n).toBe(tl.n * 2 + 5);
    expect(s.start[tl.n]).toBe(tl.start[0] + 37);
    expect(s.end[2 * tl.n + 4]).toBe(tl.end[4] + 74);
    const a = new Float32Array(maxDots(s) * 6), b = new Float32Array(maxDots(tl) * 6);
    // copy k at m + 37k is the original at m
    const ca = natPositions(s, atlas, 600, a);
    const cb = natPositions(tl, atlas, 600, b);
    expect(ca).toBeGreaterThan(cb);
    expect([...a.subarray(0, cb * 6)]).toEqual([...b.subarray(0, cb * 6)]);
    expect(synthNational(tl, tl.n)).toBe(tl);
  });
});
