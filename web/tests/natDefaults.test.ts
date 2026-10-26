// National mode's default view: flows and city circles, no animation; the
// ?natLayer URL values map onto the two toggles.
import { afterEach, describe, expect, test } from "bun:test";
import { initialNatLayer } from "../src/hooks/useUrlState";

const g = globalThis as unknown as { window?: unknown };
const withSearch = (search: string) => {
  g.window = { location: { search } };
};
afterEach(() => {
  delete g.window;
});

describe("national defaults", () => {
  test("no natLayer param: flows only (no animation)", () => {
    withSearch("?national=1");
    expect(initialNatLayer()).toBe("flows");
  });
  test("natLayer back-compat values", () => {
    for (const v of ["trains", "both", "none", "flows"]) {
      withSearch("?national=1&natLayer=" + v);
      expect(initialNatLayer()).toBe(v as never);
    }
    withSearch("?natLayer=bogus");
    expect(initialNatLayer()).toBe("flows");
  });
});
