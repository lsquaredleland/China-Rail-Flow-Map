/* Bundle the React + TSX sources into the inline module script that
   dist/index.html carries (plus hashed lazy chunks in dist/assets), and inline src/styles/*.css into its <style>. Run with: bun bundle.mjs
   Produces dist/index.html from index.template.html (head + CSS verbatim)
   and copies public/assets into dist/assets. */
import { createHash } from "node:crypto";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { relative, resolve, sep } from "node:path";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

// Content-hash the Brotli data packs: public/assets/<name>.json.br (and
// <name>.safetensors.br) is served as dist/assets/<name>.<hash8>.json.br so the files can be
// `immutable`, and the name -> hashed-path map is baked into the bundle
// (index.html is the revalidated entry point that carries it). Source
// names stay unchanged for the pipeline scripts.
// The JSON tables stay in public/assets for the tests and pipeline tools;
// the client loads their .safetensors twins, so they are not deployed.
const TOOLS_ONLY = new Set(["atlas-v2-out-tables.json.br", "atlas-v2-in-tables.json.br"]);
const assetManifest = {};
const hashedAssets = [];
for (const f of readdirSync("public/assets")) {
  const ext = /\.(json|safetensors)\.br$/.exec(f);
  if (!ext || TOOLS_ONLY.has(f)) continue;
  const bytes = readFileSync(`public/assets/${f}`);
  const h = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const hashed = f.replace(ext[0], `.${h}.${ext[1]}.br`);
  assetManifest[`assets/${f.slice(0, -3)}`] = `assets/${hashed}`;
  hashedAssets.push([f, hashed, bytes]);
}
// GA4 Measurement ID (src/lib/analytics.ts), set in the Vercel production env only.
const gaId = process.env.GA_MEASUREMENT_ID ?? "";
if (gaId && !/^G-[A-Z0-9]+$/.test(gaId)) {
  console.error(`GA_MEASUREMENT_ID "${gaId}" is not a G-XXXXXXXXXX id`);
  process.exit(1);
}
const manifestDefine = {
  __ASSET_MANIFEST__: JSON.stringify(JSON.stringify(assetManifest)),
  __GA_ID__: JSON.stringify(gaId),
};

