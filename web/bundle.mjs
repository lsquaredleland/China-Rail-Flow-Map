/* Bundle the React + TSX sources into the single classic script that
   dist/index.html carries. Run with: bun bundle.mjs
   Produces dist/index.html from index.template.html (head + CSS verbatim)
   and copies public/assets into dist/assets. */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

// Content-hash the Brotli data packs: public/assets/<name>.json.br is
// served as dist/assets/<name>.<hash8>.json.br so the files can be
// `immutable`, and the name -> hashed-path map is baked into the bundle
// (index.html is the revalidated entry point that carries it). Source
// names stay unchanged for the pipeline scripts.
const assetManifest = {};
const hashedAssets = [];
for (const f of readdirSync("public/assets")) {
  if (!f.endsWith(".json.br")) continue;
  const bytes = readFileSync(`public/assets/${f}`);
  const h = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const hashed = f.replace(/\.json\.br$/, `.${h}.json.br`);
  assetManifest[`assets/${f.slice(0, -3)}`] = `assets/${hashed}`;
  hashedAssets.push([f, hashed, bytes]);
}
const manifestDefine = { __ASSET_MANIFEST__: JSON.stringify(assetManifest) };

async function bundleIife(entry) {
  if (typeof Bun !== "undefined") {
    const result = await Bun.build({
      entrypoints: [entry],
      minify: true,
      format: "iife",
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"', ...manifestDefine },
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      process.exit(1);
    }
    return await result.outputs[0].text();
  }
  const esbuild = await import("esbuild");
  const res = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    define: { "process.env.NODE_ENV": '"production"', ...manifestDefine },
    write: false,
  });
  return res.outputFiles[0].text;
}
const rawJs = await bundleIife("src/main.tsx");
// A literal "</script" inside a JS string (React DOM has one) would end
// the inline script element early; "<\/script" is the same string in JS.
const js = rawJs.replace(/<\/script/g, "<\\/script");
if (js.includes("</script")) {
  console.error("bundle still contains a </script\" sequence; refusing to inline");
  process.exit(1);
}

const tpl = readFileSync("index.template.html", "utf8");
if (!tpl.includes("/*__BUNDLE__*/")) {
  console.error("template is missing the /*__BUNDLE__*/ placeholder");
  process.exit(1);
}

// Start from an empty dist/ so stale hashed files never accumulate.
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
for (const f of readdirSync("public")) {
  cpSync(`public/${f}`, `dist/${f}`, { recursive: true });
}
// Swap the unhashed packs the copy above brought along for hashed ones.
for (const [f, hashed, bytes] of hashedAssets) {
  rmSync(`dist/assets/${f}`);
  writeFileSync(`dist/assets/${hashed}`, bytes);
}
writeFileSync(
  "dist/index.html",
  tpl.replace("/*__BUNDLE__*/", () => js),
);
console.log("dist/index.html written, bundle bytes:", js.length);
