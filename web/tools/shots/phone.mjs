// Phone-width screenshots (390x844, DPR 2): the layout checks the 1280x800
// shots.mjs set does not cover. Not a pixel gate: a few named views to look at.
//
// usage: node tools/shots/phone.mjs [base] [outdir] [--only a,b] [--size 390x844]
//   base    URL or directory (default "dist"), as for shots.mjs
//   env SHOTS_THEME "light" (default) or "dark"; SHOTS_QUERY appends to the
//       URL, e.g. '&skin=terminal'
import fs from "node:fs";
import path from "node:path";
import { launch, parseArgs, resolveBase, sleep } from "../common.mjs";

const { pos, opt } = parseArgs(process.argv.slice(2), ["only", "size"]);
const [VW, VH] = (opt.size || "390x844").split("x").map(Number);
const THEME = process.env.SHOTS_THEME || "light";
const outDir = path.resolve(pos[1] || "shots-phone");
const only = opt.only ? new Set(opt.only.split(",")) : null;
fs.mkdirSync(outDir, { recursive: true });

const click = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); return !!e; }, sel);
const settled = (pg) => pg.waitForFunction("window.__deckStats && window.__deckStats.settled", { timeout: 20000 });
const selectSZ = async (pg) => { await pg.evaluate(() => window.__mapApi.selectDestByZh("深圳")); await sleep(1500); };

const SCENARIOS = {
  initial: async () => {},
  "selected-city": selectSZ,
  "timeline-expanded": async (pg) => {
    await click(pg, 'button[title^="Expand 24h"]');
    await sleep(600);
    await pg.evaluate(() => { window.__mapApi.setPlaying(false); window.__mapApi.setTime(522); });
    await sleep(500);
  },
  "filters-open": async (pg) => { await click(pg, "#filtersBtn"); await sleep(400); },
  "options-open": async (pg) => { await click(pg, "#moreBtn"); await sleep(400); },
  departures: async (pg) => {
    await selectSZ(pg);
    await pg.evaluate(() => document.getElementById("departures")?.scrollIntoView());
    await sleep(800);
  },
  histograms: async (pg) => {
    await pg.evaluate(() => document.querySelector(".hist-strip")?.scrollIntoView());
    await sleep(800);
  },
  "schedule-modal": async (pg) => {
    await selectSZ(pg);
    await click(pg, 'button[title^="View full schedule"]');
    await sleep(1500);
  },
};

const { url, close } = await resolveBase(pos[0] || "dist");
const browser = await launch();
let errors = 0;
for (const [name, run] of Object.entries(SCENARIOS)) {
  if (only && !only.has(name)) continue;
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => { errors++; console.log(`  pageerror [${name}]`, e.message); });
  await pg.emulateMediaFeatures([{ name: "prefers-color-scheme", value: THEME }]);
  await pg.setViewport({ width: VW, height: VH, deviceScaleFactor: 2, isMobile: VW <= 640, hasTouch: VW <= 640 });
  await pg.goto(`${url}/?theme=${THEME}${process.env.SHOTS_QUERY || ""}`, { waitUntil: "networkidle0" });
  await pg.waitForFunction("window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading", { timeout: 60000 });
  await sleep(3000);
  await pg.evaluate(() => document.fonts.ready);
  await settled(pg);
  await run(pg);
  await sleep(400);
  await settled(pg);
  const file = path.join(outDir, `${name}.png`);
  await pg.screenshot({ path: file });
  console.log("wrote", file);
  await ctx.close();
}
await browser.close();
await close();
process.exit(errors ? 1 : 0);
