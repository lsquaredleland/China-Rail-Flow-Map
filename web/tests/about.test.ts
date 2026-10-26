import { describe, expect, test } from "bun:test";
import { aboutText } from "../src/data";

const OLD_TAIL =
  "Timetable data is sourced from China Railway (12306), covering the passenger trains listed as running on at least one date from 23 October to 6 November 2026.";
const CAL = ["2026-10-23", "2026-10-24", "2026-11-06"];

describe("footer about text", () => {
  test("derives the window from shared.calendar when the pack has no about", () => {
    expect(aboutText({ calendar: CAL }).endsWith(OLD_TAIL)).toBe(true);
  });

  test("prefers the pack's own source sentence", () => {
    const source = "Timetable data is sourced from the pack.";
    const t = aboutText({ calendar: CAL, about: { source, from: "2026-10-23", to: "2026-11-06" } });
    expect(t.endsWith(source)).toBe(true);
    expect(t).not.toContain("23 October");
  });

  test("names only the source without a calendar (12306 packs)", () => {
    expect(aboutText({}).endsWith("Timetable data is sourced from China Railway (12306).")).toBe(true);
  });

  test("a window across a year boundary names both years", () => {
    const t = aboutText({ calendar: ["2026-12-30", "2027-01-02"] });
    expect(t.endsWith("from 30 December 2026 to 2 January 2027.")).toBe(true);
  });
});
