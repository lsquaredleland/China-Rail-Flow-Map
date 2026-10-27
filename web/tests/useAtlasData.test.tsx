// Unit tests for useAtlasData staged loading and failure flags without network.
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAtlasData } from "../src/hooks/useAtlasData";

const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

function setupAtlasHook() {
  const stateValues: Record<number, any> = {};
  const setters: Record<number, (v: any) => void> = {};
  let capturedHook: any;

  function TestHarness() {
    const orig = internals.H.useState;
    let idx = 0;
    internals.H.useState = (init: any) => {
      const curIdx = idx++;
      const [val, rawSetter] = orig(init);
      stateValues[curIdx] = val;
      const wrappedSetter = (nextVal: any) => {
        stateValues[curIdx] = typeof nextVal === "function" ? nextVal(stateValues[curIdx]) : nextVal;
        rawSetter(nextVal);
      };
      setters[curIdx] = wrappedSetter;
      return [stateValues[curIdx], wrappedSetter];
    };
    try {
      capturedHook = useAtlasData({ atlasRef: { current: null }, selectedTrainCode: null, onReady: () => {} });
      return null;
    } finally {
      internals.H.useState = orig;
    }
  }

  renderToStaticMarkup(<TestHarness />);
  return { hook: capturedHook, stateValues, setters };
}

describe("useAtlasData failure flags", () => {
  test("initial failure flags are clean", () => {
    const { hook } = setupAtlasHook();
    expect(hook.loadError).toBeNull();
    expect(hook.nationalFlowsFailed).toBe(false);
    expect(hook.nationalIndexFailed).toBe(false);
    expect(hook.nationalTrainsFailed).toBe(false);
    expect(hook.outTablesReady).toBe(false);
    expect(hook.inMapReady).toBe(false);
    expect(hook.inTablesReady).toBe(false);
  });

  test("ensureNationalIndex sets nationalIndexFailed on fetch rejection", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("Index network failure"))) as any;

    try {
      const { hook, stateValues } = setupAtlasHook();
      expect(stateValues[11]).toBe(false);
      hook.ensureNationalIndex();
      await new Promise((r) => setTimeout(r, 30));
      expect(stateValues[11]).toBe(true); // nationalIndexFailed
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("ensureNationalFlows sets nationalFlowsFailed on fetch rejection", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("Flows network failure"))) as any;

    try {
      const { hook, stateValues } = setupAtlasHook();
      expect(stateValues[12]).toBe(false);
      hook.ensureNationalFlows();
      await new Promise((r) => setTimeout(r, 30));
      expect(stateValues[12]).toBe(true); // nationalFlowsFailed
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("ensureNationalTrains sets nationalTrainsFailed on fetch rejection", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("Trains network failure"))) as any;

    try {
      const { hook, stateValues } = setupAtlasHook();
      expect(stateValues[14]).toBe(false);
      hook.ensureNationalTrains();
      await new Promise((r) => setTimeout(r, 30));
      expect(stateValues[14]).toBe(true); // nationalTrainsFailed
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("format error in staged table loading triggers loadError", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        // The tables files are TA1: magic, header length, JSON header.
        arrayBuffer: () => {
          const h = new TextEncoder().encode(JSON.stringify({ fmt: 999, pack: "out-tables", meta: { chords: [] }, columns: [] }));
          const b = new Uint8Array(8 + h.length);
          b.set([0x54, 0x41, 0x31, 0]);
          new DataView(b.buffer).setUint32(4, h.length, true);
          b.set(h, 8);
          return Promise.resolve(b.buffer);
        },
        json: () => Promise.resolve({ fmt: 999 }),
      })) as any;

    try {
      const { hook, stateValues } = setupAtlasHook();
      expect(stateValues[1]).toBeNull();
      hook.ensureOutTables();
      await new Promise((r) => setTimeout(r, 30));
      expect(stateValues[1]).toContain("unsupported data format 999");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
