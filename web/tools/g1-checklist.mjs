// G1 interaction checklist (C20): drives the interaction steps on the deck renderer,
// records per step the camera / selection / scale-bar state, pageerrors and a screenshot
// (checklist.json in --out). With --against DIR (the --out of an earlier run on another
// build, written by THIS version of the script: png paths are stored relative to --out) it also compares every step's state and the pixelmatch % of its screenshot.
//   pan, wheel, pinch (touch), fit + zoom buttons, URL camera restore, scale bar km/mi,
//   selection, isolation, class filter, histogram filter, inbound, play / seek, night,
//   DPR 1/2/3, backdrop toggles (showNetwork, showOutline), live window resize (centre kept).
// usage: node tools/g1-checklist.mjs [base=dist] [--out DIR] [--against DIR]   (local macOS GPU only)
import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { launch, parseArgs, resolveBase, sleep } from "./common.mjs";
import { decodePng } from "./shots/cmp.mjs";

const { pos, opt } = parseArgs(process.argv.slice(2), ["out", "against"]);
const outDir = path.resolve(opt.out || "g1-out");
fs.mkdirSync(outDir, { recursive: true });
const { url, close } = await resolveBase(pos[0] || "dist");
const browser = await launch();

const click = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); return !!e; }, sel);
const clickBtn = (pg, startsWith) =>
  pg.evaluate((l) => {
    const el = [...document.querySelectorAll("button")].find((e) => (e.getAttribute("aria-label") || e.title || e.textContent).trim().startsWith(l));
    if (el) el.click();
    return !!el;
  }, startsWith);

/** One steps-array per group: [{name, state, png}]. */
async function open(dpr, search = "", hasTouch = false) {
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("pageerror", (e) => errs.push(e.message));
  await pg.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "no-preference" }]);
  await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr, hasTouch });
  const q = `?theme=light${search}`;
  await pg.goto(`${url}/${q}`, { waitUntil: "networkidle0" });
  await pg.waitForFunction("window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading", { timeout: 60000 });
  await sleep(3000);
  return { pg, ctx, errs };
}
const settle = async (h) => {
  await sleep(700);
  await h.pg.waitForFunction("window.__deckStats && window.__deckStats.settled", { timeout: 20000 });
  await h.pg.mouse.move(2, 2);
  await sleep(300);
};
async function snap(h, steps, name) {
  await h.pg.evaluate(() => window.scrollTo(0, 0));
  await settle(h);
  const state = await h.pg.evaluate(() => {
    const M = window.__M, v = M.S.current.view, P = M.P.current;
    return {
      scale: +v.scale.toFixed(6), tx: +v.tx.toFixed(3), ty: +v.ty.toFixed(3),
      dest: P.panelDest ? P.panelDest.zh : null, iso: P.isolatedTrainCode || null, dark: P.dark, dir: P.direction,
      net: P.showNetwork, infra: P.showInfra, outline: P.showOutline, dist: P.distUnit,
      cenLon: +M.toLon(M.S.current.W / 2).toFixed(6), cenLat: +M.toLat(M.S.current.H / 2).toFixed(6),
      scaleLabel: (document.querySelector(".sb-label") || {}).textContent || "",
      url: location.search, dpr: M.S.current.DPR,
      anim: window.__mapApi.getAnimState ? Math.round(window.__mapApi.getAnimState().time ?? -1) : -1,
      cls: [...document.querySelectorAll(".cls-filter .cls-btn")].filter((e) => e.getAttribute("aria-pressed") === "true" || /active|\bon\b|selected/.test(e.className)).map((e) => e.textContent.trim()).join(""),
      histSel: document.querySelectorAll(".hist-col.is-selected").length,
    };
  });
  const png = `${steps.tag}-${steps.list.length}-${name}.png`;
  await h.pg.screenshot({ path: path.join(outDir, png) });
  steps.list.push({ name, state, png });
}

async function run(tag, dpr, fn, search = "", hasTouch = false) {
  const steps = { tag, list: [] };
  const h = await open(dpr, search, hasTouch);
  try { await fn(h, (n) => snap(h, steps, n)); } finally { steps.errs = h.errs.slice(); await h.ctx.close(); }
  return steps;
}

const mapCentre = (pg) => pg.evaluate(() => { const r = document.getElementById("map").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; });

