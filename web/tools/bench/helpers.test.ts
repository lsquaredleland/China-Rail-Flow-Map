import { expect, test } from "bun:test";
import { expandKind, fmtMB, fmtMs, median, packName, renderTable } from "./helpers";

test("median picks the middle of an unsorted list", () => {
  expect(median([5, 1, 3, 2, 4])).toBe(3);
  expect(median([7])).toBe(7);
});
test("formatters", () => {
  expect(fmtMs(3.54)).toBe("3.5 ms");
  expect(fmtMB(1048576 * 2.5)).toBe("2.5 MB");
});
test("packName / expandKind", () => {
  expect(packName("atlas-v2-shared.json.br")).toBe("atlas-v2-shared");
  expect(packName("manifest.json")).toBeNull();
  expect(expandKind("atlas-v2-out-tables")).toBe("out");
  expect(expandKind("atlas-v2-in-tables")).toBe("in");
  expect(expandKind("atlas-v2-out-map")).toBeNull();
});
test("renderTable aligns numeric columns right", () => {
  expect(renderTable(["a", "b"], [["x", "1"]])).toBe("| a | b |\n| --- | ---: |\n| x | 1 |");
});
