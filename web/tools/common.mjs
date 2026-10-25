// Shared by tools/shots and tools/perf: Chrome launch, optional static
// server for dist/, tiny arg parser. Dev/test tooling only.
import puppeteer from "puppeteer-core";
import { serve } from "./serve.mjs";

export const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Positionals plus --flag / --key value (keys listed in `valued`). A bare `--` is skipped. */
export function parseArgs(argv, valued = []) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      opt[k] = valued.includes(k) ? argv[++i] : true;
    } else pos.push(a);
  }
  return { pos, opt };
}

export function launch({ headed = false, args = [] } = {}) {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: !headed,
    args: ["--no-sandbox", "--hide-scrollbars", "--force-color-profile=srgb", ...args],
  });
}

/** `base` is a URL, or a directory (e.g. dist) that is served on a free port. */
export async function resolveBase(base) {
  if (/^https?:\/\//.test(base)) return { url: base.replace(/\/$/, ""), close: async () => {} };
  const server = await serve(base, 0);
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
