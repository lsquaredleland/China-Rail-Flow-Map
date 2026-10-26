// National-mode frame-time driver (M1n / M2n): ?national=1, presses the 24h
// expand button (since PR #80 national mode opens with the flows alone; the
// dots exist only while the animation bar is open), waits for the first
// national frame with dots, then sweeps animTime through the 18:15 peak on
// the initial view, the national fit and a 10x city zoom. Harness, flags and
// the SwiftShader check: see lib.mjs. The national trains, flows and entries
// files must be served with the build (dist/assets/atlas-v2-national-*.json.br).
// Default = Trains + flows (A+B, the Flows toggle is on by default);
// --query '&natLayer=trains' draws the trains alone (A).
// --query '&natSynth=12000' repeats the trains up to ~12,000 (perf load only).
// usage: node tools/perf/national.mjs [base] [--frames 300] [--dpr 1,2]
//          [--throttle 1] [--start 1095] [--end 1155] [--headed] [--out f.json]
import { runPerf } from "./lib.mjs";
await runPerf({
  argv: process.argv.slice(2),
  defaults: { start: 1095, end: 1155, frames: 300 }, // 0.2 min per frame
  query: "&national=1",
  prepare: () => document.querySelector('button[title^="Expand 24h"]')?.click(),
  ready: "window.__deckStats && window.__deckStats.natDots > 0",
  views: { "origin-initial": null, "national-fit": "fit", "city-x10": "city" },
});
