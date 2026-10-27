// Headless WebGL smoke test (CI job `web-smoke`): serves dist/, loads it in headless Chrome on
// SwiftShader and checks that the lazy deck chunk boots and draws. Deterministic assertions only
// (no pixel comparison: SwiftShader anti-aliasing differs from the GPU's).
//   0 pageerror, the DeckHost-*.js chunk loaded, __deckStats.afterRenders >= 1 (or settled),
//   and the map area is not a single flat colour.
// usage: CHROME_PATH=/usr/bin/google-chrome node tools/smoke.mjs [base=dist]
import { launch, resolveBase, parseArgs } from "./common.mjs";
import { decodePng } from "./shots/cmp.mjs";

const { pos } = parseArgs(process.argv.slice(2));
const { url, close } = await resolveBase(pos[0] || "dist");
const browser = await launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const fails = [];
try {
  const pg = await browser.newPage();
  const errs = [];
  let chunk = 0;
  pg.on("pageerror", (e) => errs.push(e.message));
  pg.on("response", (r) => { if (/\/assets\/DeckHost-[^/]+\.js$/.test(r.url()) && r.ok()) chunk++; });
  await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await pg.goto(`${url}/?theme=light`, { waitUntil: "load" });
  await pg.waitForFunction("window.__deckStats && (window.__deckStats.afterRenders >= 1 || window.__deckStats.settled)", { timeout: 60000 })
    .catch(() => fails.push("no rendered frame in __deckStats within 60 s"));
  await pg.waitForFunction("window.__deckStats && window.__deckStats.settled", { timeout: 20000 }).catch(() => {});
  const stats = await pg.evaluate(() => window.__deckStats || null);
  const renderer = await pg.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const e = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return gl && e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?";
  });
  const box = await pg.evaluate(() => {
    const r = document.querySelector("#mapwrap")?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  });
  let nonFlat = 0;
  if (box) {
    const img = decodePng(await pg.screenshot({ clip: box }));
    const px = new Uint32Array(img.px.buffer, img.px.byteOffset, img.w * img.h);
    for (let i = 0; i < px.length; i++) if (px[i] !== px[0]) nonFlat++;
  } else fails.push("#mapwrap not found");
  console.log(`renderer "${renderer}"  chunk responses ${chunk}  stats ${JSON.stringify(stats)}  non-flat px ${nonFlat}  pageerrors ${errs.length}`);
  if (errs.length) fails.push(`pageerrors: ${errs.join(" | ")}`);
  if (!chunk) fails.push("DeckHost chunk never loaded");
  if (stats && stats.errors.length) fails.push(`deck onError: ${stats.errors.join(" | ")}`);
  if (nonFlat < 1000) fails.push(`map area looks empty (${nonFlat} non-flat px)`);
} finally {
  await browser.close();
  await close();
}
if (fails.length) { console.error("SMOKE FAIL\n  " + fails.join("\n  ")); process.exit(1); }
console.log("SMOKE OK");