// Two esbuild passes so the inlined entry never statically imports a shared
// chunk (esbuild would hoist runtime helpers used by both into one, and every
// visitor would then fetch it):
//   1. the lazy graph: src/components/map/deck/DeckHost.ts -> hashed
//      dist/assets/DeckHost-<hash>.js (+ its own shared chunks);
//   2. the app entry src/main.tsx, inlined into index.html as a module script,
//      with load.ts's import("./DeckHost") pointed at the hashed file.
// Lazy code must therefore not rely on module-level state shared with the
// entry (pass state in, e.g. via MapCtx). Nothing is written until the checks pass.
const esbuild = await import("esbuild");
const common = {
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  outdir: "dist",
  metafile: true,
  write: false,
  define: { "process.env.NODE_ENV": '"production"', ...manifestDefine },
};
const relOf = (f) => relative(resolve("dist"), f.path).split(sep).join("/");
const lazy = await esbuild.build({
  ...common,
  entryPoints: { DeckHost: "src/components/map/deck/DeckHost.ts" },
  splitting: true,
  entryNames: "assets/[name]-[hash]",
  chunkNames: "assets/[name]-[hash]",
});
// The lazy graph is imperative (C23): a React in it would be a second copy,
// whose hooks throw against the entry's. Fail the build if one gets bundled.
const reactInputs = Object.keys(
  Object.assign({}, ...Object.values(lazy.metafile.outputs).map((o) => o.inputs)),
).filter((i) => /node_modules\/(react|react-dom|scheduler)\//.test(i));
if (reactInputs.length) {
  console.error(`React inputs in the lazy deck graph (${reactInputs.length}), e.g. ${reactInputs[0]}`);
  process.exit(1);
}
const chunkOuts = lazy.outputFiles.map((f) => ({ ...f, rel: relOf(f) }));
const deckChunks = chunkOuts.filter((o) => /^assets\/DeckHost-[^/]+\.js$/.test(o.rel));
if (deckChunks.length !== 1 || chunkOuts.some((o) => !/^assets\/[^/]+\.js$/.test(o.rel))) {
  console.error("unexpected lazy outputs:", chunkOuts.map((o) => o.rel).join(", "));
  process.exit(1);
}
const deckUrl = "./" + deckChunks[0].rel;
const pointAtChunk = {
  name: "deck-chunk",
  setup(b) {
    b.onResolve({ filter: /^\.\/DeckHost$/ }, (a) =>
      a.kind === "dynamic-import" ? { path: deckUrl, external: true } : undefined,
    );
  },
};
const app = await esbuild.build({
  ...common,
  entryPoints: { main: "src/main.tsx" },
  plugins: [pointAtChunk],
});
const entryOut = app.outputFiles.find((o) => relOf(o) === "main.js");
if (app.outputFiles.length !== 1 || !entryOut) {
  console.error("unexpected entry outputs:", app.outputFiles.map(relOf).join(", "));
  process.exit(1);
}
if (!entryOut.text.includes(deckUrl)) {
  console.error(`entry does not reference ${deckUrl}; the lazy import was not rewired`);
  process.exit(1);
}
// The inlined entry must stay deck-free, or every visitor pays for deck.gl.
const heavy = /node_modules\/(@deck\.gl|@luma\.gl)\//;
const entryMeta = Object.values(app.metafile.outputs)[0];
const leaked = Object.keys(entryMeta.inputs).filter((i) => heavy.test(i));
if (leaked.length) {
  console.error(`@deck.gl/@luma.gl inputs leaked into the inlined entry (${leaked.length}), e.g. ${leaked[0]}`);
  process.exit(1);
}
const DECK_BROTLI_BUDGET = 300 * 1024;
const kb = (n) => (n / 1024).toFixed(1) + " KB";
let totalBr = 0;
for (const o of chunkOuts) {
  const b = Buffer.from(o.contents);
  const br = brotliCompressSync(b, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  console.log(`chunk ${o.rel}: min ${kb(b.length)}, gzip ${kb(gzipSync(b).length)}, brotli ${kb(br)}`);
  totalBr += br;
}
// DeckHost-*.js plus its shared chunks are all fetched at startup of the map, so
// the budget applies to the whole lazy graph (only deck code lives in it).
console.log(`lazy chunks total brotli: ${kb(totalBr)} (budget ${DECK_BROTLI_BUDGET / 1024} KB)`);
if (totalBr > DECK_BROTLI_BUDGET) {
  console.error("lazy deck chunks exceed the brotli budget");
  process.exit(1);
}
// A literal "</script" inside a JS string (React DOM has one) would end
// the inline script element early; "<\/script" is the same string in JS.
const js = entryOut.text.replace(/<\/script/g, "<\\/script");
if (js.includes("</script")) {
  console.error("bundle still contains a </script\" sequence; refusing to inline");
  process.exit(1);
}

const tpl = readFileSync("index.template.html", "utf8");
for (const ph of ["/*__BUNDLE__*/", "/*__CSS__*/"]) {
  if (!tpl.includes(ph)) {
    console.error(`template is missing the ${ph} placeholder`);
    process.exit(1);
  }
}

// The stylesheet is src/styles/*.css, inlined into the template's <style>
// in this order (later files win ties, so the mobile overrides come last).
const CSS_ORDER = [
  "theme.css",
  "base.css",
  "controls.css",
  "map.css",
  "panels.css",
  "departures.css",
  "modal.css",
  "timeline.css",
  "overlays.css",
  "cards.css",
  "responsive.css",
];
const cssOnDisk = readdirSync("src/styles").filter((f) => f.endsWith(".css"));
const unlisted = cssOnDisk.filter((f) => !CSS_ORDER.includes(f));
if (unlisted.length) {
  console.error("src/styles has files missing from CSS_ORDER in bundle.mjs:", unlisted.join(", "));
  process.exit(1);
}
const css = CSS_ORDER.map((f) => readFileSync(`src/styles/${f}`, "utf8").trimEnd())
  .join("\n")
  .replace(/\n/g, "\n      ");

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
for (const f of TOOLS_ONLY) rmSync(`dist/assets/${f}`, { force: true });
// Hashed lazy chunks (deck.gl etc.).
mkdirSync("dist/assets", { recursive: true });
for (const o of chunkOuts) writeFileSync(`dist/${o.rel}`, o.contents);
writeFileSync(
  "dist/index.html",
  tpl.replace("/*__CSS__*/", () => css).replace("/*__BUNDLE__*/", () => js),
);
console.log("dist/index.html written, bundle bytes:", js.length);
