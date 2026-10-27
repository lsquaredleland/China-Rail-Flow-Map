// Full-scene WebGL context-loss check for the deck renderer (G1, C20):
// 广州 at 18:15 (stations + trains + flows), paused and playing.
// Counts non-empty (alpha > 0) deck-canvas pixels before the loss and after the
// restore, the number of Deck re-creations and pageerrors.
// usage: node tools/g1-ctxloss.mjs [base=dist] [--dpr 2]
import { launch, parseArgs, resolveBase, sleep } from "./common.mjs";

const { pos, opt } = parseArgs(process.argv.slice(2), ["dpr"]);
const dpr = +(opt.dpr || 2);
const { url, close } = await resolveBase(pos[0] || "dist");
const browser = await launch();
let errors = 0, bad = 0;
const nonEmpty = () => {
  const d = window.__deck, gl = d.device.handle, c = gl.canvas;
  const w = c.width, h = c.height, buf = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let n = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) n++;
  return n;
};
for (const playing of [false, true]) {
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => { errors++; console.log("  pageerror", e.message); });
  await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr });
  await pg.goto(`${url}/?theme=light`, { waitUntil: "networkidle0" });
  await pg.waitForFunction("window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading", { timeout: 60000 });
  await sleep(3000);
  await pg.evaluate(() => document.querySelector('button[title^="Expand 24h"]')?.click());
  await sleep(600);
  // Count on a paused, settled frame in both cases: a playing animation advances between two reads.
  await pg.evaluate(() => { window.__mapApi.setTime(1095); window.__mapApi.setPlaying(false); });
  await sleep(1000);
  await pg.waitForFunction("window.__deckStats.settled", { timeout: 20000 });
  const pre = await pg.evaluate(nonEmpty);
  const rec0 = await pg.evaluate(() => window.__deckStats.recreated);
  if (playing) await pg.evaluate(() => window.__mapApi.setPlaying(true)); // the loss hits a running animation
  await pg.evaluate(() => {
    const gl = window.__deck.device.handle;
    window.__lose = gl.getExtension("WEBGL_lose_context");
    window.__lose.loseContext();
  });
  await sleep(1500);
  const noticeShown = await pg.evaluate(() => { const n = document.querySelector(".deck-notice"); return !!n && n.style.display !== "none"; });
  await pg.evaluate(() => window.__lose.restoreContext());
  await sleep(2500);
  await pg.evaluate(() => { window.__mapApi.setPlaying(false); window.__mapApi.setTime(1095); });
  await sleep(600);
  await pg.waitForFunction("window.__deckStats.settled", { timeout: 20000 });
  const post = await pg.evaluate(nonEmpty);
  const rec1 = await pg.evaluate(() => window.__deckStats.recreated);
  const ratio = post / pre;
  const ok = Math.abs(ratio - 1) <= 0.01 && rec1 - rec0 === 1;
  if (!ok) bad++;
  console.log(`${playing ? "playing" : "paused "} dpr${dpr}: pre ${pre} post ${post} (${(100 * (ratio - 1)).toFixed(3)} %), recreated +${rec1 - rec0}, notice during loss ${noticeShown}${ok ? "" : "  FAIL"}`);
  await ctx.close();
}
console.log(`pageerrors ${errors}`);
await browser.close();
await close();
process.exit(bad || errors ? 1 : 0);
