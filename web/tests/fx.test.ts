// lib/fx: the CRT look is the terminal default; ?fx=off turns it off.
import { describe, expect, test } from "bun:test";
import { fxFromUrl, fxNum } from "../src/lib/fx";

describe("fx", () => {
  test("crt by default, off on request", () => {
    expect(fxFromUrl("")).toBe("crt");
    expect(fxFromUrl("?skin=terminal&fx=crt")).toBe("crt");
    expect(fxFromUrl("?fx=off")).toBeNull();
    expect(fxFromUrl("?fx=none")).toBeNull();
  });
  test("tuning numbers", () => {
    expect(fxNum("fxGlow", "?fxGlow=0.3")).toBe(0.3);
    expect(fxNum("fxGlow", "?fxGlow=x")).toBeUndefined();
    expect(fxNum("fxGlow", "")).toBeUndefined();
  });
});
