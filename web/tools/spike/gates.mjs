// Phase 0 gate probes. usage: node tools/spike/gates.mjs <dist> <m4|m7|m9|m12|m13|n> [--headed]
import { launch, parseArgs, resolveBase, sleep } from "../common.mjs";
const { pos, opt } = parseArgs(process.argv.slice(2), ["synth"]);
const which = pos[1];
const { url, close } = await resolveBase(pos[0] || "dist");
const extra = which === "m9" ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-gl=angle"] : [];
const browser = await launch({ headed: !!opt.headed, args: extra });
let errs = 0;
const ready = "window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading";
async function open(q, { dpr = 2, thr = 1 } = {}) {
  const pg = await browser.newPage();
  pg.on("pageerror", (e) => { errs++; console.log("PAGEERR", e.message); });
  await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr });
  if (thr > 1) await (await pg.createCDPSession()).send("Emulation.setCPUThrottlingRate", { rate: thr });
  await pg.goto(`${url}/?theme=light${q}`, { waitUntil: "networkidle0" });
  await pg.waitForFunction(ready, { timeout: 120000 });
  return pg;
}
try {
  if (which === "m4") {
    const pg = await open("&renderer=deck&gputime=1");
    await sleep(6000);
    await pg.evaluate(() => { window.__mapApi.selectDestByZh("深圳"); });
    await sleep(500);
    await pg.evaluate(() => document.querySelector("#tglInfra").click());
    await pg.evaluate(() => { window.__mapApi.setAnimEnabled(true); window.__mapApi.setTime(1095); });
    await sleep(2500);
    const r = await pg.evaluate(() => {
      const d = window.__deck;
      d.redraw("x"); try { d._getFrameStats(); d._getMetrics(); } catch (e) {}
      return { m: { gpuMemory: d.metrics.gpuMemory, bufferMemory: d.metrics.bufferMemory, textureMemory: d.metrics.textureMemory }, bufs: window.__bufBytes() };
    });
    console.log("M4", JSON.stringify(r, null, 1));
  } else if (which === "m7") {
    for (const thr of [1, 4]) {
      const res = [];
      for (let i = 0; i < 4; i++) {
        const pg = await open("&renderer=deck", { thr });
        await sleep(1000);
        res.push(await pg.evaluate(() => ({ sinceAtlasReady: window.__deckStats.firstFrameMs, sinceDeckCreate: window.__deckStats.firstFrameSinceCreateMs })));
        await pg.close();
      }
      console.log("M7 throttle", thr, JSON.stringify(res), "(run 0 = cold cache)");
    }
  } else if (which === "pick") {
    const pg = await open("&renderer=deck");
    await sleep(5000);
    await pg.evaluate(() => { window.__mapApi.setAnimEnabled(true); window.__mapApi.setPlaying(false); window.__mapApi.setTime(1095); window.__mapApi.fitHome(); });
    await sleep(1500);
    const tgt = await pg.evaluate(() => {
      const M = window.__M, h = window.__deckHost, r = document.querySelector("#map").getBoundingClientRect();
      const tr = h.trainList.find((t) => { const x = M.X(t.lon), y = M.Y(t.lat); return x > 60 && x < M.S.current.W - 60 && y > 60 && y < M.S.current.H - 60; });
      const st = h.stationList.find((d) => { const x = M.X(d.pos[0]), y = M.Y(d.pos[1]); return x > 60 && x < M.S.current.W - 60 && y > 60 && y < M.S.current.H - 60 && Math.hypot(x - M.X(M.P.current.cur.o.pt[0]), y - M.Y(M.P.current.cur.o.pt[1])) > 40 && !h.trainList.some((t) => Math.hypot(M.X(t.lon) - x, M.Y(t.lat) - y) < 25); });
      return { tr: tr && { x: r.left + M.X(tr.lon), y: r.top + M.Y(tr.lat), code: tr.code }, st: st && { x: r.left + M.X(st.pos[0]), y: r.top + M.Y(st.pos[1]), zh: st.c.zh }, n: h.trainList.length };
    });
    console.log("targets", JSON.stringify(tgt));
    const tip = () => pg.evaluate(() => { const t = document.querySelector("#tooltip"); return t.classList.contains("show") ? t.innerText.replace(/\n/g, " | ").slice(0, 90) : "(hidden)"; });
    await pg.mouse.move(tgt.tr.x, tgt.tr.y); await sleep(400);
    console.log("hover train", tgt.tr.code, "->", await tip());
    await pg.mouse.move(tgt.st.x, tgt.st.y); await sleep(400);
    console.log("hover station", tgt.st.zh, "->", await tip());
    await pg.mouse.move(2, 2);
  } else if (which === "m9") {
    const pg = await open("&renderer=deck", { dpr: 1 });
    await sleep(4000);
    const r = await pg.evaluate(() => {
      const d = window.__deck, gl = d.device.handle;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let nz = 0; for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) nz++;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "?", afterRenders: window.__deckStats.afterRenders, nonEmptyPx: nz, total: w * h, errors: window.__deckStats.errors };
    });
    console.log("M9", JSON.stringify(r), "pageerrors", errs);
  } else if (which === "m12") {
    const pg = await open("&renderer=deck");
    await sleep(2000);
    const before = await pg.evaluate(() => window.__deckStats.afterRenders);
    await pg.evaluate(() => { const gl = window.__deck.device.handle; window.__lc = gl.getExtension("WEBGL_lose_context"); window.__lc.loseContext(); });
    await sleep(1000);
    const lost = await pg.evaluate(() => ({ errors: window.__deckStats.errors, lost: window.__deck.device.handle.isContextLost() }));
    console.log("M12 after loss", JSON.stringify(lost));
    await pg.evaluate(() => { try { window.__lc.restoreContext(); } catch (e) {} });
    await sleep(500);
    await pg.evaluate(() => window.__deckRecreate());
    await sleep(2500);
    const after = await pg.evaluate(() => {
      const gl = window.__deck.device.handle;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let nz = 0; for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) nz++;
      return { afterRenders: window.__deckStats.afterRenders, recreated: window.__deckStats.recreated, nonEmptyPx: nz };
    });
    console.log("M12 after recreate", JSON.stringify(after), "afterRendersBefore", before, "pageerrors", errs);
  } else if (which === "m13") {
    const pg = await open("&renderer=deck");
    await sleep(3000);
    const a = await pg.evaluate(() => window.__tailProbe());
    console.log("M13 alpha along a 120px tail (x=0.5,5,30,60,90,115,119.5px from source):", JSON.stringify(a.map((v) => +v.toFixed(3))));
    await pg.screenshot({ path: pos[2] || "tail-probe.png" });
  } else if (which === "n") {
    // national secondary: M5n heap delta, M7n first frame, M4n gpu memory
    const q = "&renderer=deck&national=deck&natSynth=" + (opt.synth || 0) + "&gputime=1";
    const pg = await open(q);
    await sleep(3000);
    const cdp = await pg.createCDPSession();
    await cdp.send("HeapProfiler.enable");
    const heap = async () => { await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("HeapProfiler.collectGarbage"); const u = await cdp.send("Runtime.getHeapUsage"); return u.usedSize + (u.backingStorageSize || 0); };
    const h0 = await heap();
    await pg.evaluate(() => { window.__mapApi.setAnimEnabled(true); window.__mapApi.setTime(1095); });
    await pg.waitForFunction("window.__nat && window.__nat.ready", { timeout: 90000 });
    await sleep(3000);
    const h1 = await heap();
    const r = await pg.evaluate(() => {
      const d = window.__deck; d.redraw("x"); try { d._getFrameStats(); d._getMetrics(); } catch (e) {}
      return { nat: { load: window.__nat.load, count: window.__nat.count, tails: window.__nat.tails, firstFrameMs: window.__nat.firstFrameAt - window.__nat.startedAt }, gpu: { gpuMemory: d.metrics.gpuMemory, bufferMemory: d.metrics.bufferMemory }, bufs: window.__bufBytes() };
    });
    console.log("N", JSON.stringify({ heapBeforeMB: +(h0 / 1048576).toFixed(1), heapAfterMB: +(h1 / 1048576).toFixed(1), heapDeltaMB: +((h1 - h0) / 1048576).toFixed(1), ...r }, null, 1));
  }
} finally {
  await browser.close();
  await close();
}
