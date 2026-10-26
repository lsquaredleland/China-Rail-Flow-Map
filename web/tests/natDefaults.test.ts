// National mode's default view: flows and city circles, no animation; the
// ?natLayer=none turns the Flows toggle off.
import { afterEach, describe, expect, test } from "bun:test";
import { initialNatFlows } from "../src/hooks/useUrlState";

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
    expect(initialNatFlows()).toBe(true);
  });
  test("natLayer=none: flows off; the retired values open with flows on", () => {
    withSearch("?national=1&natLayer=none");
    expect(initialNatFlows()).toBe(false);
    for (const v of ["trains", "both", "flows", "bogus"]) {
      withSearch("?national=1&natLayer=" + v);
      expect(initialNatFlows()).toBe(true);
    }
  });
});
