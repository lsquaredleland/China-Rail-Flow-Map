// diagnose per-frame cost: node tools/spike/sweep.mjs dist "&renderer=deck" [--headed]
import { launch, parseArgs, resolveBase, sleep } from "../common.mjs";
const { pos, opt } = parseArgs(process.argv.slice(2));
const { url, close } = await resolveBase(pos[0] || "dist");
const browser = await launch({ headed: !!opt.headed });
const pg = await browser.newPage();
pg.on("pageerror", (e) => console.log("PAGEERR", e.message));
await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
await pg.goto(`${url}/?theme=light${pos[1] || ""}`, { waitUntil: "networkidle0" });
await pg.waitForFunction("window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading", { timeout: 90000 });
await sleep(3000);
await pg.evaluate(() => { window.__mapApi.setAnimEnabled(true); window.__mapApi.setPlaying(false); });
for (let rep = 0; rep < 3; rep++) {
  const r = await pg.evaluate(async () => {
    const M = window.__M, S = M.S.current;
    const dh = window.__deckHost, gl = dh.deck.device.handle, px = new Uint8Array(4);
    const out = [];
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      S.animTime = 360 + i * 3.6;
      const t0 = performance.now();
      window.__draw();
      const t1 = performance.now();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.push([+(t1 - t0).toFixed(1), +(performance.now() - t1).toFixed(1)]);
    }
    return out;
  });
  const js = r.map((x) => x[0]).sort((a, b) => a - b), gp = r.map((x) => x[1]).sort((a, b) => a - b);
  const q = (a, p) => a[Math.floor(a.length * p)];
  console.log("rep", rep, "js p50/p95/max", q(js, 0.5), q(js, 0.95), js[js.length - 1], "gpu-wait p50/p95/max", q(gp, 0.5), q(gp, 0.95), gp[gp.length - 1], "slow(>8ms js):", r.filter((x) => x[0] > 8).length);
}
await browser.close();
await close();
