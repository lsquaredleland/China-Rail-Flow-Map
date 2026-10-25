// Pixel diff of two screenshot directories (matching file names).
//
// usage: node tools/shots/cmp.mjs <dirA> <dirB> [--max PCT] [--tolerance D] [--pixelmatch] [--diff DIR]
//   --max PCT        exit 1 if any image differs in more than PCT % of its
//                    pixels (alias --threshold; default 0: any differing pixel fails)
//   --tolerance D    a pixel counts as differing when any channel differs by
//                    more than D (0-255, default 0)
//   --pixelmatch     count with pixelmatch (threshold 0.1, anti-aliased pixels
//                    excluded: includeAA false), the G1 rule of the deck.gl
//                    migration (C20); --tolerance is ignored. The --diff mask is
//                    pixelmatch's own (red = differing, yellow = AA, ignored).
//   --diff DIR       also write <name>.diff.png (differing pixels in red)
// Prints per image: differing pixels (count and %), max and mean channel
// delta. A missing or differently sized image counts as a failure.
// No dependencies: a minimal PNG codec on node:zlib (8-bit RGB/RGBA,
// non-interlaced, which is what Chrome writes).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parseArgs } from "../common.mjs";

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function decodePng(buf) {
  let off = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9];
      if (data[8] !== 8 || data[12] !== 0 || (ct !== 2 && ct !== 6)) throw new Error("unsupported PNG (need 8-bit RGB/RGBA, non-interlaced)");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 4, 255);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = cur[x * bpp]; px[o + 1] = cur[x * bpp + 1]; px[o + 2] = cur[x * bpp + 2];
      if (bpp === 4) px[o + 3] = cur[x * bpp + 3];
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, px };
}

function encodePng(w, h, px) {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, "ascii"); data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Same result shape as diffImages, counted by pixelmatch (threshold 0.1, includeAA false). */
function pmDiff(pixelmatch, A, B) {
  const n = A.w * A.h, mask = Buffer.alloc(n * 4);
  const differing = pixelmatch(A.px, B.px, mask, A.w, A.h, { threshold: 0.1, includeAA: false });
  let max = 0, sum = 0;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { const d = Math.abs(A.px[i * 4 + c] - B.px[i * 4 + c]); sum += d; if (d > max) max = d; }
  return { differing, max, mean: sum / (n * 3), n, mask };
}

export function diffImages(A, B, tol = 0) {
  const n = A.w * A.h;
  let differing = 0, max = 0, sum = 0;
  const mask = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(A.px[o + c] - B.px[o + c]));
    for (let c = 0; c < 3; c++) sum += Math.abs(A.px[o + c] - B.px[o + c]);
    if (d > max) max = d;
    if (d > tol) { differing++; mask[o] = 255; mask[o + 3] = 255; }
    else { const g = (A.px[o] + A.px[o + 1] + A.px[o + 2]) / 3 | 0; mask[o] = mask[o + 1] = mask[o + 2] = 200 + (g >> 2); mask[o + 3] = 255; }
  }
  return { differing, max, mean: sum / (n * 3), n, mask };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { pos, opt } = parseArgs(process.argv.slice(2), ["threshold", "max", "tolerance", "diff"]);
  const pm = opt.pixelmatch ? (await import("pixelmatch")).default : null;
  if (pos.length < 2) { console.error("usage: cmp.mjs <dirA> <dirB> [--max PCT] [--tolerance D] [--pixelmatch] [--diff DIR]"); process.exit(2); }
  const [da, db] = pos, thr = +(opt.max ?? opt.threshold ?? 0), tol = +(opt.tolerance ?? 0);
  if (opt.diff) fs.mkdirSync(opt.diff, { recursive: true });
  const list = (d) => new Set(fs.readdirSync(d).filter((f) => f.endsWith(".png") && !f.endsWith(".diff.png")));
  const A = list(da), B = list(db);
  let fail = 0;
  console.log("image".padEnd(34), "differing px".padStart(13), "%".padStart(8), "max".padStart(5), "mean".padStart(8));
  for (const f of [...new Set([...A, ...B])].sort()) {
    if (!A.has(f) || !B.has(f)) { console.log(f.padEnd(34), "MISSING in", A.has(f) ? db : da); fail++; continue; }
    const a = decodePng(fs.readFileSync(path.join(da, f))), b = decodePng(fs.readFileSync(path.join(db, f)));
    if (a.w !== b.w || a.h !== b.h) { console.log(f.padEnd(34), `SIZE ${a.w}x${a.h} vs ${b.w}x${b.h}`); fail++; continue; }
    const r = pm ? pmDiff(pm, a, b) : diffImages(a, b, tol), pct = (100 * r.differing) / r.n;
    const bad = pct > thr;
    if (bad) fail++;
    console.log(f.padEnd(34), String(r.differing).padStart(13), pct.toFixed(4).padStart(8), String(r.max).padStart(5), r.mean.toFixed(4).padStart(8), bad ? " FAIL" : "");
    if (opt.diff && r.differing) fs.writeFileSync(path.join(opt.diff, f.replace(/\.png$/, ".diff.png")), encodePng(a.w, a.h, r.mask));
  }
  console.log(fail ? `${fail} image(s) over threshold ${thr}%` : `all within threshold ${thr}%`);
  process.exit(fail ? 1 : 0);
}
