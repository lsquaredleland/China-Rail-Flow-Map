import { launch, resolveBase, sleep } from "../common.mjs";
const { url, close } = await resolveBase("dist");
const browser = await launch({});
const pg = await browser.newPage();
await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
await pg.goto(`${url}/?theme=light&renderer=deck`, { waitUntil: "networkidle0" });
await pg.waitForFunction("window.__M && window.__M.P.current.cur", { timeout: 60000 });
await sleep(3000);
console.log(await pg.evaluate(() => {
  const a = window.__tailProbe();
  const h = window.__deckHost, gl = h.deck.device.handle;
  const w = gl.drawingBufferWidth, hh = gl.drawingBufferHeight, buf = new Uint8Array(w * hh * 4);
  gl.readPixels(0, 0, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (buf[(y * w + x) * 4 + 3] > 0) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
  return JSON.stringify({ a, w, hh, cw: h.canvas.width, ch: h.canvas.height, minx, maxx, miny, maxy });
}));
await browser.close();
await close();
