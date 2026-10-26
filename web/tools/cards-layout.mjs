// Layout check for the collapsed map cards: with the city card and the
// train card both open, no card's bounding box may intersect the legend,
// scale bar, 24h expand button, timeline, toolbar, header or another card.
// usage: node tools/cards-layout.mjs [base=dist]   (env CHROME_PATH)
import { launch, resolveBase, parseArgs, sleep } from "./common.mjs";

const { pos } = parseArgs(process.argv.slice(2));
const { url, close } = await resolveBase(pos[0] || "dist");
const browser = await launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const fails = [];
const click = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); return !!e; }, sel);
for (const [w, h, expanded] of [
  [1280, 800, false],
  [390, 844, false],
  [390, 664, false],
  [1280, 800, true],
  [390, 844, true],
]) {
  const pg = await browser.newPage();
  await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await pg.goto(`${url}/?theme=light`, { waitUntil: "networkidle0" });
  await pg.waitForFunction("window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading", { timeout: 60000 });
  await sleep(3000);
  await pg.evaluate(() => window.__mapApi.selectDestByZh("深圳"));
  await sleep(1500);
  // a class filter, so the active-filter bar is in the stack too
  await pg.evaluate(() => {
    const g = [...document.querySelectorAll(".cls-filter .cls-btn")].find((e) => e.textContent.trim() === "G");
    if (g) g.click();
  });
  await sleep(500);
  if (!expanded) await click(pg, "#destMin");
  await sleep(300);
  await click(pg, 'button[title^="View full schedule"]');
  await sleep(1200);
  await pg.evaluate(() => { const b = document.querySelector('button[aria-label="Minimize timetable"]'); b && b.click(); });
  await sleep(600);
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
  await pg.close();
}
await browser.close();
await close();
if (fails.length) { console.log(fails.join("\n")); process.exit(1); }
console.log("CARDS LAYOUT OK");
