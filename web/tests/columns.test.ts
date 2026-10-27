// The safetensors tables (what the client loads) against the JSON tables (what the
// tools read), and the lazy per-origin expansion both go through.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { join } from "node:path";
import {
  copyFields,
  expandInColumns,
  expandInTables,
  expandOutColumns,
  expandOutTables,
  isSafetensors,
  readSafetensors,
} from "../src/lib";
import { ASSETS, loadJson } from "./fixture";
import { staleDecision } from "../src/staleReload";

const cols = (name: string) => readSafetensors(new Uint8Array(brotliDecompressSync(readFileSync(join(ASSETS, name + ".br")))));

describe("safetensors tables", () => {
  test("out tables: every origin's fields equal the JSON tables'", () => {
    const t = cols("atlas-v2-out-tables.safetensors");
    expect(t.fmt).toBe(6);
    const a = expandOutColumns(t).origins;
    const b = expandOutTables(loadJson("atlas-v2-out-tables.json")).origins;
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      for (const k of ["deps", "calls", "dep_secs", "dep_chord_legs", "dep_stop_pos"] as const)
        expect(a[i][k]).toEqual(b[i][k]);
    }
  });

  test("in tables: every origin's fields equal the JSON tables'", () => {
    const t = cols("atlas-v2-in-tables.safetensors");
    const a = expandInColumns(t).origins;
    const b = expandInTables(loadJson("atlas-v2-in-tables.json")).origins;
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      for (const k of ["arrs", "in_calls", "arr_secs", "arr_chord_legs"] as const)
        expect(a[i][k]).toEqual(b[i][k]);
    }
  });

  test("columns are views into one buffer, not copies", () => {
    const t = cols("atlas-v2-out-tables.safetensors");
    const bufs = new Set(Object.values(t.cols).map((c) => c.v.buffer));
    expect(bufs.size).toBe(1);
    expect(t.cols.paths.v).toBeInstanceOf(Int16Array);
  });

  test("an unaligned buffer is read too", () => {
    const raw = brotliDecompressSync(readFileSync(join(ASSETS, "atlas-v2-in-tables.safetensors.br")));
    const odd = new Uint8Array(raw.length + 1).subarray(1);
    odd.set(raw);
    expect(expandInColumns(readSafetensors(odd)).origins[3].arrs).toEqual(expandInColumns(cols("atlas-v2-in-tables.safetensors")).origins[3].arrs);
  });

  test("anything but safetensors is refused", () => {
    expect(isSafetensors(new TextEncoder().encode('{"fmt":6}'))).toBe(false);
    expect(() => readSafetensors(new TextEncoder().encode("<!doctype html>"))).toThrow(/not a safetensors file/);
    expect(() => expandInColumns(cols("atlas-v2-out-tables.safetensors"))).toThrow(/expected in-tables/);
  });

  test("hashed .safetensors.br packs count for the stale reload", () => {
    expect(staleDecision(404, "assets/atlas-v2-out-tables.1a2b3c4d.safetensors.br", null, 0)).toBe("reload");
  });
});

describe("lazy per-origin expansion", () => {
  test("copyFields merges without expanding; a read expands that origin only", () => {
    let reads = 0;
    const t = cols("atlas-v2-out-tables.safetensors");
    const d = expandOutColumns(t);
    const path = t.cols.paths.v;
    // Count path reads through a proxy-free hook: wrap subarray.
    const sub = path.subarray.bind(path);
    (path as { subarray: typeof path.subarray }).subarray = (a?: number, b?: number) => {
      reads++;
      return sub(a, b);
    };
    const targets = d.origins.map(() => ({ zh: "x" }) as Record<string, unknown>);
    d.origins.forEach((o, i) => copyFields(targets[i], o));
    expect(reads).toBe(0);
    const secs = targets[5].dep_secs as number[][];
    expect(reads).toBe(secs.length);
    expect(Object.getOwnPropertyDescriptor(targets[5], "dep_secs")?.value).toBe(secs);
    expect(Object.getOwnPropertyDescriptor(targets[6], "dep_secs")?.get).toBeDefined();
  });

  test("a lazy field can be assigned", () => {
    const o = expandInTables(loadJson("atlas-v2-in-tables.json")).origins[0];
    o.arr_secs = [];
    expect(o.arr_secs).toEqual([]);
  });
});

describe("review fixes", () => {
  test("re-merging an origin keeps its calls (no rebuild on a direction flip)", () => {
    const d = expandOutColumns(cols("atlas-v2-out-tables.safetensors"));
    const target: Record<string, unknown> = {};
    copyFields(target, d.origins[2]);
    const first = target.calls;
    copyFields(target, d.origins[2]);
    expect(target.calls).toBe(first);
  });
});

// Memory budgets (bun, forced GC; JS heap + ArrayBuffer stores). Measured
// 2026-10-27: both directions' safetensors tables retain 23.8 MB at load (the eager
// JSON expansion this replaced: 129.5 MB); one origin expanded adds ~4 MB.
describe("memory budget", () => {
  const mem = () => {
    Bun.gc(true);
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };
  const raw = ["out", "in"].map((d) => brotliDecompressSync(readFileSync(join(ASSETS, `atlas-v2-${d}-tables.safetensors.br`))));

  test("loading both directions' tables retains under 35 MB", () => {
    const base = mem();
    const out = expandOutColumns(readSafetensors(new Uint8Array(raw[0])));
    const inn = expandInColumns(readSafetensors(new Uint8Array(raw[1])));
    const loaded = mem() - base;
    expect(loaded).toBeLessThan(35e6);
    // The busiest origin (both directions) stays a few MB.
    const before = mem();
    for (const o of [out.origins[0]]) void [o.deps, o.calls, o.dep_secs, o.dep_chord_legs, o.dep_stop_pos];
    for (const o of [inn.origins[0]]) void [o.arrs, o.in_calls, o.arr_secs, o.arr_chord_legs];
    expect(mem() - before).toBeLessThan(8e6);
    void [out, inn];
  });
});
