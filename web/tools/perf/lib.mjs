// Shared frame-time harness for origin.mjs and national.mjs.
//
// For each DPR and each view it runs N rAF frames with the 24h animation
// enabled (paused clock, animTime driven by the sweep) and reports rAF
// interval, draw (JS only) and draw + raster (a 1-pixel getImageData forces
// the raster flush) as mean / p50 / p95 / max.
//
// It prints UNMASKED_RENDERER_WEBGL and EXITS 1 if that contains
// "SwiftShader": software-rendered numbers are meaningless. --query '&renderer=deck'
// is appended to the page URL; on the deck renderer the frame flush is a readPixels
// and each row carries deck.metrics. --headed
// launches a visible window (use it when headless lands on SwiftShader).
// env CHROME_PATH overrides the Chrome binary.
import fs from "node:fs";
import { launch, parseArgs, resolveBase, sleep } from "../common.mjs";


const stat = (a) => {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  const f = (v) => +v.toFixed(2);
  return { mean: f(s.reduce((p, x) => p + x, 0) / n), p50: f(s[n >> 1]), p95: f(s[Math.floor(n * 0.95)]), max: f(s[n - 1]) };
};

/** cfg: { argv, defaults: {start, end, frames}, views: {name: "origin"|"fit"|"city"|null}, origin?: zh } */
export async function runPerf(cfg) {
const { pos, opt } = parseArgs(cfg.argv, ["frames", "dpr", "throttle", "start", "end", "out", "query", "select", "infra"]);
const FR = +(opt.frames || cfg.defaults.frames), thr = +(opt.throttle || 1);
const START = +(opt.start ?? cfg.defaults.start), END = +(opt.end ?? cfg.defaults.end);
const STEP = (END - START) / FR;
const dprs = (opt.dpr || "1,2").split(",").map(Number);
const { url, close } = await resolveBase(pos[0] || "dist");
const browser = await launch({ headed: !!opt.headed });
const rows = [];
let renderer = "";
try {
  for (const dpr of dprs) {
    const pg = await browser.newPage();
    pg.on("pageerror", (e) => console.log("PAGEERR", e.message));
    await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr });
    await pg.goto(`${url}/?theme=light${opt.query || ""}`, { waitUntil: "networkidle0" });
    await pg.waitForFunction("window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading", { timeout: 90000 });
    await sleep(3000);
    if (!renderer) {
      renderer = await pg.evaluate(() => {
        const gl = document.createElement("canvas").getContext("webgl");
        const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "(no WebGL / no debug info)";
      });
      console.log("UNMASKED_RENDERER_WEBGL:", renderer);
      if (/SwiftShader/i.test(renderer)) {
        console.error("FAIL: software renderer (SwiftShader); numbers are meaningless." + (opt.headed ? "" : " Rerun with --headed."));
        await browser.close(); await close();
        process.exit(1);
      }
    }
    const cdp = await pg.createCDPSession();
    if (thr > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: thr });
    if (cfg.origin) {
      await pg.evaluate((zh) => window.__selectOrigin(zh), cfg.origin);
      await sleep(3000);
    }
    // --select 深圳 selects that destination; --infra 1 turns the infrastructure overlay on.
    if (opt.select) { await pg.evaluate((zh) => window.__mapApi.selectDestByZh(zh), opt.select); await sleep(1500); }
    if (opt.infra) { await pg.evaluate(() => { const e = document.querySelector("#tglInfra"); e && e.click(); }); await sleep(800); }
    await pg.evaluate(() => { window.__mapApi.setAnimEnabled(true); window.__mapApi.setPlaying(false); });
    for (const [name, kind] of Object.entries(cfg.views)) {
      if (kind === "fit") await pg.evaluate(() => window.__mapApi.fitCountry());
      else if (kind === "home") await pg.evaluate(() => window.__mapApi.fitHome());
      else if (kind === "city") await pg.evaluate(() => window.__mapApi.panZoomTo(113.26, 23.13, window.__M.S.current.fitScale * 10));
      await sleep(500);
      const r = await pg.evaluate(async (FR, START, STEP) => {
        const M = window.__M, S = M.S.current, cv = M.canvasRef.current, ctx = cv.getContext("2d");
        // Deck renderer: flush with a readPixels on the deck context (a 2D getImageData would not wait for WebGL).
        const DH = window.__deck; const gl = DH && DH.device.handle; const px4 = new Uint8Array(4);
        const flushFn = () => { if (gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px4); else ctx.getImageData(0, 0, 1, 1); };
        const run = (n, flush) => new Promise((res) => {
          const iv = [], dr = []; let last = 0, i = 0;
          const step = (ts) => {
            if (last) iv.push(ts - last);
            last = ts;
            S.animTime = START + i * STEP;
            const t0 = performance.now();
            window.__draw();
            if (flush) flushFn();
            dr.push(performance.now() - t0);
            if (++i < n) requestAnimationFrame(step); else res({ iv, dr });
          };
          requestAnimationFrame(step);
        });
        await run(30, false); // warm up
        const a = await run(FR, false);
        await new Promise((r) => setTimeout(r, 300));
        const f = await run(FR, true);
        const metrics = DH ? JSON.parse(JSON.stringify(DH.metrics)) : null;
        return { active: M.activeTimeline() ? 1 : 0, a, f, metrics };
      }, FR, START, STEP);
      const row = {
        dpr, throttle: thr, view: name, renderer, frames: FR,
        rafIntervalMs: stat(r.a.iv),
        droppedPct: +((100 * r.a.iv.filter((x) => x > 20).length) / r.a.iv.length).toFixed(1),
        drawJsMs: stat(r.a.dr),
        drawPlusRasterMs: stat(r.f.dr),
        deckMetrics: r.metrics, // null on the Canvas renderer
      };
      rows.push(row);
    }
    await pg.close();
  }
} finally {
  await browser.close();
  await close();
}
console.log(`\nsweep animTime ${START} -> ${END} over ${FR} frames, throttle ${thr}x`);
console.log("\nview            dpr  raf p50/p95/max      drop%  draw-js mean/p95    draw+raster mean/p95");
for (const r of rows) {
  console.log(
    r.view.padEnd(15), String(r.dpr).padEnd(4),
    `${r.rafIntervalMs.p50}/${r.rafIntervalMs.p95}/${r.rafIntervalMs.max}`.padEnd(20),
    String(r.droppedPct).padEnd(6),
    `${r.drawJsMs.mean}/${r.drawJsMs.p95}`.padEnd(19),
    `${r.drawPlusRasterMs.mean}/${r.drawPlusRasterMs.p95}`,
  );
}
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(rows, null, 1));
}