const GROUPS = {
  camera: async (h, S) => {
    const { pg } = h;
    await S("initial");
    const c = await mapCentre(pg);
    await pg.mouse.move(c.x, c.y); await pg.mouse.down();
    await pg.mouse.move(c.x - 160, c.y + 60, { steps: 8 }); await pg.mouse.move(c.x - 220, c.y + 90, { steps: 4 }); await pg.mouse.up();
    await S("pan");
    await pg.mouse.move(c.x + 100, c.y - 40); await pg.mouse.wheel({ deltaY: -400 }); await sleep(200); await pg.mouse.wheel({ deltaY: -300 });
    await S("wheel-in");
    await pg.mouse.wheel({ deltaY: 500 });
    await S("wheel-out");
    await click(pg, "#btnCountry"); await sleep(400);
    await S("fit-country");
    await click(pg, "#btnHome"); await sleep(400);
    await S("fit-home");
    await click(pg, "#btnIn"); await sleep(400); await click(pg, "#btnIn"); await sleep(400);
    await S("zoom-in-btn");
    await click(pg, "#btnOut"); await sleep(400);
    await S("zoom-out-btn");
  },
  pinch: async (h, S) => {
    const { pg } = h;
    const c = await mapCentre(pg);
    await S("initial");
    const pinch = async (d0, d1) => {
      const a = await pg.touchscreen.touchStart(c.x - d0, c.y), b = await pg.touchscreen.touchStart(c.x + d0, c.y);
      for (let i = 1; i <= 10; i++) { const d = d0 + ((d1 - d0) * i) / 10; await a.move(c.x - d, c.y); await b.move(c.x + d, c.y); }
      await a.end(); await b.end();
    };
    await pinch(60, 200);
    await S("pinch-out");
    await pinch(200, 80);
    await S("pinch-in");
  },
  /* Live window resize (P1c.1): with the camera taken, the geographic centre must survive a
     shrink and a grow, and no pageerror may appear. */
  resize: async (h, S) => {
    const { pg } = h;
    await click(pg, "#btnIn"); await sleep(400);
    await S("before");
    await pg.setViewport({ width: 1000, height: 700, deviceScaleFactor: 2 }); await sleep(600);
    await S("shrunk");
    await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 }); await sleep(600);
    await S("restored");
  },
  scalebar: async (h, S) => {
    await S("km");
    await click(h.pg, "#unitMi"); await sleep(300);
    await S("mi");
    await click(h.pg, "#btnIn"); await sleep(400);
    await S("mi-zoomed");
    await click(h.pg, "#unitKm"); await sleep(300);
    await S("km-zoomed");
  },
  selection: async (h, S) => {
    const { pg } = h;
    await pg.evaluate(() => window.__mapApi.selectDestByZh("深圳")); await sleep(1500);
    await S("select-city");
    await click(pg, 'button[title^="View full schedule"]'); await sleep(1200);
    await click(pg, ".tsm-iso-btn"); await sleep(800);
    await pg.keyboard.press("Escape"); await sleep(800);
    await S("isolate-train");
    await click(pg, 'button[title^="Exit single train isolation"]'); await sleep(600);
    await S("exit-isolation");
    await pg.evaluate(() => { const el = [...document.querySelectorAll(".cls-filter .cls-btn")].find((e) => e.textContent.trim() === "G"); el && el.click(); }); await sleep(1200);
    await S("class-filter-G");
    const clicked = await pg.evaluate(() => { const e = document.querySelector(".hist-col.clickable"); if (!e) return false; e.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; });
    await sleep(900);
    await S(clicked ? "histogram-bin" : "histogram-bin(no bar)");
    await clickBtn(pg, "Inbound"); await sleep(7000);
    await S("inbound");
  },
  anim: async (h, S) => {
    const { pg } = h;
    await click(pg, 'button[title^="Expand 24h"]'); await sleep(600);
    await pg.evaluate(() => { window.__mapApi.setTime(1095); window.__mapApi.setPlaying(false); }); await sleep(600);
    await S("seek-1815");
    await pg.evaluate(() => window.__mapApi.setPlaying(true)); await sleep(2500);
    await pg.evaluate(() => { window.__mapApi.setPlaying(false); window.__mapApi.setTime(360); }); await sleep(600);
    await S("seek-0600-after-play");
    await clickBtn(pg, "Night mode"); await sleep(1000);
    await S("night");
  },
  backdrop: async (h, S) => {
    const { pg } = h;
    await S("backdrop-default");
    await click(pg, "#tglNetwork"); await sleep(500);
    await S("network-off");
    await pg.evaluate(() => window.__setShowOutline(false)); await sleep(500);
    await S("network-off-outline-off");
    await click(pg, "#tglNetwork"); await sleep(500);
    await S("outline-off-network-on");
    await pg.evaluate(() => window.__setShowOutline(true)); await sleep(500);
    await S("outline-on");
  },
};

