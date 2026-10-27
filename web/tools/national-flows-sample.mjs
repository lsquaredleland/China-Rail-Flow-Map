// Writes web/tests/fixtures/national-flows-sample.json.br: a deterministic
// section subset of the national flows file (atlas-v2-national.json, P3.1)
// and its entries file (atlas-v2-national-entries.json, P3.3) for the unit
// tests, so `bun test` checks nationalCountsAt against B without the full
// files (they are staged, not in public/assets, until the owner swaps them
// in). Kept: every 20th section plus the 10 busiest; both files are cut to
// those sections in the same order, so each is a valid file of n_sec = kept.
// usage: node tools/national-flows-sample.mjs <atlas-v2-national.json.br> <atlas-v2-national-entries.json.br>
import fs from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

const [fSrc, eSrc] = process.argv.slice(2);
if (!fSrc || !eSrc) {
  console.error("usage: node tools/national-flows-sample.mjs <atlas-v2-national.json.br> <atlas-v2-national-entries.json.br>");
  process.exit(1);
}
const read = (p) => JSON.parse(brotliDecompressSync(fs.readFileSync(p)).toString("utf8"));
const nf = read(fSrc);
const ne = read(eSrc);
if (nf.total.length !== ne.n_sec) throw new Error(`section counts differ: ${nf.total.length} vs ${ne.n_sec}`);
const busiest = [...nf.total.keys()].sort((a, b) => nf.total[b] - nf.total[a] || a - b).slice(0, 10);
const keep = [...new Set([...nf.total.keys()].filter((s) => s % 20 === 0).concat(busiest))].sort((a, b) => a - b);
const out = {
  sections: keep,
  flows: {
    fmt: nf.fmt,
    trains: nf.trains,
    total: keep.map((s) => nf.total[s]),
    by_class: nf.by_class.map((row) => keep.map((s) => row[s])),
  },
  entries: {
    fmt: ne.fmt,
    n_sec: keep.length,
    trains: ne.trains,
    ticks_per_min: ne.ticks_per_min,
    by_class: ne.by_class.map((row) => keep.map((s) => row[s])),
  },
};
const dst = new URL("../tests/fixtures/national-flows-sample.json.br", import.meta.url);
fs.mkdirSync(new URL(".", dst), { recursive: true });
const br = brotliCompressSync(Buffer.from(JSON.stringify(out)), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
fs.writeFileSync(dst, br);
const ticks = out.entries.by_class.reduce((a, row) => a + row.reduce((b, l) => b + l.length, 0), 0);
console.log(`${keep.length} of ${ne.n_sec} sections, ${ticks} entry ticks; ${br.length} B brotli`);
