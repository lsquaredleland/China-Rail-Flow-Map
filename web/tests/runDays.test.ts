// Run-day words from a train's `days` mask + `pattern` over the pack calendar
// (Fri 23 Oct .. Fri 6 Nov 2026), on real masks of the shipped pack.
import { describe, expect, test } from "bun:test";
import { runCount, runDays } from "../src/lib";

const CAL = [
  "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27",
  "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01",
  "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
];
const r = (mask: string, pattern: string) => runDays(mask, pattern, CAL)!;

describe("runDays", () => {
  test("daily", () => {
    const x = r("111111111111111", "daily");
    expect([x.label, x.count, x.total]).toEqual(["Daily", 15, 15]);
  });
  test("alternate-day", () => {
    const x = r("101010101010101", "alternate-day");
    expect([x.label, x.count]).toEqual(["Every other day", 8]);
    expect(r("010101010101010", "alternate-day").count).toBe(7);
  });
  test("weekday-set names the weekdays", () => {
    expect(r("101000010100001", "weekday-set").label).toBe("Fri, Sun");
    expect(r("111000011100001", "weekday-set").label).toBe("Fri–Sun");
    expect(r("111100011110001", "weekday-set").label).toBe("Fri–Mon");
  });
  test("date-specific: block at the start, block at the end, few dates, many dates", () => {
    expect(r("111111111000000", "date-specific").label).toBe("Until 31 Oct");
    expect(r("000000000111111", "date-specific").label).toBe("From 1 Nov");
    expect(r("001000000000000", "date-specific").label).toBe("25 Oct");
    expect(r("101001000000000", "date-specific").label).toBe("23, 25, 28 Oct");
    expect(r("100000010010000", "date-specific").label).toBe("23 Oct, 30 Oct, 2 Nov");
    expect(r("111000011100000", "date-specific").label).toBe("6 dates");
  });
  test("irregular: mostly a weekday set, else a count", () => {
    expect(r("111111111100001", "irregular").label).toBe("Mostly Fri–Sun");
    expect(r("111000011100000", "irregular").label).toBe("Mostly Fri–Sun");
    expect(r("011000000110000", "irregular").label).toBe("4 of 15 days");
  });
  test("count and tooltip", () => {
    expect(runCount("111111111100001")).toBe(11);
    expect(r("001000000000000", "date-specific").title).toBe("Sun 25 Oct");
  });
  test("no run-day data", () => {
    expect(runDays(undefined, undefined, CAL)).toBeNull();
    expect(runDays("1", "daily", undefined)).toBeNull();
  });
});
