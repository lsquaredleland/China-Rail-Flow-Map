// Loads the committed pack (web/public/assets/*.json.br) the way the app
// does: brotli-decode, requireFmt, decodeFlows, expandOutTables, prepAtlas.
// The assets are stored under their source names; bundle.mjs content-hashes
// them only in dist/, so the tests read the source files directly.
import { existsSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { dirname, join } from "node:path";
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

const NATIONAL_TRAINS = "atlas-v2-national-trains.json.br";
const SAMPLE = join(import.meta.dir, "fixtures/national-trains-sample.json.br");

/** The national trains file (P2.2): the full file when it can be found (in
    public/assets once the owner swaps it in, else the pipeline's staging
    dir `staging/national-trains/dev` in this checkout or a parent of it),
    otherwise the committed sample (tools/national-trains-sample.mjs, every
    10th train plus the extra-piece and chord trains), so CI runs the same
    tests on the sample (CRFM_NATIONAL_SAMPLE=1 forces it, as CI sees it). */
export function nationalTrains(): { source: "full" | "sample"; path: string; data: any } {
  const cands = [join(ASSETS, NATIONAL_TRAINS)];
  for (let dir = join(import.meta.dir, ".."); ; dir = dirname(dir)) {
    cands.push(join(dir, "staging/national-trains/dev", NATIONAL_TRAINS));
    if (dirname(dir) === dir) break;
  }
  const full = process.env.CRFM_NATIONAL_SAMPLE === "1" ? undefined : cands.find((p) => existsSync(p));
  const path = full ?? SAMPLE;
  if (!existsSync(path)) throw new Error(`national trains file missing: none of ${[...cands, SAMPLE].join(", ")}`);
  const data = JSON.parse(brotliDecompressSync(readFileSync(path)).toString("utf8"));
  return { source: full ? "full" : "sample", path, data };
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
