// Usage: node scripts/cmp_pack.mjs <base_dir> <new_dir>
// Byte-compares every .br pack file in <base_dir> with <new_dir>. The files
// that carry the `build` provenance block (pipeline tree hash, dirty flag)
// are compared again as JSON with that block removed, so a rebuild from
// uncommitted code still counts as identical. Exits 1 when any file differs
// or is missing. For a semantic diff of two packs use `secdiff --packs`.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { join } from "node:path";

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: node scripts/cmp_pack.mjs <base_dir> <new_dir>");
  process.exit(2);
}
const PROV = new Set(["atlas-v2-shared.json.br", "china-flow-atlas-data-v2.json.br"]);
// Not in both by design: the combined v2 file is never shipped, and the
// outline comes from pipeline/outline, not rebuild_pack.sh.
const ONE_SIDED = new Set(["china-flow-atlas-data-v2.json.br", "china-outline.json.br"]);
const strip = (buf) => {
  const j = JSON.parse(brotliDecompressSync(buf));
  delete j.build;
  if (j.shared) delete j.shared.build;
  return JSON.stringify(j);
};
let bad = 0;
for (const f of readdirSync(a).filter((f) => f.endsWith(".br")).sort()) {
  if (!existsSync(join(b, f))) {
    if (ONE_SIDED.has(f)) {
      console.log(`skip ${f} (only in ${a})`);
      continue;
    }
    console.log(`MISSING ${f}`);
    bad++;
    continue;
  }
  const x = readFileSync(join(a, f));
  const y = readFileSync(join(b, f));
  if (x.equals(y)) console.log(`same ${f}`);
  else if (PROV.has(f) && strip(x) === strip(y)) console.log(`same ${f} (build block ignored)`);
  else {
    console.log(`DIFF ${f}`);
    bad++;
  }
}
console.log(bad ? `FAIL: ${bad} file(s) differ` : "PASS: pack identical");
process.exit(bad ? 1 : 0);
