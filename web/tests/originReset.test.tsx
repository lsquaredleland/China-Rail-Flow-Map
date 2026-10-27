// A new origin clears the previous origin's selection (PR #82). The effect in
// App.tsx calls clearOriginSelection on every originIdx change; this pins what
// that function clears. (No DOM test environment here, so the effect itself is
// covered by the browser check in PR #82, not by bun test.)
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { clearOriginSelection } from "../src/hooks/useSelection";

describe("origin reset", () => {
  test("clears the selected train, the isolated train and the selected destination", () => {
    const calls: [string, unknown][] = [];
    clearOriginSelection({
      setSelectedTrainCode: (c) => calls.push(["selected", c]),
      setIsolatedTrainCode: (c) => calls.push(["isolated", c]),
      setPanelCity: (c) => calls.push(["dest", c]),
    });
    expect(calls).toEqual([["selected", null], ["isolated", null], ["dest", null]]);
  });

  test("App runs it on every origin change", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toMatch(/useEffect\(\(\) => \{\s*clearOriginSelection\([^)]*\);\s*\}, \[originIdx\b/);
  });
});
