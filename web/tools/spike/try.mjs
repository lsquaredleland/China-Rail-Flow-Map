// quick manual probe: node tools/spike/try.mjs <dist> "<query>" out.png [--headed]
import { launch, parseArgs, resolveBase, sleep } from "../common.mjs";
const { pos, opt } = parseArgs(process.argv.slice(2));
const { url, close } = await resolveBase(pos[0] || "dist");
const browser = await launch({ headed: !!opt.headed });
const pg = await browser.newPage();
pg.on("pageerror", (e) => console.log("PAGEERR", e.message));
pg.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE", m.type(), m.text().slice(0, 300)); });
await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
await pg.goto(`${url}/?theme=light${pos[1] || ""}`, { waitUntil: "networkidle0" });
await pg.waitForFunction("window.__M && window.__M.P.current.cur && !window.__M.P.current.inLoading", { timeout: 90000 });
await sleep(3000);
console.log(JSON.stringify(await pg.evaluate(() => window.__deckStats)));
if (pos[2]) await pg.screenshot({ path: pos[2] });
await browser.close();
await close();
