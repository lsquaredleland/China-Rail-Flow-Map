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
