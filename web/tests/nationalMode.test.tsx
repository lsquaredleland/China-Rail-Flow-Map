import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useNationalMode, type NationalModeInput } from "../src/hooks/useNationalMode";

function renderNationalHook(input: NationalModeInput): ReturnType<typeof useNationalMode> {
  let result!: ReturnType<typeof useNationalMode>;
  function Harness() {
    result = useNationalMode(input);
    return null;
  }
  renderToStaticMarkup(<Harness />);
  return result;
}

function makeInput(overrides: Partial<NationalModeInput> = {}): {
  input: NationalModeInput;
  calls: string[];
} {
  const calls: string[] = [];
  const input: NationalModeInput = {
    national: true,
    atlas: null,
    selectedTrainCode: null,
    isolatedTrainCode: null,
    isTimelineCollapsed: false,
    nationalFlowsFailed: false,
    nationalTrainsFailed: false,
    nationalIndexFailed: false,
    ensureNationalTrains: () => calls.push("trains"),
    ensureNationalFlows: () => calls.push("flows"),
    ensureNationalEntries: () => calls.push("entries"),
    ensureNationalIndex: () => calls.push("index"),
    ensureSchedules: () => calls.push("schedules"),
    ...overrides,
  };
  return { input, calls };
}

describe("useNationalMode load failure notices and retry wiring", () => {
  test("clean state produces no load error notice", () => {
    const { input } = makeInput();
    const res = renderNationalHook(input);
    expect(res.natLoadError).toBeNull();
  });

  test("nationalIndexFailed wires to national index notice and retries via ensureNationalIndex", () => {
    const { input, calls } = makeInput({ nationalIndexFailed: true });
    const res = renderNationalHook(input);
    expect(res.natLoadError).toBe("The national index could not be loaded.");

    // Retry should call ensureNationalIndex
    const callsBefore = calls.length;
    res.retryNatLoad();
    expect(calls.slice(callsBefore)).toEqual(["index"]);
  });

  test("nationalFlowsFailed wires to national flow notice and retries via ensureNationalFlows", () => {
    const { input, calls } = makeInput({ nationalFlowsFailed: true });
    const res = renderNationalHook(input);
    expect(res.natLoadError).toBe("The national flow data could not be loaded.");

    const callsBefore = calls.length;
    res.retryNatLoad();
    expect(calls.slice(callsBefore)).toEqual(["flows"]);
  });

  test("nationalTrainsFailed wires to national train notice and retries via ensureNationalTrains", () => {
    const { input, calls } = makeInput({ nationalTrainsFailed: true });
    const res = renderNationalHook(input);
    expect(res.natLoadError).toBe("The national train data could not be loaded.");

    const callsBefore = calls.length;
    res.retryNatLoad();
    expect(calls.slice(callsBefore)).toEqual(["trains"]);
  });

  test("failure flags outside national mode produce no notice", () => {
    const { input } = makeInput({
      national: false,
      nationalIndexFailed: true,
      nationalFlowsFailed: true,
      nationalTrainsFailed: true,
    });
    const res = renderNationalHook(input);
    expect(res.natLoadError).toBeNull();
  });
});
