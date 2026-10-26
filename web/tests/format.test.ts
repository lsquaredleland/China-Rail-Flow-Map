import { describe, expect, test } from "bun:test";
import { fmtDurationWords, stationName } from "../src/lib";

describe("stationName", () => {
  test("the three orders", () => {
    expect(stationName("重庆北", "Chongqing North", "zh-en")).toBe("重庆北 Chongqing North");
    expect(stationName("武昌", "Wuchang", "en-zh")).toBe("Wuchang 武昌");
    expect(stationName("武昌", "Wuchang", "zh-paren")).toBe("武昌 (Wuchang)");
  });
  test("one name when the English is missing or identical", () => {
    for (const order of ["zh-en", "en-zh", "zh-paren"] as const) {
      expect(stationName("北京", "北京", order)).toBe("北京");
      expect(stationName("北京", undefined, order)).toBe("北京");
      expect(stationName("北京", "", order)).toBe("北京");
    }
  });
});

describe("fmtDurationWords", () => {
  test("minutes, whole hours, hours and minutes", () => {
    expect(fmtDurationWords(0)).toBe("0 min");
    expect(fmtDurationWords(45)).toBe("45 min");
    expect(fmtDurationWords(60)).toBe("1 h");
    expect(fmtDurationWords(65)).toBe("1 h 5 min");
    expect(fmtDurationWords(1141)).toBe("19 h 1 min");
  });
  test("rounds and clamps", () => {
    expect(fmtDurationWords(59.6)).toBe("1 h");
    expect(fmtDurationWords(-5)).toBe("0 min");
  });
});
