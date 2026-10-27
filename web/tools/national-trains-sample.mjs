// Writes web/tests/fixtures/national-trains-sample.json.br: a deterministic
// subset of an atlas-v2-national-trains.json(.br) file for the unit tests,
// so `bun test` runs without the full file (it is staged, not in
// public/assets, until the owner swaps it in). Kept: every 10th train, every
// train whose path uses an `extra` piece, every train with chord legs; the
// other trains' paths and stop lists become [] (= not national). `extra` and
// the file header are kept whole, `on_sec` only for the kept pieces' trains.
// usage: node tools/national-trains-sample.mjs <atlas-v2-national-trains.json.br>
import fs from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

const src = process.argv[2];
if (!src) {
  console.error("usage: node tools/national-trains-sample.mjs <atlas-v2-national-trains.json.br>");
  process.exit(1);
}
const d = JSON.parse(brotliDecompressSync(fs.readFileSync(src)).toString("utf8"));
const base = d.n_sec + d.n_thr;
const chordT = new Set(d.chords.map((c) => c[0]));
const keep = (t) =>
  d.paths[t].length > 0 && (t % 10 === 0 || chordT.has(t) || d.paths[t].some((v) => (v < 0 ? ~v : v) >= base));
const out = {
  fmt: d.fmt,
  n_sec: d.n_sec,
  n_thr: d.n_thr,
  paths: d.paths.map((p, t) => (keep(t) ? p : [])),
  stop_pos: d.stop_pos.map((p, t) => (keep(t) ? p : [])),
  chords: d.chords.filter((c) => keep(c[0])),
  extra: d.extra,
  on_sec: d.on_sec,
};
const dst = new URL("../tests/fixtures/national-trains-sample.json.br", import.meta.url);
fs.mkdirSync(new URL(".", dst), { recursive: true });
const br = brotliCompressSync(Buffer.from(JSON.stringify(out)), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
fs.writeFileSync(dst, br);
console.log(`${out.paths.filter((p) => p.length).length} of ${d.paths.filter((p) => p.length).length} trains kept; ${br.length} B brotli`);
