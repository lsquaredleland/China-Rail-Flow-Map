import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { dropDepthPickBuffer } from "../src/components/map/deck/DeckHost";

describe("dropDepthPickBuffer", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  test("is a no-op with a console.warn when the picker has no _resizeBuffer (a deck upgrade)", () => {
    const picker = { device: { isTextureFormatRenderable: () => true } } as never;
    expect(() => dropDepthPickBuffer(picker)).not.toThrow();
    expect((picker as { _resizeBuffer?: unknown })._resizeBuffer).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a null picker is ignored silently", () => {
    expect(() => dropDepthPickBuffer(null)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  test("wraps _resizeBuffer: rgba32float reads as non-renderable only during the call", () => {
    const seen: boolean[] = [];
    const device = { isTextureFormatRenderable: (_f: string) => true };
    const picker = {
      device,
      _resizeBuffer() {
        seen.push(device.isTextureFormatRenderable("rgba32float"), device.isTextureFormatRenderable("rgba8unorm"));
      },
    };
    dropDepthPickBuffer(picker);
    picker._resizeBuffer();
    expect(seen).toEqual([false, true]);
    expect(device.isTextureFormatRenderable("rgba32float")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
