// Usage: node scripts/check_pack_roundtrip.mjs <old fmt-4 pack dir> <new fmt-5 pack dir>
// Decodes the fmt-5 pack with the real client code (web/src/lib.ts, bundled
// with esbuild) and compares it with the fmt-4 pack for every origin and
// row. Section ids differ between the packs, so sections are compared by
// geometry (polyline + HSR flag), never by id: per-row section sequences
// (with direction), chord legs, stop positions, flows per section geometry,
// and every other field (deps/arrs, calls, dests/srcs = city stats, chords).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "../web/node_modules/esbuild/lib/main.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const [oldDir, newDir] = process.argv.slice(2);
if (!oldDir || !newDir) throw new Error("usage: check_pack_roundtrip.mjs <old dir> <new dir>");
const load = (dir, n) => {
  const p = path.join(dir, n);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  return JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(p + ".br")).toString("utf8"));
};
const outFile = path.join(here, ".build/lib-roundtrip.mjs");
await build({ entryPoints: [path.join(here, "../web/src/lib.ts")], bundle: true, format: "esm", platform: "node", outfile: outFile, logLevel: "error" });
const lib = await import(outFile);

const files = ["shared", "out-map", "out-tables", "in-map", "in-tables"];
const O = Object.fromEntries(files.map((f) => [f, load(oldDir, `atlas-v2-${f}.json`)]));
const N = Object.fromEntries(files.map((f) => [f, load(newDir, `atlas-v2-${f}.json`)]));
for (const f of files) lib.requireFmt(N[f].fmt, f);
if (O["out-tables"].fmt !== 4) throw new Error("old pack is not fmt 4");
let fails = 0;
const fail = (m) => { if (fails++ < 20) console.log("  FAIL " + m); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// decode the new pack exactly as the client does at load
for (const o of N["out-map"].origins) lib.decodeFlows(o.flows);
for (const o of N["in-map"].origins) lib.decodeFlows(o.in_flows);
const nOut = lib.expandOutTables(N["out-tables"]);
const nIn = lib.expandInTables(N["in-tables"]);

// geometry key of every section id, per section list
const gkey = (secs) => secs.map((s) => s.g + "|" + (s.h ? 1 : 0));
const G = {
  out: { old: gkey(O.shared.sections), new: gkey(N.shared.sections) },
  in: { old: gkey(O.shared.in_sections), new: gkey(N.shared.in_sections) },
};
for (const d of ["out", "in"]) {
  if (!eq([...G[d].old].sort(), [...G[d].new].sort())) fail(`${d} sections are not the same multiset of geometries`);
}
for (const k of ["city_table", "station_table", "train_table", "network"])
  if (!eq(O.shared[k], N.shared[k])) fail(`shared ${k} differs`);
// signed id -> "geometry/direction" token
const seq = (path, keys) => path.map((v) => (v < 0 ? keys[~v] + "~" : keys[v]));
const flowKey = (rows, keys) => rows.map((r) => keys[r[0]] + "|" + r.slice(1).join(",")).sort();

let rows = 0, legs = 0, stops = 0, flows = 0;
const n = O["out-map"].origins.length;
if (N["out-map"].origins.length !== n) fail("origin count");
for (let i = 0; i < n; i++) {
  const om = O["out-map"].origins[i], nm = N["out-map"].origins[i];
  const ot = O["out-tables"].origins[i], nt = nOut.origins[i];
  const oim = O["in-map"].origins[i], nim = N["in-map"].origins[i];
  const oit = O["in-tables"].origins[i], nit = nIn.origins[i];
  const tag = om.zh;
  // everything but the flows (identity, city stats dests/srcs, chords, fully_tracked)
  const { flows: of, ...omRest } = om, { flows: nf, ...nmRest } = nm;
  if (!eq(omRest, nmRest)) fail(`${tag} out-map fields`);
  const { in_flows: oif, ...oimRest } = oim, { in_flows: nif, ...nimRest } = nim;
  if (!eq(oimRest, nimRest)) fail(`${tag} in-map fields`);
  if (!eq(flowKey(of, G.out.old), flowKey(nf, G.out.new))) fail(`${tag} out flows by geometry`);
  if (!eq(flowKey(oif, G.in.old), flowKey(nif, G.in.new))) fail(`${tag} in flows by geometry`);
  for (let k = 1; k < nf.length; k++) if (nf[k][0] < nf[k - 1][0]) { fail(`${tag} out flows not sorted`); break; }
  flows += of.length + oif.length;
  // out tables
  for (const k of ["deps", "calls"]) if (!eq(ot[k], nt[k])) fail(`${tag} out ${k}`);
  for (let r = 0; r < ot.deps.length; r++) {
    rows++;
    if (!eq(seq(ot.dep_secs[r], G.out.old), seq(nt.dep_secs[r], G.out.new))) fail(`${tag} dep row ${r} sections`);
    if (!eq(ot.dep_chord_legs[r], nt.dep_chord_legs[r])) fail(`${tag} dep row ${r} chord legs`);
    if (!eq(ot.dep_stop_pos[r], nt.dep_stop_pos[r])) fail(`${tag} dep row ${r} stop pos`);
    legs += ot.dep_chord_legs[r].length;
    stops += ot.dep_stop_pos[r].length;
  }
  for (const k of ["arrs", "in_calls"]) if (!eq(oit[k], nit[k])) fail(`${tag} in ${k}`);
  for (let r = 0; r < oit.arrs.length; r++) {
    rows++;
    if (!eq(seq(oit.arr_secs[r], G.in.old), seq(nit.arr_secs[r], G.in.new))) fail(`${tag} arr row ${r} sections`);
    if (!eq(oit.arr_chord_legs[r], nit.arr_chord_legs[r])) fail(`${tag} arr row ${r} chord legs`);
    legs += oit.arr_chord_legs[r].length;
  }
}
console.log(`${n} origins, ${rows} dep/arr rows, ${legs} chord legs, ${stops} stop positions, ${flows} flow rows compared`);
console.log(fails ? `FAIL (${fails})` : "ROUNDTRIP OK: fmt 5 decodes identically to fmt 4");
process.exit(fails ? 1 : 0);