const results = [];
for (const [g, fn] of Object.entries(GROUPS)) results.push(await run(g, 2, fn, "", g === "pinch"));
for (const dpr of [1, 2, 3]) {
  results.push(await run(`dpr${dpr}`, dpr, async (h, S) => {
    await S("initial");
    await h.pg.evaluate(() => window.__mapApi.selectDestByZh("深圳")); await sleep(1500);
    await S("selected");
  }));
}
// URL camera restore: panned + zoomed URL of the camera group, reopened.
const cam = results[0].list.find((s) => s.name === "wheel-out");
const search = cam.state.url.replace(/&?theme=light/, "").replace(/^\?/, "&");
results.push(await run("url", 2, async (h, S) => { await S("restored"); }, search));

// Resize group: the centre must be kept across the shrink and the grow.
const rg = results.find((x) => x.tag === "resize").list;
const centreKept = rg.every((s) => Math.abs(s.state.cenLon - rg[0].state.cenLon) < 1e-4 && Math.abs(s.state.cenLat - rg[0].state.cenLat) < 1e-4);
console.log(`resize centre kept: ${centreKept}  (${rg.map((s) => `${s.name} ${s.state.cenLon},${s.state.cenLat}`).join(" | ")})`);
const near = (a, b, t) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= t : a === b);
const prev = opt.against ? JSON.parse(fs.readFileSync(path.join(path.resolve(opt.against), "checklist.json"), "utf8")) : null;
const rows = [];
let bad = 0;
for (const g of results) {
  for (const d of g.list) {
    const row = { group: g.tag, step: d.name, state: d.state, png: d.png };
    let cmp = "";
    if (prev) {
      const c = prev.find((r) => r.group === g.tag && r.step === d.name);
      if (!c) { bad++; cmp = "  NOT IN --against"; }
      else {
        const keys = Object.keys(c.state).filter((k) => !["url", "anim"].includes(k));
        const diff = keys.filter((k) => !near(c.state[k], d.state[k], k === "scale" ? 1e-6 * c.state.scale : k === "tx" || k === "ty" ? 0.01 : 0));
        const A = decodePng(fs.readFileSync(path.join(path.resolve(opt.against), c.png))), B = decodePng(fs.readFileSync(path.join(outDir, d.png)));
        const pm = (100 * pixelmatch(A.px, B.px, null, A.w, A.h, { threshold: 0.1, includeAA: false })) / (A.w * A.h);
        row.stateEqual = diff.length === 0;
        row.pmPct = +pm.toFixed(3);
        if (diff.length || pm > 0.1) bad++;
        cmp = `  vs earlier: state ${diff.length ? "DIFF " + diff.join(",") : "equal"}  pixelmatch ${row.pmPct}%`;
      }
    }
    rows.push(row);
    console.log(`${g.tag.padEnd(10)} ${d.name.padEnd(24)} scale-bar "${d.state.scaleLabel}"  [scale ${d.state.scale} dest ${d.state.dest} iso ${d.state.iso} cls "${d.state.cls}" hist ${d.state.histSel} dir ${d.state.dir} dark ${d.state.dark} net ${d.state.net} outline ${d.state.outline} dpr ${d.state.dpr}]${cmp}`);
  }
  if (g.errs.length) bad++;
  console.log(`  pageerrors ${g.errs.length}`, g.errs.join(" | "));
}
// URL restore: restored camera vs the camera that produced the URL.
const u = results.find((g) => g.tag === "url").list[0].state;
console.log(`url restore: scale ${cam.state.scale} -> ${u.scale}, tx ${cam.state.tx} -> ${u.tx}, ty ${cam.state.ty} -> ${u.ty}`);
fs.writeFileSync(path.join(outDir, "checklist.json"), JSON.stringify(rows, null, 1));
await browser.close();
await close();
process.exit(bad || !centreKept ? 1 : 0);
