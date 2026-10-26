// Owner trial (removable with the feature): ?zoomwidth=sqrt damps flow widths past x3.
import { afterEach, describe, expect, test } from "bun:test";
import { ZOOM_WIDTH_KNEE, flowWidth, setZoomWidthDamped, zoomWidthScale } from "../src/lib";

describe("zoom width damping (trial)", () => {
  afterEach(() => setZoomWidthDamped(false));

  test("off by default: widths stay proportional to zoom", () => {
    expect(zoomWidthScale(10)).toBe(1);
    expect(flowWidth(100, 1000, 100)).toBeCloseTo(10 * flowWidth(100, 100, 100), 9);
  });

  test("on: unchanged up to the knee, then grows with the square root", () => {
    setZoomWidthDamped(true);
    expect(zoomWidthScale(1)).toBe(1);
    expect(zoomWidthScale(ZOOM_WIDTH_KNEE)).toBe(1);
    const at = (r: number) => r * zoomWidthScale(r); // effective growth vs the fit
    expect(at(10)).toBeCloseTo(Math.sqrt(30), 9); // ~5.5x instead of 10x
    expect(at(30)).toBeCloseTo(Math.sqrt(90), 9); // ~9.5x instead of 30x
    for (let r = 1; r < 60; r += 0.5) expect(at(r + 0.5)).toBeGreaterThan(at(r)); // still widens
    expect(flowWidth(100, 1000, 100)).toBeCloseTo(flowWidth(100, 100, 100) * Math.sqrt(30), 9);
  });
});
