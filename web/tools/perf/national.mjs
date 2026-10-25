// National-peak frame-time driver (the current origin view fitted to the
// country, plus the origin and a 10x city zoom), sweeping animTime through
// the 18:15 peak. Harness, flags and the SwiftShader check: see lib.mjs.
// usage: node tools/perf/national.mjs [base] [--frames 300] [--dpr 1,2]
//          [--throttle 1] [--start 1095] [--end 1155] [--headed] [--out f.json]
import { runPerf } from "./lib.mjs";
await runPerf({
  argv: process.argv.slice(2),
  defaults: { start: 1095, end: 1155, frames: 300 }, // 0.2 min per frame
  views: { "origin-initial": null, "national-fit": "fit", "city-x10": "city" },
});
