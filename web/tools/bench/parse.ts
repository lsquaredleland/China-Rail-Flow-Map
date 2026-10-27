// Pack benchmark: size, brotli decode, JSON.parse and retained heap per pack file,
// plus the client expand step (expandOutTables / expandInTables) time and heap.
//
//   bun run bench -- [--dir <extra pack dir>]... [--runs 5] [--out result.json]
//   bun run bench -- --columnar [--dir <pack dir>]
//
// Reads web/public/assets (read only) and every --dir given (e.g. a staging dir).
// Needs bun (Bun.gc). Retained heap = heapUsed delta after a forced GC around one
// JSON.parse (the M15 metric); expand heap = same delta around expand*Tables with the
// parsed pack still live. --columnar runs the columnar prototype (columnar.ts) instead.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { expandKind, fmtMB, fmtMs, median, packName, renderTable } from "./helpers";

const argv = process.argv.slice(2);
const opts = (k: string) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
const ASSETS = resolve(import.meta.dir, "../../public/assets");

if (argv.includes("--columnar")) {
  await import("./columnar");
} else {
  const lib = await import("../../src/lib/index");
  const gc = () => (globalThis as any).Bun.gc(true);
  const heap = () => (gc(), process.memoryUsage().heapUsed);
  const RUNS = +(opts("--runs")[0] ?? 5);
  const dirs = [ASSETS, ...opts("--dir").map((d) => resolve(d))];

  const results: any[] = [];
  for (const dir of dirs) {
    const rows: string[][] = [];
    for (const f of readdirSync(dir).filter((x) => packName(x)).sort()) {
      const name = packName(f)!;
      const br = readFileSync(join(dir, f));
      const t0 = performance.now();
      const buf = brotliDecompressSync(br);
      const brDecodeMs = performance.now() - t0;
      const txt = buf.toString("utf8");
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) { gc(); const a = performance.now(); JSON.parse(txt); times.push(performance.now() - a); }
      const h0 = heap();
      const obj = JSON.parse(txt);
      const retainedBytes = heap() - h0;
      let expand: { ms: number; heapBytes: number } | null = null;
      const kind = expandKind(name);
      if (kind) {
        const fn = kind === "out" ? lib.expandOutTables : lib.expandInTables;
        const e0 = heap(); const a = performance.now();
        const out = fn(obj);
        const ms = performance.now() - a;
        expand = { ms, heapBytes: heap() - e0 };
        void out;
      }
      const parseMs = median(times);
      results.push({ dir, name, brBytes: br.length, jsonBytes: buf.length, brDecodeMs, parseMs, retainedBytes, expand });
      rows.push([name, br.length.toLocaleString(), buf.length.toLocaleString(), fmtMs(brDecodeMs), fmtMs(parseMs), fmtMB(retainedBytes),
        expand ? `${fmtMs(expand.ms)} / ${fmtMB(expand.heapBytes)}` : "-"]);
      void obj;
    }
    console.log(`\n${dir}  (bun ${Bun.version}, JSON.parse median of ${RUNS})\n`);
    console.log(renderTable(["pack", "br bytes", "json bytes", "br decode", "JSON.parse", "retained heap", "expand time / heap"], rows));
  }
  const out = opts("--out")[0];
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify({ bun: Bun.version, runs: RUNS, results }, null, 2));
  }
}
