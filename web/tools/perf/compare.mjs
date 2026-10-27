// Renderer-agnostic frame-time, memory and load harness: the same scenarios
// on any build that exposes window.__mapApi, window.__M and window.__draw,
// so a Canvas build (main) and the deck.gl build (deckgl) are measured the
// same way. Written for the pre-main audit (docs/history/AUDIT_PRE_MAIN.md §4); the
// raw results live under docs/perf/.
//
// usage: node tools/perf/compare.mjs <base> --label canvas|deck [--dpr 1,2]
//          [--throttle 1,4] [--reps 3] [--frames 300] [--national trains|both]
//          [--scenarios origin-initial,city-x10,anim-peak,switch,load]
//          [--fitScale N] [--out f.json] [--headed]
//   base        http(s) URL of a running build, or a directory (e.g. dist) that
//               is served with the Vercel headers on a free port
//   --national  national mode (deck only): `trains` = A, `both` = A+B; the
//               harness clicks the 24h expand button (the dots exist only
//               with the animation bar open) and sweeps the 18:15 peak over
//               the origin-initial, national-fit and city-x10 views
//   --fitScale  the national-fit scale to use for city-x10 when the page has
//               no __M (both builds expose it; kept as an override)
// Per scenario it reports rAF interval, draw (JS only) and draw + raster
// (a readPixels / getImageData forces the raster flush) as p50 / p95 / max
// over `frames` frames, the JS heap after a forced GC, the DOM canvases'
// backing-store bytes and, on deck, deck.metrics before and after one pick.
// `switch` times an origin switch (long tasks and the longest rAF gap in the
// 2 s after __selectOrigin); `load` is a cold then a warm navigation with
// first paint, map-ready and transfer sizes from the Resource Timing API.
// It prints UNMASKED_RENDERER_WEBGL and EXITS 1 on SwiftShader (lib.mjs rule).
import fs from "node:fs";
import os from "node:os";
import { launch, parseArgs, resolveBase, sleep } from "../common.mjs";

const { pos, opt } = parseArgs(process.argv.slice(2), [
  "label", "dpr", "throttle", "reps", "frames", "national", "scenarios", "fitScale", "out", "query", "net",
]);
// --net slow4g: Lighthouse's mobile preset (1.6 Mbps down, 750 kbps up, 150 ms RTT) for the load scenario.
const NET = { slow4g: { latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 } }[opt.net || ""] || null;
const LABEL = opt.label || "build";
const FR = +(opt.frames || 300);
const REPS = +(opt.reps || 3);
const dprs = (opt.dpr || "1,2").split(",").map(Number);
const throttles = (opt.throttle || "1,4").split(",").map(Number);
const NATIONAL = opt.national || null; // "trains" | "both" | null
const SCEN = new Set(
  (opt.scenarios || (NATIONAL ? "origin-initial,national-fit,city-x10" : "origin-initial,city-x10,anim-peak,switch,load")).split(","),
);
const fitScaleOverride = opt.fitScale ? +opt.fitScale : null;
const query = (NATIONAL ? "&national=1" + (NATIONAL === "trains" ? "&natLayer=none" : "") : "") + (opt.query || "");

const stat = (a) => {
  if (!a.length) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const s = [...a].sort((x, y) => x - y), n = s.length;
  const f = (v) => +v.toFixed(2);
  return { mean: f(s.reduce((p, x) => p + x, 0) / n), p50: f(s[n >> 1]), p95: f(s[Math.min(n - 1, Math.floor(n * 0.95))]), max: f(s[n - 1]) };
};
const READY = "window.__mapApi && window.__M && !document.getElementById('loading')";

const { url, close } = await resolveBase(pos[0] || "dist");
const browser = await launch({ headed: !!opt.headed });
const rows = [];
const loads = [];
let renderer = "";
const t0 = Date.now();

/* In-page: wait until the renderer has drawn (deck: settled; canvas: next two frames). */
const settle = async (pg) => {
  await pg.waitForFunction("!window.__deckStats || window.__deckStats.settled", { timeout: 20000 }).catch(() => {});
  await pg.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};

