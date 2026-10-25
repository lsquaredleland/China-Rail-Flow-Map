// Deterministic screenshot driver: 14 named scenarios x DPR 1 and 2 = 28 PNGs.
//
// usage: node tools/shots/shots.mjs [base] [outdir] [--dpr 1,2] [--only a,b]
//   base    http(s) URL of a running build, or a directory (default "dist")
//           that is served with the Vercel headers on a free port
//   outdir  default "shots-out"; files are <scenario>@<dpr>x.png
//   env CHROME_PATH overrides the Chrome binary
//   env SHOTS_QUERY appends to the page URL, e.g. '&renderer=canvas' (deck is the default since
//       P1c.1) or '&layers=backdrop'. On the deck renderer each shot waits for window.__deckStats.settled
//       (two identical frames, no pipeline compile pending) before and after the scenario.
//
// Determinism: every scenario runs in a fresh browser context (empty
// storage), fixed 1280x800 viewport, light colour scheme, ?theme=light,
// mouse parked off the map, and the 24h animation is paused at an exact
// minute (set through the map API) for the anim-* scenarios. Local macOS GPU
// only: SwiftShader anti-aliasing differs, so do not compare across machines.
import fs from "node:fs";
import path from "node:path";
import { launch, parseArgs, resolveBase, sleep } from "../common.mjs";

const { pos, opt } = parseArgs(process.argv.slice(2), ["dpr", "only"]);
const outDir = path.resolve(pos[1] || "shots-out");
const dprs = (opt.dpr || "1,2").split(",").map(Number);
const only = opt.only ? new Set(opt.only.split(",")) : null;
fs.mkdirSync(outDir, { recursive: true });

const W = 1280, H = 800;

/* In-page helpers, serialised into each evaluate. */
const clickBtn = (pg, startsWith) =>
  pg.evaluate((l) => {
    const el = [...document.querySelectorAll("button")].find((e) =>
      (e.getAttribute("aria-label") || e.title || e.textContent).trim().startsWith(l));
    if (el) el.click();
    return !!el;
  }, startsWith);
const click = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); return !!e; }, sel);
const expandAnim = async (pg) => {
  await click(pg, 'button[title^="Expand 24h"]');
  await sleep(600);
  await pg.evaluate(() => window.__mapApi.setPlaying(false));
};
const setMinute = async (pg, m) => {
  await pg.evaluate((m) => { window.__mapApi.setTime(m); }, m);
  await sleep(500);
};

/* Deck renderer (the default; SHOTS_QUERY '&renderer=canvas' for Canvas): wait until __deckStats.settled. */
const deckWanted = !/renderer=canvas/.test(process.env.SHOTS_QUERY || ""); // deck is the default (P1c.1)
const settled = async (pg) => {
  if (!deckWanted) return;
  await pg.waitForFunction("window.__deckStats && window.__deckStats.settled", { timeout: 20000 });
};

