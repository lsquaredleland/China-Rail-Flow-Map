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

const NATIONAL_ENTRIES = "atlas-v2-national-entries.json.br";

/** The pipeline's national entries file (P3.3) when it can be found: in
    public/assets after the swap, else `staging/national-entries/run3` in this
    checkout or a parent of it; undefined otherwise (CI), where the committed
    sample is the only input. CRFM_NATIONAL_SAMPLE=1 forces the sample. The
    trains file is the one next to it when there is one (the entries are
    built from it), else the usual national trains file. */
export function nationalEntries(): { path: string; data: any; trains: any } | undefined {
  if (process.env.CRFM_NATIONAL_SAMPLE === "1") return undefined;
  const cands = [join(ASSETS, NATIONAL_ENTRIES)];
  for (let dir = join(import.meta.dir, ".."); ; dir = dirname(dir)) {
    cands.push(join(dir, "staging/national-entries/run3", NATIONAL_ENTRIES));
    if (dirname(dir) === dir) break;
  }
  const path = cands.find((p) => existsSync(p));
  if (!path) return undefined;
  const read = (p: string) => JSON.parse(brotliDecompressSync(readFileSync(p)).toString("utf8"));
  const sibling = join(dirname(path), NATIONAL_TRAINS);
  return { path, data: read(path), trains: existsSync(sibling) ? read(sibling) : nationalTrains().data };
}

const NATIONAL_FLOWS = "atlas-v2-national.json.br";
const FLOWS_SAMPLE = join(import.meta.dir, "fixtures/national-flows-sample.json.br");

/** The national flows file (P3.1) and its entries file (P3.3), as a pair: the
    full files when both can be found (the entries file as nationalEntries()
    finds it, the flows file next to it, else in public/assets or
    `staging/national-flows/run1` in this checkout or a parent of it),
    otherwise the committed sample (tools/national-flows-sample.mjs: every
    20th section plus the 10 busiest, both files cut alike), so CI runs the
    same tests on the sample (CRFM_NATIONAL_SAMPLE=1 forces it). */
export function nationalFlowsPair(): { source: "full" | "sample"; flows: any; entries: any } {
  const ne = nationalEntries();
  if (ne) {
    const cands = [join(dirname(ne.path), NATIONAL_FLOWS), join(ASSETS, NATIONAL_FLOWS)];
    for (let dir = join(import.meta.dir, ".."); ; dir = dirname(dir)) {
      cands.push(join(dir, "staging/national-flows/run1", NATIONAL_FLOWS));
      if (dirname(dir) === dir) break;
    }
    const path = cands.find((p) => existsSync(p));
    if (path) {
      const flows = JSON.parse(brotliDecompressSync(readFileSync(path)).toString("utf8"));
      return { source: "full", flows, entries: ne.data };
    }
  }
  const s = JSON.parse(brotliDecompressSync(readFileSync(FLOWS_SAMPLE)).toString("utf8"));
  return { source: "sample", flows: s.flows, entries: s.entries };
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