async function openPage(dpr, thr) {
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => console.log("PAGEERR", e.message));
  await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr });
  const cdp = await pg.createCDPSession();
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  if (thr > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: thr });
  await pg.goto(`${url}/?theme=light${query}`, { waitUntil: "networkidle0" });
  await pg.waitForFunction(READY, { timeout: 90000 });
  if (!renderer) {
    renderer = await pg.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "(no WebGL / no debug info)";
    });
    console.log("UNMASKED_RENDERER_WEBGL:", renderer);
    if (/SwiftShader/i.test(renderer)) {
      console.error("FAIL: software renderer (SwiftShader); numbers are meaningless. Rerun with --headed.");
      await browser.close(); await close();
      process.exit(1);
    }
  }
  await sleep(2000);
  if (NATIONAL) {
    // The dots exist only with the animation bar open: press the 24h expand button, then pause.
    await pg.evaluate(() => document.querySelector('button[title^="Expand 24h"]')?.click());
    await pg.waitForFunction("window.__deckStats && window.__deckStats.natDots > 0", { timeout: 60000 });
    await pg.evaluate(() => window.__mapApi.setPlaying(false));
  } else {
    await pg.evaluate(() => { window.__selectOrigin("广州"); });
    await sleep(1500);
    await pg.evaluate(() => { window.__mapApi.setAnimEnabled(true); window.__mapApi.setPlaying(false); });
  }
  await settle(pg);
  return { ctx, pg, cdp };
}

/* One sweep: `frames` rAF frames, animTime START..END, draw via __mapApi.setTime
   (synchronous in both renderers), then the same with a raster flush. */
async function sweep(pg, start, end, frames) {
  return pg.evaluate(async (FR, START, END) => {
    const STEP = (END - START) / FR;
    const deck = window.__deck;
    const gl = deck ? deck.device.handle : null;
    const px4 = new Uint8Array(4);
    const cv2 = deck ? null : document.getElementById("map").getContext("2d");
    const flushFn = deck
      ? () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px4); }
      : () => { cv2.getImageData(0, 0, 1, 1); };
    const run = (n, flush) => new Promise((res) => {
      const iv = [], dr = []; let last = 0, i = 0;
      const step = (ts) => {
        if (last) iv.push(ts - last);
        last = ts;
        const t0 = performance.now();
        window.__mapApi.setTime(START + i * STEP);
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
    const metrics = deck ? JSON.parse(JSON.stringify(deck.metrics)) : null;
    const ds = window.__deckStats;
    const S = window.__M.S.current;
    return { a, f, metrics, natDots: ds ? ds.natDots : 0, natFlows: ds ? ds.natFlows : 0, W: S.W, H: S.H, DPR: S.DPR, view: { ...S.view }, fitScale: S.fitScale };
  }, frames, start, end);
}

async function memory(pg, cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(200);
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const page = await pg.evaluate(() => {
    const cvs = [...document.querySelectorAll("canvas")].map((c) => ({ id: c.id, w: c.width, h: c.height, bytes: c.width * c.height * 4 }));
    const deck = window.__deck;
    const pre = deck ? JSON.parse(JSON.stringify(deck.metrics)) : null;
    let post = null;
    if (deck && window.__M.deck) {
      // one pick allocates deck's picking framebuffer (the audit's M4 rule: measure post-pick)
      window.__M.deck.pickRect({ x: 640, y: 400, width: 1, height: 1 });
      post = JSON.parse(JSON.stringify(deck.metrics));
    }
    return { canvases: cvs, canvasBytes: cvs.reduce((s, c) => s + c.bytes, 0), deckPre: pre, deckPost: post };
  });
  return { jsHeapUsed: m.JSHeapUsedSize, jsHeapTotal: m.JSHeapTotalSize, nodes: m.Nodes, ...page };
}

async function originSwitch(pg) {
  const out = [];
  for (const zh of ["北京", "上海", "广州"]) {
    const r = await pg.evaluate(async (zh) => {
      const tasks = [];
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(e.duration); });
      po.observe({ type: "longtask", buffered: false });
      const iv = []; let last = performance.now(); let going = true;
      const tick = (ts) => { iv.push(ts - last); last = ts; if (going) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      await new Promise((r) => requestAnimationFrame(r));
      const t0 = performance.now();
      window.__selectOrigin(zh);
      // the first frame that shows the new origin, then 2 s of frames for the stall
      await new Promise((r) => setTimeout(r, 2000));
      going = false;
      po.disconnect();
      const firstGap = iv.length ? Math.max(...iv) : 0;
      return { zh, longTaskMs: +tasks.reduce((a, b) => a + b, 0).toFixed(1), longestTaskMs: +(tasks.length ? Math.max(...tasks) : 0).toFixed(1), maxRafGapMs: +firstGap.toFixed(1), frames: iv.length, elapsed: +(performance.now() - t0).toFixed(0) };
    }, zh);
    await settle(pg);
    out.push(r);
  }
  return out;
}