/* The 14 scenarios, in plan order. Each runs on a freshly loaded page. */
const SCENARIOS = {
  "national-fit": async (pg) => { await clickBtn(pg, "National view"); await sleep(800); },
  "guangzhou-initial": async () => {},
  "city-zoom-x10": async (pg) => {
    await pg.evaluate(() => {
      const M = window.__M;
      window.__mapApi.panZoomTo(113.26, 23.13, M.S.current.fitScale * 10);
    });
    await sleep(600);
  },
  "selected-city": async (pg) => { await pg.evaluate(() => window.__mapApi.selectDestByZh("深圳")); await sleep(1500); },
  "selected-city-minimized": async (pg) => {
    await pg.evaluate(() => window.__mapApi.selectDestByZh("深圳"));
    await sleep(1500);
    await click(pg, "#destMin");
    await sleep(800);
  },
  "isolated-train-mid": async (pg) => {
    await pg.evaluate(() => window.__mapApi.selectDestByZh("深圳"));
    await sleep(1500);
    await click(pg, 'button[title^="View full schedule"]');
    await sleep(1200);
    await click(pg, ".tsm-iso-btn");
    await sleep(800);
    await pg.keyboard.press("Escape");
    await sleep(800);
    await expandAnim(pg);
    // Midpoint of the isolated train's journey, from the timeline model.
    await pg.evaluate(() => {
      const M = window.__M;
      const code = M.P.current.isolatedTrainCode;
      const pt = code && M.activeTimeline().getPrepTrain(code);
      window.__mapApi.setTime(pt ? Math.round((pt.depMins + pt.arrMins) / 2) : 600);
    });
    await sleep(600);
  },
  "class-filter-G": async (pg) => {
    await pg.evaluate(() => {
      const el = [...document.querySelectorAll(".cls-filter .cls-btn")].find((e) => e.textContent.trim() === "G");
      el && el.click();
    });
    await sleep(1200);
  },
  inbound: async (pg) => { await clickBtn(pg, "Inbound"); await sleep(7000); },
  "infra-on": async (pg) => { await click(pg, "#tglInfra"); await sleep(1000); },
  night: async (pg) => { await clickBtn(pg, "Night mode"); await sleep(1200); },
  "anim-0600": async (pg) => { await expandAnim(pg); await setMinute(pg, 360); },
  "anim-1815": async (pg) => { await expandAnim(pg); await setMinute(pg, 1095); },
  "anim-2350": async (pg) => { await expandAnim(pg); await setMinute(pg, 1430); },
  "labels-on": async (pg) => { await click(pg, "#tglLabels"); await sleep(1000); },
};

/* Extended origin-view coverage, opt-in with --extended (not in the 28):
   inbound with a city selected, class filter with a city selected, the
   schedule modal, a minimized panel with the timeline, night + animation. */
const selectSZ = async (pg) => { await pg.evaluate(() => window.__mapApi.selectDestByZh("深圳")); await sleep(1500); };
const filterG = (pg) => pg.evaluate(() => {
  const el = [...document.querySelectorAll(".cls-filter .cls-btn")].find((e) => e.textContent.trim() === "G");
  el && el.click();
});
const EXTENDED = {
  "inbound-selected-city": async (pg) => { await clickBtn(pg, "Inbound"); await sleep(7000); await selectSZ(pg); },
  "class-filter-G-selected": async (pg) => { await selectSZ(pg); await filterG(pg); await sleep(1200); },
  "schedule-modal": async (pg) => { await selectSZ(pg); await click(pg, 'button[title^="View full schedule"]'); await sleep(1500); },
  "anim-1815-night": async (pg) => { await clickBtn(pg, "Night mode"); await sleep(800); await expandAnim(pg); await setMinute(pg, 1095); },
  "anim-1815-selected": async (pg) => { await selectSZ(pg); await expandAnim(pg); await setMinute(pg, 1095); },
  "inbound-anim-1815": async (pg) => { await clickBtn(pg, "Inbound"); await sleep(7000); await expandAnim(pg); await setMinute(pg, 1095); },
};
if (opt.extended) Object.assign(SCENARIOS, EXTENDED);

const { url, close } = await resolveBase(pos[0] || "dist");
const browser = await launch();
let errors = 0, written = 0;
for (const dpr of dprs) {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (only && !only.has(name)) continue;
    const ctx = await browser.createBrowserContext();
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => { errors++; console.log(`  pageerror [${name}]`, e.message); });
    await pg.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "no-preference" }]);
    await pg.setViewport({ width: W, height: H, deviceScaleFactor: dpr });
    await pg.goto(`${url}/?theme=light${process.env.SHOTS_QUERY || ""}`, { waitUntil: "networkidle0" });
    await pg.waitForFunction("window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading", { timeout: 60000 });
    await sleep(3000); // origin fade-in + staged pack loading settle
    await settled(pg);
    await run(pg);
    await pg.mouse.move(2, 2);
    await sleep(400);
    await settled(pg);
    const file = path.join(outDir, `${name}@${dpr}x.png`);
    await pg.screenshot({ path: file });
    written++;
    console.log("wrote", file);
    await ctx.close();
  }
}
await browser.close();
await close();
console.log(`${written} PNGs in ${outDir}${errors ? `, ${errors} pageerror(s)` : ""}`);
process.exit(errors ? 1 : 0);
