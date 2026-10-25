// Driver: deck / luma device creation fails after the page's WebGL2 probe passed (P1c.2 review
// item (b), fixed in P1c.3). The probe canvas has no id and keeps its context; the deck canvas
// (#deckcv) gets none, so `onError` fires before the first `onLoad`. Expects the "map renderer
// could not be loaded" notice (MapCanvas `deckState === "error"`), not a blank map.
// usage: node tools/g1-devicefail.mjs [base=dist]   (exit 1 when the notice is missing)
import { launch, parseArgs, resolveBase, sleep } from "./common.mjs";

const { pos } = parseArgs(process.argv.slice(2));
const { url, close } = await resolveBase(pos[0] || "dist");
const browser = await launch();
const pg = await browser.newPage();
await pg.evaluateOnNewDocument(() => {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (this.id === "deckcv" && String(type).startsWith("webgl")) return null;
    return orig.call(this, type, ...rest);
  };
});
await pg.setViewport({ width: 1280, height: 800 });
await pg.goto(`${url}/?theme=light`, { waitUntil: "networkidle0" });
await sleep(4000);
const text = await pg.evaluate(() => document.getElementById("loading")?.textContent ?? null);
console.log("notice:", JSON.stringify(text));
await browser.close();
await close();
process.exit(text && text.includes("map renderer could not be loaded") ? 0 : 1);
