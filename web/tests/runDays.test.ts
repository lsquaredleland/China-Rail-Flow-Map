// Run-day labels from a train's `days` mask + `pattern` over the pack calendar
// (Fri 23 Oct .. Fri 6 Nov 2026), on real masks of the shipped pack.
import { describe, expect, test } from "bun:test";
import { runDays, runRank } from "../src/lib";

const CAL = [
  "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27",
  "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01",
  "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
];
const label = (mask: string, pattern: string) => runDays(mask, pattern, CAL)!.label;

describe("runDays", () => {
  test("daily", () => {
    expect(label("111111111111111", "daily")).toBe("Daily");
  });
  test("alternate-day", () => {
    expect(label("101010101010101", "alternate-day")).toBe("Every other day");
    expect(label("010101010101010", "alternate-day")).toBe("Every other day");
  });
  test("weekday-set: weekends, ranges (wrapping the week) and lists", () => {
    expect(label("101000010100001", "weekday-set")).toBe("Fri, Sun");
    expect(label("111000011100001", "weekday-set")).toBe("Fri–Sun");
    expect(label("111100011110001", "weekday-set")).toBe("Fri–Mon");
    expect(label("011000001100000", "weekday-set")).toBe("Weekends");
    expect(label("011100001110000", "weekday-set")).toBe("Sat–Mon");
  });
  test("date-specific and irregular are Irregular", () => {
    for (const m of ["111111111000000", "000000000111111", "001000000000000", "111000011100000"]) {
      expect(label(m, "date-specific")).toBe("Irregular");
    }
    expect(label("111111111100001", "irregular")).toBe("Irregular");
    expect(label("011000000110000", "irregular")).toBe("Irregular");
  });
  test("category order: Daily, Weekends, weekday sets, Every other day, Irregular", () => {
    const rank = (m: string, p: string) => runRank({ days: m, pattern: p }, CAL);
    const order = [
      rank("111111111111111", "daily"),
      rank("011000001100000", "weekday-set"),
      rank("111000011100001", "weekday-set"),
      rank("101010101010101", "alternate-day"),
      rank("001000000000000", "date-specific"),
      rank("111111111100001", "irregular"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(5);
    expect(runRank(undefined, CAL)).toBeGreaterThan(order[5]);
  });
  test("no run-day data", () => {
    expect(runDays(undefined, undefined, CAL)).toBeNull();
    expect(runDays("1", "daily", undefined)).toBeNull();
  });
});
