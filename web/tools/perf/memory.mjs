// Memory driver: peak and settled heap per scenario, sampled through CDP
// Runtime.getHeapUsage every ~20 ms (usedSize = JS heap, backingStorageSize =
// ArrayBuffer stores, which usedJSHeapSize leaves out). "settled" is after a
// forced GC. Each scenario runs in its own browser context.
//   out       ?city=北京, outbound, until the departures table has rows
//   in        the same, inbound
//   flip      out, then the inbound toggle (both directions held)
//   hop       out, then --hop N more origins via window.__selectOrigin
//   national  ?national=1, 24h expanded, until dots and the national table
// usage: node tools/perf/memory.mjs [base=dist] [--scenarios out,in,flip,hop,national]
//          [--hop 20] [--runs 1] [--out f.json] [--headed]
//          [--browser-url http://127.0.0.1:9222]   attach to a running Chrome instead,
//            e.g. Android: `adb forward tcp:9222 localabstract:chrome_devtools_remote`;
//            base must then be a URL the phone can reach (http://<lan-ip>:<port>).
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { launch, parseArgs, resolveBase, sleep } from "../common.mjs";

const HOP = ["上海", "广州", "深圳", "成都", "重庆", "武汉", "西安", "杭州", "南京", "郑州",
  "长沙", "天津", "济南", "合肥", "福州", "南昌", "昆明", "贵阳", "南宁", "沈阳",
  "哈尔滨", "长春", "石家庄", "太原", "兰州", "乌鲁木齐", "厦门", "青岛", "大连", "苏州"];

const { pos, opt } = parseArgs(process.argv.slice(2), ["scenarios", "hop", "runs", "out", "browser-url"]);
const scenarios = (opt.scenarios || "out,in,flip,hop,national").split(",");
const nHop = +(opt.hop || 20);
const runs = +(opt.runs || 1);
const { url, close } = await resolveBase(pos[0] || "dist");
const browser = opt["browser-url"]
  ? await puppeteer.connect({ browserURL: opt["browser-url"] })
  : await launch({ headed: !!opt.headed });

const READY = "window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading";
const tableRows = (sel) => `document.querySelectorAll(${JSON.stringify(sel)}).length > 0`;

async function run(name) {
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("pageerror", (e) => errs.push(e.message));
  await pg.setViewport({ width: 1280, height: 800 });
  const dir = name === "in" ? "in" : "out";
  await pg.evaluateOnNewDocument((d) => {
    try { localStorage.setItem("crfa-direction", d); } catch {}
  }, dir);
  const cdp = await pg.createCDPSession();
  await cdp.send("Runtime.enable");
  let peakJs = 0, peakAll = 0, sampling = true;
  const sample = async () => {
    while (sampling) {
      try {
        const h = await cdp.send("Runtime.getHeapUsage");
        peakJs = Math.max(peakJs, h.usedSize);
        peakAll = Math.max(peakAll, h.usedSize + (h.backingStorageSize || 0));
      } catch { /* navigation in progress */ }
      await sleep(20);
    }
  };
  const sampler = sample();
  const t0 = Date.now();
  const q = name === "national" ? "?national=1" : "?city=北京";
  await pg.goto(`${url}/${q}&theme=light`, { waitUntil: "networkidle0" });
  await pg.waitForFunction(READY, { timeout: 120000 });
  if (name === "national") {
    await pg.evaluate(() => document.querySelector('button[title^="Expand 24h"]')?.click());
    await pg.waitForFunction("window.__deckStats && window.__deckStats.natDots > 0", { timeout: 120000 });
  } else {
    await pg.waitForFunction(tableRows("#depTable tbody tr"), { timeout: 120000 });
  }
  if (name === "flip") {
    await pg.click("#dirIn");
    await pg.waitForFunction(READY, { timeout: 120000 });
    await sleep(1500);
    await pg.waitForFunction(tableRows("#depTable tbody tr"), { timeout: 120000 });
  }
  let hopped = 0;
  if (name === "hop") {
    for (const zh of HOP.slice(0, nHop)) {
      const ok = await pg.evaluate((z) => {
        const before = window.__M.P.current.cur;
        window.__selectOrigin(z);
        return before !== undefined;
      }, zh);
      if (!ok) continue;
      await sleep(400);
      await pg.waitForFunction(READY, { timeout: 120000 });
      hopped++;
    }
  }
  await sleep(1500);
  sampling = false;
  await sampler;
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(300);
  await cdp.send("HeapProfiler.collectGarbage");
  const h = await cdp.send("Runtime.getHeapUsage");
  const res = {
    scenario: name, hopped, ms: Date.now() - t0, errors: errs,
    peakJsMB: peakJs / 1e6, peakAllMB: peakAll / 1e6,
    settledJsMB: h.usedSize / 1e6, settledAllMB: (h.usedSize + (h.backingStorageSize || 0)) / 1e6,
    backingStorage: h.backingStorageSize !== undefined,
  };
  await ctx.close();
  return res;
}

const rows = [];
try {
  for (const s of scenarios) for (let r = 0; r < runs; r++) rows.push(await run(s));
} finally {
  if (opt["browser-url"]) await browser.disconnect(); else await browser.close();
  await close();
}
const f = (x) => x.toFixed(1).padStart(7);
console.log(`\n${url}\nscenario   peak JS  peak JS+AB  settled JS  settled JS+AB  (MB)`);
for (const r of rows) {
  console.log(r.scenario.padEnd(9), f(r.peakJsMB), f(r.peakAllMB).padStart(11), f(r.settledJsMB).padStart(11),
    f(r.settledAllMB).padStart(14), r.hopped ? ` hops ${r.hopped}` : "", r.errors.length ? ` ERR ${r.errors[0]}` : "");
}
if (!rows.every((r) => r.backingStorage)) console.log("note: this Chrome has no backingStorageSize; JS+AB = JS");
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(rows, null, 1));
