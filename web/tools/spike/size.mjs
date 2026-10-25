// M6: deck-only bundle (everything under @deck.gl / @luma.gl / @math.gl / ... that the spike imports,
// plus TailLayer), esm, minified, es2020; and the spike's whole host code on top.
import { build } from "esbuild";
import zlib from "node:zlib";
import fs from "node:fs";

const sizes = (b) => ({ min: b.length, gzip: zlib.gzipSync(b, { level: 9 }).length, brotli: zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length });
const kb = (o) => `${(o.min / 1024).toFixed(1)} KB min, ${(o.gzip / 1024).toFixed(1)} KB gzip, ${(o.brotli / 1024).toFixed(1)} KB brotli`;

fs.writeFileSync("tools/spike/.deck-entry.ts", 'export * from "../../src/components/map/deck/vendor";\nexport { TailLayer } from "../../src/components/map/deck/TailLayer";\n');
const common = { bundle: true, minify: true, format: "esm", target: "es2020", write: false, define: { "process.env.NODE_ENV": '"production"' }, metafile: true, logLevel: "error" };
const r = await build({ ...common, entryPoints: ["tools/spike/.deck-entry.ts"] });
const out = Buffer.from(r.outputFiles[0].contents);
console.log("deck vendor chunk (deck+luma+math+loaders, the 9 classes the spike uses + TailLayer):", kb(sizes(out)));
const by = {};
for (const [f, v] of Object.entries(Object.values(r.metafile.outputs)[0].inputs)) {
  const m = f.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
  const k = m ? m[1] : "(app)";
  by[k] = (by[k] || 0) + v.bytesInOutput;
}
console.log("by package (bytes in output):", Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${(v / 1024).toFixed(0)}KB`).join(", "));
fs.rmSync("tools/spike/.deck-entry.ts");

// whole spike entry as ESM (react + app + deck), for the delta against the Canvas-only build
const app = await build({ ...common, entryPoints: ["src/main.tsx"], define: { ...common.define, __ASSET_MANIFEST__: "{}" } });
console.log("whole app with deck (esm, min):", kb(sizes(Buffer.from(app.outputFiles[0].contents))));
