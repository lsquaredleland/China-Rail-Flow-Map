// Owner trial (removable with the feature): the Zoom clarity toggle damps flow widths past x3.
import { describe, expect, test } from "bun:test";
import { ZOOM_WIDTH_KNEE, flowWidth, zoomWidthScale } from "../src/lib";

describe("zoom width damping (trial)", () => {

  test("off by default: widths stay proportional to zoom", () => {
    expect(zoomWidthScale(10)).toBe(1);
    expect(flowWidth(100, 1000, 100)).toBeCloseTo(10 * flowWidth(100, 100, 100), 9);
  });

  test("on: unchanged up to the knee, then grows with the square root", () => {
    expect(zoomWidthScale(1, true)).toBe(1);
    expect(zoomWidthScale(ZOOM_WIDTH_KNEE, true)).toBe(1);
    const at = (r: number) => r * zoomWidthScale(r, true); // effective growth vs the fit
    expect(at(10)).toBeCloseTo(Math.sqrt(30), 9); // ~5.5x instead of 10x
    expect(at(30)).toBeCloseTo(Math.sqrt(90), 9); // ~9.5x instead of 30x
    for (let r = 1; r < 60; r += 0.5) expect(at(r + 0.5)).toBeGreaterThan(at(r)); // still widens
    expect(flowWidth(100, 1000, 100, true)).toBeCloseTo(flowWidth(100, 100, 100) * Math.sqrt(30), 9);
  });
});
