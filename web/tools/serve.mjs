// Static server for dist/ that mimics the Vercel headers in vercel.json:
//   assets/*.json.br   immutable cache, Content-Encoding: br, application/json
//   index.html         Cache-Control: public, max-age=0, must-revalidate
//   every file         ETag (If-None-Match -> 304); .js/.html/.css/.svg are
//                      brotli-compressed on the fly when accepted, as the host does
// usage: node tools/serve.mjs [--dir dist] [--port 8766] [--404 <path-substring>[,...]]
//   --404 answers 404 for any request path containing one of the substrings
//   (e.g. --404 atlas-v2-shared to check the stale-asset reload).
// Also importable (`serve(dir, port)`): the drivers use it when given a
// directory instead of a URL. Dev/test tooling only; never imported by src/.
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

/* Brotli bytes per file path, keyed on the file's ETag. */
const brCache = new Map();

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".json": "application/json",
};

export function serve(dir, port, { quiet = true, notFound = [] } = {}) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = path.join(root, p);
    // --404: simulate a deploy that removed a file (stale-asset / stale-chunk check).
    if (notFound.some((n) => p.includes(n))) {
      if (!quiet) console.log(req.method, p, "404 (forced)");
      res.writeHead(404);
      return res.end();
    }
    if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    const h = {};
    if (/^\/assets\/.*\.json\.br$/.test(p)) {
      h["Cache-Control"] = "public, max-age=31536000, immutable";
      h["Content-Encoding"] = "br";
      h["Content-Type"] = "application/json";
    } else {
      h["Content-Type"] = TYPES[path.extname(f)] || "application/octet-stream";
      if (p === "/index.html") h["Cache-Control"] = "public, max-age=0, must-revalidate";
      else if (p.startsWith("/assets/")) h["Cache-Control"] = "public, max-age=31536000, immutable";
    }
    let b = fs.readFileSync(f);
    // Like the host: a validator on every file (a warm reload of index.html is a 304, not a
    // re-download), and text assets (the inlined entry, the lazy deck chunks, CSS, SVG) go out
    // brotli-compressed when the browser accepts it. Compressed once per file and cached.
    const etag = `"${crypto.createHash("sha1").update(b).digest("hex").slice(0, 16)}"`;
    if (req.headers["if-none-match"] === etag) {
      if (!quiet) console.log(req.method, p, "304");
      res.writeHead(304, { ETag: etag, "Cache-Control": h["Cache-Control"] || "public, max-age=0, must-revalidate" });
      return res.end();
    }
    h.ETag = etag;
    if (!h["Content-Encoding"] && /\.(js|html|css|svg)$/.test(f) && /\bbr\b/.test(req.headers["accept-encoding"] || "")) {
      let c = brCache.get(f);
      if (!c || c.etag !== etag) brCache.set(f, (c = { etag, bytes: zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }) }));
      b = c.bytes;
      h["Content-Encoding"] = "br";
      h.Vary = "Accept-Encoding";
    }
    h["Content-Length"] = b.length;
    if (!quiet) console.log(req.method, p, h["Content-Encoding"] || "-", b.length);
    res.writeHead(200, h);
    res.end(b);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const port = +opt("--port", 8766);
  await serve(opt("--dir", "dist"), port, { quiet: false, notFound: opt("--404", "").split(",").filter(Boolean) });
  console.log(`serving ${opt("--dir", "dist")} on http://127.0.0.1:${port}`);
}
