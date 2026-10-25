// Loads the committed pack (web/public/assets/*.json.br) the way the app
// does: brotli-decode, requireFmt, decodeFlows, expandOutTables, prepAtlas.
// The assets are stored under their source names; bundle.mjs content-hashes
// them only in dist/, so the tests read the source files directly.
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { join } from "node:path";
import {
  buildOrigin,
  decodeFlows,
  expandOutTables,
  prepAtlas,
  requireFmt,
} from "../src/lib";

export const ASSETS = join(import.meta.dir, "../public/assets");

export function loadJson<T = any>(name: string): T {
  return JSON.parse(brotliDecompressSync(readFileSync(join(ASSETS, name + ".br"))).toString("utf8"));
}

function build() {
  const shared = loadJson("atlas-v2-shared.json");
  const map = loadJson("atlas-v2-out-map.json");
  const tablesRaw = loadJson("atlas-v2-out-tables.json");
  const schedules = loadJson("atlas-v2-schedules.json").schedules;
  requireFmt(shared.fmt, "shared");
  requireFmt(map.fmt, "map");
  requireFmt(tablesRaw.fmt, "tables");
  for (const o of map.origins) decodeFlows(o.flows);
  const tables = expandOutTables(tablesRaw);
  const data = {
    ...shared,
    about: "",
    origins: map.origins.map((o: any, i: number) => ({ ...o, ...tables.origins[i] })),
  };
  const atlas = Object.assign(prepAtlas(data), { schedules });
  return { shared, map, tablesRaw, tables, atlas };
}

let cached: ReturnType<typeof build> | undefined;
export function pack() {
  return (cached ??= build());
}

export function originIndex(zh: string): number {
  const i = pack().map.origins.findIndex((o: any) => o.zh === zh);
  if (i < 0) throw new Error("origin not found: " + zh);
  return i;
}

const origins = new Map<number, ReturnType<typeof buildOrigin>>();
/** buildOrigin is cached per index so tests share the (slow) timeline. */
export function origin(zh: string) {
  const i = originIndex(zh);
  let o = origins.get(i);
  if (!o) origins.set(i, (o = buildOrigin(pack().atlas, i)));
  return o;
}