async function measureLoad(dpr, thr) {
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr });
  const cdp = await pg.createCDPSession();
  if (thr > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: thr });
  if (NET) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, ...NET });
  }
  const one = async (kind) => {
    await pg.goto(`${url}/?theme=light${query}`, { waitUntil: "load" });
    await pg.waitForFunction(READY, { timeout: 90000 });
    const readyAt = await pg.evaluate(() => performance.now());
    let settledAt = null;
    const isDeck = await pg.evaluate(() => !!window.__deckStats);
    if (isDeck) {
      await pg.waitForFunction("window.__deckStats.afterRenders >= 1", { timeout: 60000 }).catch(() => {});
      settledAt = await pg.evaluate(() => performance.now());
    }
    await pg.waitForNetworkIdle({ idleTime: 1500, timeout: 60000 }).catch(() => {});
    const r = await pg.evaluate((readyAt) => {
      const nav = performance.getEntriesByType("navigation")[0];
      const paint = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, +p.startTime.toFixed(0)]));
      const res = performance.getEntriesByType("resource");
      const sum = (pred) => res.filter(pred).reduce((s, e) => s + (e.transferSize || e.encodedBodySize || 0), 0);
      const byKind = (e) => (/\.json(\.\w+)?\.br/.test(e.name) ? "pack" : /\.js$/.test(e.name) ? "js" : /fonts/.test(e.name) ? "font" : "other");
      const packs = res.filter((e) => byKind(e) === "pack").map((e) => ({ name: e.name.split("/").pop(), bytes: e.transferSize || e.encodedBodySize, end: +e.responseEnd.toFixed(0) }));
      return {
        docBytes: nav.transferSize,
        domContentLoaded: +nav.domContentLoadedEventEnd.toFixed(0),
        loadEvent: +nav.loadEventEnd.toFixed(0),
        firstPaint: paint["first-paint"] ?? null,
        firstContentfulPaint: paint["first-contentful-paint"] ?? null,
        bytesBeforeReady: nav.transferSize + sum((e) => e.responseEnd <= readyAt && byKind(e) !== "font"),
        bytesTotal: nav.transferSize + sum((e) => byKind(e) !== "font"),
        jsBytes: sum((e) => byKind(e) === "js"),
        packs,
      };
    }, readyAt);
    return { kind, mapReadyMs: +readyAt.toFixed(0), firstFrameMs: settledAt === null ? null : +settledAt.toFixed(0), ...r };
  };
  const cold = await one("cold");
  const warm = await one("warm");
  await ctx.close();
  return { dpr, throttle: thr, net: opt.net || "localhost", cold, warm };
}

