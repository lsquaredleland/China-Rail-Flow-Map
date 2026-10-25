import { describe, expect, test } from "bun:test";
import { RELOAD_COOLDOWN_MS, staleDecision } from "../src/staleReload";

const HASHED = "assets/out-tables.1a2b3c4d.json.br";
const NOW = 1_000_000;

describe("staleDecision", () => {
  test("404 on a hashed pack with no prior reload reloads", () => {
    expect(staleDecision(404, HASHED, null, NOW)).toBe("reload");
  });
  test("a reload within the cooldown does not repeat", () => {
    expect(staleDecision(404, HASHED, NOW - 5_000, NOW)).toBe("error");
    expect(staleDecision(404, HASHED, NOW - (RELOAD_COOLDOWN_MS - 1), NOW)).toBe("error");
  });
  test("an old reload no longer blocks", () => {
    expect(staleDecision(404, HASHED, NOW - RELOAD_COOLDOWN_MS, NOW)).toBe("reload");
  });
  test("a future timestamp (clock skew) does not block", () => {
    expect(staleDecision(404, HASHED, NOW + 5_000, NOW)).toBe("reload");
  });
  test("other statuses never reload", () => {
    for (const s of [0, 200, 403, 500, 502, 503]) expect(staleDecision(s, HASHED, null, NOW)).toBe("error");
  });
  test("only hashed .json.br pack URLs qualify", () => {
    expect(staleDecision(404, "assets/out-tables.json.br", null, NOW)).toBe("error");
    expect(staleDecision(404, "assets/out-tables.json", null, NOW)).toBe("error");
    expect(staleDecision(404, "/api/thing", null, NOW)).toBe("error");
    expect(staleDecision(404, "/assets/in-map.deadbeef.json.br", null, NOW)).toBe("reload");
  });
});
