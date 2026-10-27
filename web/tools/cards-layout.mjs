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
// Map-bottom controls: legend, 24h expand pill and scale bar never intersect,
// open or collapsed, origin and national.
const hit2 = (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
for (const [w, h] of [[390, 844], [390, 664], [360, 740], [1280, 800]]) {
  for (const national of [false, true]) {
    for (const open of [true, false]) {
      const pg = await browser.newPage();
      await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await pg.goto(`${url}/?theme=light`, { waitUntil: "networkidle0" });
      await pg.waitForFunction("window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading", { timeout: 60000 });
      if (national) {
        await pg.evaluate(() => { const b = document.getElementById("tglNational"); if (b) b.click(); });
        await sleep(2500);
      }
      await sleep(1500);
      const collapsed = await pg.evaluate(() => document.getElementById("legendBody")?.classList.contains("collapsed"));
      if (w < 641 && collapsed === open) await click(pg, "#legendToggle");
      await sleep(500);
      const b = await pg.evaluate(() => {
        const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return b.width && b.height ? { x: b.x, y: b.y, r: b.right, b: b.bottom } : null; };
        return { legend: r("#legend"), pill: r(".tl-expand-wrap"), scale: r("#scalebar"), map: r("#mapwrap") };
      });
      const tag = `${w}x${h} ${national ? "national" : "origin"} legend-${open ? "open" : "closed"}`;
      if (!b.pill) fails.push(`${tag}: expand pill missing`);
      const parts = [["legend", b.legend], ["pill", b.pill], ["scale", b.scale]].filter(([, v]) => v);
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) if (hit2(parts[i][1], parts[j][1])) fails.push(`${tag}: ${parts[i][0]} overlaps ${parts[j][0]}`);
        const v = parts[i][1];
        if (b.map && (v.x < b.map.x || v.r > b.map.r || v.y < b.map.y || v.b > b.map.b)) fails.push(`${tag}: ${parts[i][0]} leaves the map`);
      }
      console.log(`${tag}: ${parts.map(([n]) => n).join(", ")} checked`);
      await pg.close();
    }
  }
}
// Open 24h bar on phones (one compact row): the collapse button is fully on
// screen, nothing overflows, and the tick labels and status badges are gone.
for (const [w, h] of [[390, 844], [360, 740], [470, 844]]) {
  for (const national of [false, true]) {
    const pg = await browser.newPage();
    await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await pg.goto(`${url}/?theme=light`, { waitUntil: "networkidle0" });
    await pg.waitForFunction("window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading", { timeout: 60000 });
    if (national) {
      await pg.evaluate(() => { const b = document.getElementById("tglNational"); if (b) b.click(); });
      await sleep(2500);
    }
    await click(pg, 'button[title^="Expand 24h"]');
    await sleep(1000);
    const t = await pg.evaluate(() => {
      const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, b: b.bottom }; };
      const c = document.querySelector('button[title="Collapse animation bar"]');
      const dock = document.querySelector(".timeline-bar-dock");
      return {
        collapse: c ? r(c) : null,
        ticks: [...document.querySelectorAll(".tb-tick-item")].map((e) => ({ t: e.textContent, ...r(e) })),
        badges: [...document.querySelectorAll(".tb-badge, .tb-zone-label")].filter((e) => e.getBoundingClientRect().width > 0).length,
        scrollW: dock ? dock.scrollWidth : 0,
        clientW: dock ? dock.clientWidth : 0,
      };
    });
    const tag = `${w}x${h} ${national ? "national" : "origin"} timeline-open`;
    if (!t.collapse) fails.push(`${tag}: collapse button missing`);
    else if (t.collapse.x < 0 || t.collapse.r > w || t.collapse.y < 0) fails.push(`${tag}: collapse button off screen`);
    if (t.badges) fails.push(`${tag}: ${t.badges} status badge/zone labels still visible`);
    if (t.scrollW > t.clientW) fails.push(`${tag}: bar overflows (${t.scrollW} > ${t.clientW})`);
    if (t.ticks.some((k) => k.r > k.x)) fails.push(`${tag}: tick labels still shown on the phone bar`);
    for (let i = 0; i < t.ticks.length; i++) {
      if (t.ticks[i].x < 0 || t.ticks[i].r > w) fails.push(`${tag}: tick "${t.ticks[i].t}" off screen`);
      for (let j = i + 1; j < t.ticks.length; j++) if (hit2(t.ticks[i], t.ticks[j])) fails.push(`${tag}: ticks "${t.ticks[i].t}" and "${t.ticks[j].t}" overlap`);
    }
    console.log(`${tag}: collapse + ${t.ticks.length} ticks checked`);
    await pg.close();
  }
}
await browser.close();
await close();
if (fails.length) { console.log(fails.join("\n")); process.exit(1); }
console.log("CARDS LAYOUT OK");
