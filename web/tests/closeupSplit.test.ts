// components/map/closeup: only the origin city and the selected destination split.
import { describe, expect, test } from "bun:test";
import { splitCities } from "../src/components/map/closeup";
import type { CloseupStation } from "../src/lib";

const st = (zh: string): CloseupStation => ({ zh, en: zh, pt: [0, 0] });
const all = new Map<string, CloseupStation[]>([
  ["广州", [st("广州南"), st("广州东")]],
  ["深圳", [st("深圳北"), st("福田")]],
  ["东莞", [st("东莞"), st("东莞南")]],
]);

describe("close-up split", () => {
  test("origin and selected destination only", () => {
    expect([...splitCities(all, "广州", "").keys()]).toEqual(["广州"]);
    expect([...splitCities(all, "广州", "深圳").keys()]).toEqual(["广州", "深圳"]);
    expect([...splitCities(all, "", "").keys()]).toEqual([]);
    expect([...splitCities(all, "武汉", "东莞").keys()]).toEqual(["东莞"]);
  });
  test("memoised per inputs", () => {
    expect(splitCities(all, "广州", "深圳")).toBe(splitCities(all, "广州", "深圳"));
  });
});
