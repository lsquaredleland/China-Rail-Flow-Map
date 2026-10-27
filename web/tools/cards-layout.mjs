// Layout check for the collapsed map cards: with the city card and the
// train card both open, no card's bounding box may intersect the legend,
// scale bar, 24h expand button, timeline, toolbar, header or another card.
// usage: node tools/cards-layout.mjs [base=dist]   (env CHROME_PATH)
import { launch, resolveBase, parseArgs, sleep } from "./common.mjs";

const { pos } = parseArgs(process.argv.slice(2));
const { url, close } = await resolveBase(pos[0] || "dist");
// A fresh browser per case: pages after the first in one software-GL browser
// load 5x slower. rAF is throttled to 4 fps (layout only; the DOM is what is
// measured), and every wait is on a concrete condition, not a fixed sleep.
const newBrowser = () => launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const until = (pg, fn, timeout = 30000) => pg.waitForFunction(fn, { timeout, polling: 100 });
const fails = [];
const click = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); return !!e; }, sel);
// sequential: parallel cases (2 or 5 at once) starve each other and were slower on CI
const cases = [
  [1280, 800, false],
  [390, 844, false],
  [390, 664, false],
  [1280, 800, true],
  [390, 844, true],
];
const runCase = async ([w, h, expanded]) => {
  const T0 = Date.now(), lg = (m) => console.log(`  ${w}x${h}${expanded ? "e" : ""} ${m} ${Date.now() - T0}ms`);
  const browser = await newBrowser();
  const pg = await browser.newPage();
  await pg.evaluateOnNewDocument(() => { window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 250); });
  await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await pg.goto(`${url}/?theme=light`, { waitUntil: "networkidle0" });
  await pg.waitForFunction("window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading", { timeout: 60000 });
  lg("loaded");
  await until(pg, "window.__deckStats && window.__deckStats.settled", 60000);
  lg("settled");
  await pg.evaluate(() => window.__mapApi.selectDestByZh("深圳"));
  await until(pg, "document.querySelector('#destPanel')");
  lg("dest");
  // a class filter, so the active-filter bar is in the stack too
  await pg.evaluate(() => {
    const g = [...document.querySelectorAll(".cls-filter .cls-btn")].find((e) => e.textContent.trim() === "G");
    if (g) g.click();
  });
  await until(pg, "document.querySelector('.active-filter-bar')", 5000).catch(() => {});
  if (!expanded) await click(pg, "#destMin");
  await sleep(300);
  lg("filter");
  await click(pg, 'button[title^="View full schedule"]');
  await until(pg, "document.querySelector('button[aria-label=\"Minimize timetable\"]')", 10000).catch(() => {});
  await pg.evaluate(() => { const b = document.querySelector('button[aria-label="Minimize timetable"]'); b && b.click(); });
  await until(pg, "!document.querySelector('button[aria-label=\"Minimize timetable\"]')", 10000).catch(() => {});
  lg("schedule");
  await sleep(400); // CSS transitions
  const boxes = await pg.evaluate(() => {
    const r = (e) => { const b = e.getBoundingClientRect(); return b.width && b.height ? { x: b.x, y: b.y, r: b.right, b: b.bottom } : null; };
    const one = (sel) => [...document.querySelectorAll(sel)].map(r).filter(Boolean).map((b, i) => ({ sel: `${sel}#${i}`, ...b }));
    return {
      cards: [...one(".map-card"), ...one("#destPanel")],
      others: [
        "#legend", "#scalebar", ".tl-expand-btn", ".timeline-bar-dock", ".timeline-collapsed-bar",
        ".toolbar", "header", ".active-filter-bar",
      ].flatMap(one),
    };
  });
  if (boxes.cards.length < 2) fails.push(`${w}x${h}: expected 2 cards, found ${boxes.cards.length}`);
  const hit = (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
  for (const c of boxes.cards) {
    if (c.x < 0 || c.r > w) fails.push(`${w}x${h}: card ${c.sel} leaves the viewport`);
    for (const o of boxes.others) if (hit(c, o)) fails.push(`${w}x${h}: ${c.sel} overlaps ${o.sel}`);
  }
  for (let i = 0; i < boxes.cards.length; i++)
    for (let j = i + 1; j < boxes.cards.length; j++)
      if (hit(boxes.cards[i], boxes.cards[j])) fails.push(`${w}x${h}: cards ${i} and ${j} overlap`);
  console.log(`${w}x${h}${expanded ? " expanded-panel" : ""}: ${boxes.cards.length} cards, ${boxes.others.length} other boxes checked`);
  await browser.close();
};
const queue = [...cases];
await Promise.all([0].map(async () => { for (let c; (c = queue.shift()); ) await runCase(c); }));
// One page per phone size keeps this fast: origin and national are checked on
// the same page (the mode switch is a click), legend open and closed by toggling.
const wait = (pg, fn, label, t = 60000) => until(pg, fn, t).catch(() => { fails.push(`timed out waiting for ${label}`); });
const hit2 = (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
const box = (e) => { const b = e.getBoundingClientRect(); return b.width && b.height ? { x: b.x, y: b.y, r: b.right, b: b.bottom } : null; };
const measure = (pg) => pg.evaluate((src) => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return b.width && b.height ? { x: b.x, y: b.y, r: b.right, b: b.bottom } : null; };
  const dock = document.querySelector(".timeline-bar-dock");
  const c = document.querySelector('button[title="Collapse animation bar"]');
  return {
    legend: r("#legend"), pill: r(".tl-expand-wrap"), scale: r("#scalebar"), map: r("#mapwrap"),
    collapse: c ? (() => { const b = c.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, b: b.bottom }; })() : null,
    ticks: [...document.querySelectorAll(".tb-tick-item")].filter((e) => e.getBoundingClientRect().width > 0).length,
    badges: [...document.querySelectorAll(".tb-badge, .tb-zone-label")].filter((e) => e.getBoundingClientRect().width > 0).length,
    scrollW: dock ? dock.scrollWidth : 0, clientW: dock ? dock.clientWidth : 0,
  };
});
for (const [w, h] of [[390, 844], [390, 664], [360, 740]]) {
  const browser = await newBrowser();
  const pg = await browser.newPage();
  await pg.evaluateOnNewDocument(() => { window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 250); });
  await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await pg.goto(`${url}/?theme=light`, { waitUntil: "networkidle0" });
  await pg.waitForFunction("window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading", { timeout: 60000 });
  await wait(pg, "document.querySelector('.tl-expand-wrap')", "expand pill on load");
  for (const national of [false, true]) {
    if (national) {
      await click(pg, "#tglNational");
      await wait(pg, "document.querySelector('.tl-expand-wrap') && !document.querySelector('#dirOut')", "national mode");
    }
    for (const open of [true, false]) {
      const collapsed = await pg.evaluate(() => document.getElementById("legendBody")?.classList.contains("collapsed"));
      if (collapsed === open) await click(pg, "#legendToggle");
      await sleep(300);
      const b = await measure(pg);
      const tag = `${w}x${h} ${national ? "national" : "origin"} legend-${open ? "open" : "closed"}`;
      if (!b.pill) fails.push(`${tag}: expand pill missing`);
      const parts = [["legend", b.legend], ["pill", b.pill], ["scale", b.scale]].filter(([, v]) => v);
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) if (hit2(parts[i][1], parts[j][1])) fails.push(`${tag}: ${parts[i][0]} overlaps ${parts[j][0]}`);
        const v = parts[i][1];
        if (b.map && (v.x < b.map.x || v.r > b.map.r || v.y < b.map.y || v.b > b.map.b)) fails.push(`${tag}: ${parts[i][0]} leaves the map`);
      }
      console.log(`${tag}: ${parts.map(([n]) => n).join(", ")} checked`);
    }
    // the 24h bar open: one compact row, the collapse button fully on screen
    await click(pg, 'button[title^="Expand 24h"]');
    await wait(pg, "document.querySelector('.timeline-bar-dock')", "timeline bar");
    {
      const t = await measure(pg);
      const tag = `${w}x${h} ${national ? "national" : "origin"} timeline-open`;
      if (!t.collapse) fails.push(`${tag}: collapse button missing`);
      else if (t.collapse.x < 0 || t.collapse.r > w || t.collapse.y < 0) fails.push(`${tag}: collapse button off screen`);
      if (t.scrollW > t.clientW) fails.push(`${tag}: bar overflows (${t.scrollW} > ${t.clientW})`);
      if (t.ticks) fails.push(`${tag}: tick labels still shown on the phone bar`);
      if (t.badges) fails.push(`${tag}: ${t.badges} status badge/zone labels still visible`);
      console.log(`${tag}: collapse, overflow, labels checked`);
    }
    if (!national) {
      await click(pg, 'button[title="Collapse animation bar"]');
      await wait(pg, "document.querySelector('.tl-expand-wrap')", "expand pill after collapse");
    }
  }
  await browser.close();
}
await close();
if (fails.length) { console.log(fails.join("\n")); process.exit(1); }
console.log("CARDS LAYOUT OK");
