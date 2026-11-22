// components/map/camera: keyboard map control (arrows / WASD pan, +/- zoom; Shift is the timeline's).
import { describe, expect, test } from "bun:test";
import { mapKeyAction } from "../src/components/map/camera";

const k = (key: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
  mapKeyAction({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods });

describe("map keys", () => {
  test("arrows and WASD pan", () => {
    expect(k("ArrowLeft")).toEqual({ pan: [-1, 0] });
    expect(k("a")).toEqual({ pan: [-1, 0] });
    expect(k("ArrowRight")).toEqual({ pan: [1, 0] });
    expect(k("D")).toEqual({ pan: [1, 0] });
    expect(k("ArrowUp")).toEqual({ pan: [0, -1] });
    expect(k("w")).toEqual({ pan: [0, -1] });
    expect(k("ArrowDown")).toEqual({ pan: [0, 1] });
    expect(k("s")).toEqual({ pan: [0, 1] });
  });
  test("+ and - zoom", () => {
    expect(k("=")).toEqual({ zoom: 1.45 });
    expect(k("+", { shiftKey: true })).toEqual({ zoom: 1.45 });
    expect(k("-")).toEqual({ zoom: 1 / 1.45 });
  });
  test("modifiers and other keys are not map keys", () => {
    expect(k("ArrowLeft", { shiftKey: true })).toBeNull(); // the timeline's
    expect(k("s", { metaKey: true })).toBeNull();
    expect(k("a", { ctrlKey: true })).toBeNull();
    expect(k("x")).toBeNull();
    expect(k(" ")).toBeNull();
  });
});

import { GLIDE, RAMP, motionAt, motionDone } from "../src/components/map/keyMotion";

describe("key motion", () => {
  test("a tap glides about one tap and stops", () => {
    expect(motionAt(0, 30, 1)).toBe(0);
    const end = motionAt(RAMP + 10 * GLIDE, 30, 1);
    expect(end).toBeGreaterThan(0.99);
    expect(end).toBeLessThanOrEqual(1);
    expect(motionDone(RAMP + 10 * GLIDE, 30)).toBe(true);
    expect(motionDone(RAMP, 30)).toBe(false);
  });
  test("holding runs at a steady speed, smoothly", () => {
    const v1 = motionAt(1000, null, 1) - motionAt(900, null, 1);
    const v2 = motionAt(2000, null, 1) - motionAt(1900, null, 1);
    expect(Math.abs(v1 - v2)).toBeLessThan(1e-9);
    // continuous at the ramp's end and at release
    expect(Math.abs(motionAt(RAMP + 1e-6, null, 1) - motionAt(RAMP, null, 1))).toBeLessThan(1e-6);
    expect(Math.abs(motionAt(800 + 1e-6, 800, 1) - motionAt(800, 800, 1))).toBeLessThan(1e-6);
    expect(motionDone(800, null)).toBe(false);
  });
  test("distance does not depend on frame timing", () => {
    expect(motionAt(500, 300, 2)).toBeCloseTo(2 * motionAt(500, 300, 1), 12);
  });
});
