// Origin-view frame-time driver: plays the origin animation on 广州 and
// sweeps animTime 360 -> 1440 over 300 frames (3.6 min per frame). Harness,
// flags and the SwiftShader check: see lib.mjs.
// usage: node tools/perf/origin.mjs [base] [--frames 300] [--dpr 1,2]
//          [--throttle 1] [--headed] [--out f.json]
import { runPerf } from "./lib.mjs";
await runPerf({
  argv: process.argv.slice(2),
  defaults: { start: 360, end: 1440, frames: 300 },
  origin: "广州",
  views: { "origin-initial": null, "origin-close-up": "home", "national-fit": "fit" },
});