try {
  for (let rep = 1; rep <= REPS; rep++) {
    for (const dpr of dprs) {
      for (const thr of throttles) {
        if (SCEN.has("load")) {
          const l = await measureLoad(dpr, thr);
          loads.push({ label: LABEL, rep, ...l });
          console.log(`[${LABEL}] rep ${rep} dpr ${dpr} x${thr} load: cold ready ${l.cold.mapReadyMs} ms (${(l.cold.bytesBeforeReady / 1024).toFixed(0)} KB before ready, ${(l.cold.bytesTotal / 1024).toFixed(0)} KB total), warm ready ${l.warm.mapReadyMs} ms`);
        }
        const frameScen = [...SCEN].filter((s) => s !== "load" && s !== "switch");
        if (!frameScen.length && !SCEN.has("switch")) continue;
        const { ctx, pg, cdp } = await openPage(dpr, thr);
        const fitScale = fitScaleOverride ?? (await pg.evaluate(() => window.__M.S.current.fitScale));
        const views = {
          "origin-initial": null,
          "city-x10": async () => pg.evaluate((s) => window.__mapApi.panZoomTo(113.26, 23.13, s), fitScale * 10),
          "national-fit": async () => pg.evaluate(() => window.__mapApi.fitCountry()),
          "anim-peak": null,
        };
        for (const name of frameScen) {
          if (!(name in views)) continue;
          // every sweep starts from the loaded (origin-initial) camera
          await pg.evaluate(() => window.__mapApi.fitHome());
          await pg.evaluate(() => { const s = window.__M.S.current; s.initialViewApplied = false; s.interacted = false; });
          if (name !== "origin-initial" && name !== "anim-peak") await views[name]();
          else await pg.evaluate(() => window.__mapApi.fitCountry());
          if (name === "origin-initial" || name === "anim-peak") {
            // the Guangzhou opening view: the same camera the page loads with
            await pg.evaluate(() => { const s = window.__M.S.current; s.interacted = false; s.initialViewApplied = false; window.dispatchEvent(new Event("resize")); });
            await sleep(400);
          }
          await settle(pg);
          const [start, end] = NATIONAL ? [1095, 1155] : name === "anim-peak" ? [1035, 1155] : [360, 1440];
          const r = await sweep(pg, start, end, FR);
          const mem = await memory(pg, cdp);
          const row = {
            label: LABEL, rep, dpr, throttle: thr, view: name, national: NATIONAL, renderer, frames: FR, sweep: [start, end],
            W: r.W, H: r.H, DPR: r.DPR, camera: r.view, fitScale: r.fitScale, zoomRatio: +(r.view.scale / r.fitScale).toFixed(2),
            rafIntervalMs: stat(r.a.iv),
            droppedPct: +((100 * r.a.iv.filter((x) => x > 20).length) / r.a.iv.length).toFixed(1),
            drawJsMs: stat(r.a.dr),
            drawPlusRasterMs: stat(r.f.dr),
            natDots: r.natDots, natFlows: r.natFlows,
            deckMetrics: r.metrics,
            memory: mem,
          };
          rows.push(row);
          console.log(
            `[${LABEL}] rep ${rep} dpr ${dpr} x${thr} ${name.padEnd(15)} raf p50/p95/max ${row.rafIntervalMs.p50}/${row.rafIntervalMs.p95}/${row.rafIntervalMs.max}  drop ${row.droppedPct}%  js p50/p95 ${row.drawJsMs.p50}/${row.drawJsMs.p95}  draw+raster p50/p95 ${row.drawPlusRasterMs.p50}/${row.drawPlusRasterMs.p95}  heap ${(mem.jsHeapUsed / 1048576).toFixed(1)} MB` +
              (r.natDots ? ` dots ${r.natDots}` : "") + (r.natFlows ? ` flows ${r.natFlows}` : ""),
          );
        }
        if (SCEN.has("switch") && !NATIONAL) {
          await pg.evaluate(() => window.__mapApi.fitCountry());
          const sw = await originSwitch(pg);
          rows.push({ label: LABEL, rep, dpr, throttle: thr, view: "switch", renderer, switches: sw });
          console.log(`[${LABEL}] rep ${rep} dpr ${dpr} x${thr} switch: ` + sw.map((s) => `${s.zh} long ${s.longTaskMs} ms (max ${s.longestTaskMs}) rafgap ${s.maxRafGapMs}`).join(" | "));
        }
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  await close();
}

const out = {
  label: LABEL,
  base: url,
  national: NATIONAL,
  renderer,
  machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGB: +(os.totalmem() / 1073741824).toFixed(0), platform: `${os.type()} ${os.release()}`, loadavg: os.loadavg().map((x) => +x.toFixed(2)), node: process.version },
  browser: await (async () => { try { const b = await launch({}); const v = await b.version(); await b.close(); return v; } catch { return "?"; } })(),
  frames: FR, reps: REPS, dprs, throttles, startedAt: new Date(t0).toISOString(), durationS: +((Date.now() - t0) / 1000).toFixed(0),
  rows, loads,
};
if (opt.out) {
  fs.mkdirSync(opt.out.replace(/[^/]*$/, "") || ".", { recursive: true });
  fs.writeFileSync(opt.out, JSON.stringify(out, null, 1));
  console.log("wrote", opt.out);
}
