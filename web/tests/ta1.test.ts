// The TA1 tables (what the client loads) against the JSON tables (what the
// tools read), and the lazy per-origin expansion both go through.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { join } from "node:path";
import {
  copyFields,
  expandInTa1,
  expandInTables,
  expandOutTa1,
  expandOutTables,
  isTa1,
  readTa1,
} from "../src/lib";
import { ASSETS, loadJson } from "./fixture";
import { staleDecision } from "../src/staleReload";

const ta1 = (name: string) => readTa1(new Uint8Array(brotliDecompressSync(readFileSync(join(ASSETS, name + ".br")))));

describe("TA1 tables", () => {
  test("out tables: every origin's fields equal the JSON tables'", () => {
    const t = ta1("atlas-v2-out-tables.ta1");
    expect(t.fmt).toBe(6);
    const a = expandOutTa1(t).origins;
    const b = expandOutTables(loadJson("atlas-v2-out-tables.json")).origins;
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      for (const k of ["deps", "calls", "dep_secs", "dep_chord_legs", "dep_stop_pos"] as const)
        expect(a[i][k]).toEqual(b[i][k]);
    }
  });

  test("in tables: every origin's fields equal the JSON tables'", () => {
    const t = ta1("atlas-v2-in-tables.ta1");
    const a = expandInTa1(t).origins;
    const b = expandInTables(loadJson("atlas-v2-in-tables.json")).origins;
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      for (const k of ["arrs", "in_calls", "arr_secs", "arr_chord_legs"] as const)
        expect(a[i][k]).toEqual(b[i][k]);
    }
  });

  test("columns are views into one buffer, not copies", () => {
    const t = ta1("atlas-v2-out-tables.ta1");
    const bufs = new Set(Object.values(t.cols).map((c) => c.v.buffer));
    expect(bufs.size).toBe(1);
    expect(t.cols.paths.v).toBeInstanceOf(Int16Array);
  });

  test("an unaligned buffer is read too", () => {
    const raw = brotliDecompressSync(readFileSync(join(ASSETS, "atlas-v2-in-tables.ta1.br")));
    const odd = new Uint8Array(raw.length + 1).subarray(1);
    odd.set(raw);
    expect(expandInTa1(readTa1(odd)).origins[3].arrs).toEqual(expandInTa1(ta1("atlas-v2-in-tables.ta1")).origins[3].arrs);
  });

  test("anything but TA1 is refused", () => {
    expect(isTa1(new TextEncoder().encode('{"fmt":6}'))).toBe(false);
    expect(() => readTa1(new TextEncoder().encode("<!doctype html>"))).toThrow(/not a TA1 file/);
    expect(() => expandInTa1(ta1("atlas-v2-out-tables.ta1"))).toThrow(/expected in-tables/);
  });

  test("hashed .ta1.br packs count for the stale reload", () => {
    expect(staleDecision(404, "assets/atlas-v2-out-tables.1a2b3c4d.ta1.br", null, 0)).toBe("reload");
  });
});

describe("lazy per-origin expansion", () => {
  test("copyFields merges without expanding; a read expands that origin only", () => {
    let reads = 0;
    const t = ta1("atlas-v2-out-tables.ta1");
    const d = expandOutTa1(t);
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
