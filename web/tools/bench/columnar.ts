/* Binary-columnar prototype of out-tables and shared geometry (brotli q11). Run: bun run bench -- --columnar [--dir D] */
import { readFileSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants as Z, gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
const dirArg = process.argv.indexOf("--dir");
const ASSETS = dirArg > 0 ? resolve(process.argv[dirArg + 1]) : resolve(import.meta.dir, "../../public/assets");
const lib = await import("../../src/lib/index");
const load = (n: string) => JSON.parse(brotliDecompressSync(readFileSync(join(ASSETS, n + ".json.br"))).toString("utf8"));
const br = (b: Uint8Array) => brotliCompressSync(b, { params: { [Z.BROTLI_PARAM_QUALITY]: 11, [Z.BROTLI_PARAM_LGWIN]: 24 } }).length;
const kb = (n: number) => (n / 1024).toFixed(0) + " KB";
const cat = (parts: ArrayBufferView[]) => { let n = 0; for (const p of parts) n += p.byteLength; const o = new Uint8Array(n); let w = 0; for (const p of parts) { o.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), w); w += p.byteLength; } return o; };
const report = (name: string, parts: Record<string, ArrayBufferView>) => {
  const all = cat(Object.values(parts));
  const rows = Object.entries(parts).map(([k, v]) => `${k} ${kb(v.byteLength)} raw / ${kb(br(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)))} br`);
  console.log(`${name}: raw ${kb(all.byteLength)}, brotli ${kb(br(all))}, gzip ${kb(gzipSync(all).length)}`);
  console.log("   " + rows.join("; "));
};

const ot = load("atlas-v2-out-tables");
const brJson = readFileSync(join(ASSETS, "atlas-v2-out-tables.json.br")).length;
console.log(`out-tables JSON: ${kb(brJson)} brotli (shipped)\n`);

// ---- paths: flat signed ids + offsets ----
const nT = ot.paths.length;
let total = 0; for (const p of ot.paths) total += p.length;
const pOff = new Uint32Array(nT + 1);
const pIds32 = new Int32Array(total);
const pIds16 = new Int16Array(total); // ids < 16731 -> fits with sign (~id)
const pDelta16 = new Int16Array(total);
{ let w = 0; for (let t = 0; t < nT; t++) { pOff[t] = w; let prev = 0; for (const v of ot.paths[t]) { pIds32[w] = v; pIds16[w] = v; const id = v < 0 ? ~v : v; const d = id - prev; pDelta16[w] = Math.max(-32768, Math.min(32767, d)) * (v < 0 ? -1 : 1) ; prev = id; w++; } } pOff[nT] = w; }
// stop_pos
let sTot = 0; for (const p of ot.stop_pos) sTot += p.length;
const sOff = new Uint32Array(nT + 1); const sPos16 = new Uint16Array(sTot); const sDelta8 = new Uint8Array(sTot);
{ let w = 0; for (let t = 0; t < nT; t++) { sOff[t] = w; let prev = 0; for (const v of ot.stop_pos[t]) { sPos16[w] = v; sDelta8[w] = Math.min(255, v - prev); prev = v; w++; } } sOff[nT] = w; }
// chords (3 trains): json string
const chordsJson = new TextEncoder().encode(JSON.stringify(ot.chords));
// origins: deps 9 cols, calls 6 cols, dep_off
let nDep = 0, nCall = 0; for (const o of ot.origins) { nDep += o.deps.length; for (const c of o.calls) nCall += c.length; }
const oDepOff = new Uint32Array(ot.origins.length + 1);
const dep32 = Array.from({ length: 9 }, () => new Int32Array(nDep));
const depNarrow = [new Uint16Array(nDep), new Uint16Array(nDep), new Uint16Array(nDep), new Uint16Array(nDep), new Uint16Array(nDep), new Uint16Array(nDep), new Uint16Array(nDep), new Uint8Array(nDep), new Int16Array(nDep)];
const depOff16 = new Uint16Array(nDep);
const oCallOff = new Uint32Array(ot.origins.length + 1); // per origin: number of dest lists
let nDestLists = 0; for (const o of ot.origins) nDestLists += o.calls.length;
const callListOff = new Uint32Array(nDestLists + 1);
const call32 = Array.from({ length: 6 }, () => new Int32Array(nCall));
const callNarrow = [new Uint16Array(nCall), new Int16Array(nCall), new Int16Array(nCall), new Uint8Array(nCall), new Uint8Array(nCall), new Uint16Array(nCall)];
{ let d = 0, c = 0, l = 0; for (let i = 0; i < ot.origins.length; i++) { const o = ot.origins[i]; oDepOff[i] = d; oCallOff[i] = l; for (let r = 0; r < o.deps.length; r++) { const row = o.deps[r]; for (let k = 0; k < 9; k++) { dep32[k][d] = row[k]; depNarrow[k][d] = row[k]; } depOff16[d] = o.dep_off[r]; d++; } for (const list of o.calls) { callListOff[l++] = c; for (const row of list) { for (let k = 0; k < 6; k++) { const v = row[k] ?? -1; call32[k][c] = v; callNarrow[k][c] = v; } c++; } } } oDepOff[ot.origins.length] = d; oCallOff[ot.origins.length] = l; callListOff[l] = c; }
console.log(`counts: trains ${nT}, path entries ${total}, stop entries ${sTot}, deps ${nDep}, calls ${nCall}\n`);

report("A  int32 columns (paths i32, stop_pos u16, deps 9xi32, calls 6xi32)", { pOff, pIds32, sOff, sPos16, chords: chordsJson, oDepOff, ...Object.fromEntries(dep32.map((c, i) => ["dep" + i, c])), depOff16, oCallOff, callListOff, ...Object.fromEntries(call32.map((c, i) => ["call" + i, c])) });
report("B  narrow columns (paths i16, stop_pos u16, deps narrow, calls narrow)", { pOff, pIds16, sOff, sPos16, chords: chordsJson, oDepOff, ...Object.fromEntries(depNarrow.map((c, i) => ["dep" + i, c])), depOff16, oCallOff, callListOff, ...Object.fromEntries(callNarrow.map((c, i) => ["call" + i, c])) });
report("C  narrow + delta-coded paths (i16 deltas) and stop_pos (u8 deltas)", { pOff, pDelta16, sOff, sDelta8, chords: chordsJson, oDepOff, ...Object.fromEntries(depNarrow.map((c, i) => ["dep" + i, c])), depOff16, oCallOff, callListOff, ...Object.fromEntries(callNarrow.map((c, i) => ["call" + i, c])) });
// per-part breakdown of B for the doc
console.log();

// ---- shared geometry ----
const sh = load("atlas-v2-shared");
const brShared = readFileSync(join(ASSETS, "atlas-v2-shared.json.br")).length;
const secStrings = sh.sections.map((s: any) => s.g);
const secJson = new TextEncoder().encode(JSON.stringify(secStrings));
console.log(`shared JSON: ${kb(brShared)} brotli (shipped); sections polyline strings alone: ${kb(secJson.byteLength)} raw / ${kb(br(secJson))} br`);
const flats = secStrings.map((g: string) => lib.decodeFlat(g));
let np = 0; for (const f of flats) np += f.length / 2;
const gOff = new Uint32Array(flats.length + 1);
const abs32 = new Int32Array(np * 2);
const f32 = new Float32Array(np * 2);
const d16 = new Int16Array(np * 2); const first32 = new Int32Array(flats.length * 2);
let clipped = 0;
{ let w = 0; for (let i = 0; i < flats.length; i++) { gOff[i] = w; const f = flats[i]; let px = 0, py = 0; for (let j = 0; j < f.length; j += 2) { const x = Math.round(f[j] * 1e4), y = Math.round(f[j + 1] * 1e4); abs32[w * 2] = x; abs32[w * 2 + 1] = y; f32[w * 2] = f[j]; f32[w * 2 + 1] = f[j + 1]; if (j === 0) { first32[i * 2] = x; first32[i * 2 + 1] = y; d16[w * 2] = 0; d16[w * 2 + 1] = 0; } else { const dx = x - px, dy = y - py; if (Math.abs(dx) > 32767 || Math.abs(dy) > 32767) clipped++; d16[w * 2] = dx; d16[w * 2 + 1] = dy; } px = x; py = y; w++; } } gOff[flats.length] = np; }
console.log(`sections: ${flats.length} polylines, ${np} points, deltas over int16: ${clipped}`);
report("G1 sections as int32 absolute 1e4 + offsets", { gOff, abs32 });
report("G2 sections as int16 deltas 1e4 + int32 first point + offsets", { gOff, first32, d16 });
report("G3 sections as float32 (what the client holds after decode)", { gOff, f32 });
