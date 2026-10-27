// Summarises compare.mjs result files into Markdown tables (median of the
// reps, with the min–max spread), as used in docs/history/AUDIT_PRE_MAIN.md §4.
// usage: node tools/perf/summarize.mjs <dir with *.json from compare.mjs>
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] || "docs/perf";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const runs = files.map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const span = (a, d = 1) => (a.length > 1 ? ` (${Math.min(...a).toFixed(d)}–${Math.max(...a).toFixed(d)})` : "");
const cell = (a, d = 1) => (a.length ? med(a).toFixed(d) + span(a, d) : "–");
const mb = (b) => (b / 1048576).toFixed(1);
const kb = (b) => (b / 1024).toFixed(0);
const uniq = (a) => [...new Set(a)];

/* The 2026-10-26 campaign files were written by a compare.mjs whose camera field was also
   called `view` and overwrote the scenario name; the name is recovered from the zoom ratio
   (national fit = 1, city-x10 = 10) and the sweep (anim-peak starts at 1035). */
const viewName = (x) => {
  if (typeof x.view === "string") return x.view;
  const z = x.zoomRatio ?? (x.view && x.fitScale ? x.view.scale / x.fitScale : NaN);
  if (z >= 8) return "city-x10";
  if (Math.abs(z - 1) < 0.05) return "national-fit";
  return x.sweep && x.sweep[0] === 1035 ? "anim-peak" : "origin-initial";
};
const frameRows = runs.flatMap((r) =>
  (r.rows || []).filter((x) => x.view !== "switch").map((x) => ({ ...x, view: viewName(x), mode: r.national || "origin", file: r.file })),
);
const switchRows = runs.flatMap((r) => (r.rows || []).filter((x) => x.view === "switch").map((x) => ({ ...x, file: r.file })));
const loadRows = runs.flatMap((r) => (r.loads || []).map((x) => ({ ...x, label: r.label, file: r.file })));

const out = [];
const H = (s) => out.push("", s, "");
const table = (head, rows) => {
  out.push("| " + head.join(" | ") + " |");
  out.push("|" + head.map((_, i) => (i === 0 ? "---" : "---:")).join("|") + "|");
  for (const r of rows) out.push("| " + r.join(" | ") + " |");
};

/* ---- frame times, origin view, canvas vs deck ---- */
const origin = frameRows.filter((x) => x.mode === "origin");
if (origin.length) {
  H("### Frame times, origin view (median of reps; min–max in brackets; ms)");
  const labels = uniq(origin.map((x) => x.label));
  const rows = [];
  for (const view of uniq(origin.map((x) => x.view)))
    for (const dpr of uniq(origin.map((x) => x.dpr)).sort())
      for (const thr of uniq(origin.map((x) => x.throttle)).sort()) {
        for (const label of labels) {
          const g = origin.filter((x) => x.view === view && x.dpr === dpr && x.throttle === thr && x.label === label);
          if (!g.length) continue;
          rows.push([
            `${view} · DPR ${dpr} · ${thr}×`, label, String(g.length),
            cell(g.map((x) => x.rafIntervalMs.p95)), cell(g.map((x) => x.rafIntervalMs.max)), cell(g.map((x) => x.droppedPct)),
            cell(g.map((x) => x.drawJsMs.p50)), cell(g.map((x) => x.drawJsMs.p95)),
            cell(g.map((x) => x.drawPlusRasterMs.p50)), cell(g.map((x) => x.drawPlusRasterMs.p95)),
          ]);
        }
      }
  table(["scenario", "renderer", "reps", "rAF p95", "rAF max", "dropped %", "JS draw p50", "JS draw p95", "draw+raster p50", "draw+raster p95"], rows);
}

/* ---- memory ---- */
if (frameRows.length) {
  H("### Memory after the sweeps (median of reps)");
  const rows = [];
  for (const mode of uniq(frameRows.map((x) => x.mode)))
    for (const label of uniq(frameRows.map((x) => x.label)))
      for (const dpr of uniq(frameRows.map((x) => x.dpr)).sort()) {
        const g = frameRows.filter((x) => x.mode === mode && x.label === label && x.dpr === dpr && x.throttle === 1 && x.memory);
        if (!g.length) continue;
        const heap = g.map((x) => x.memory.jsHeapUsed);
        const cv = g.map((x) => x.memory.canvasBytes);
        const pre = g.map((x) => x.memory.deckPre?.gpuMemory).filter((v) => v != null);
        const post = g.map((x) => x.memory.deckPost?.gpuMemory).filter((v) => v != null);
        const buf = g.map((x) => x.memory.deckPost?.bufferMemory).filter((v) => v != null);
        rows.push([
          `${mode} · ${label} · DPR ${dpr}`, String(g.length), `${mb(med(heap))} (${mb(Math.min(...heap))}–${mb(Math.max(...heap))})`,
          mb(med(cv)) + ` (${uniq(g.map((x) => x.memory.canvases.length)).join("/")} canvases)`,
          pre.length ? mb(med(pre)) : "n/a", post.length ? mb(med(post)) : "n/a", buf.length ? mb(med(buf)) : "n/a",
        ]);
      }
  table(["mode · renderer · DPR", "reps", "JS heap used, MB", "DOM canvas backing stores, MB", "deck gpuMemory pre-pick, MB", "post-pick, MB", "of which buffers, MB"], rows);
}

/* ---- origin switch ---- */
if (switchRows.length) {
  H("### Origin switch (广州→北京→上海→广州; long tasks in the 2 s after `__selectOrigin`; median over cities × reps; ms)");
  const rows = [];
  for (const dpr of uniq(switchRows.map((x) => x.dpr)).sort())
    for (const thr of uniq(switchRows.map((x) => x.throttle)).sort())
      for (const label of uniq(switchRows.map((x) => x.label))) {
        const g = switchRows.filter((x) => x.dpr === dpr && x.throttle === thr && x.label === label).flatMap((x) => x.switches);
        if (!g.length) continue;
        rows.push([`DPR ${dpr} · ${thr}×`, label, String(g.length), cell(g.map((x) => x.longTaskMs), 0), cell(g.map((x) => x.longestTaskMs), 0), cell(g.map((x) => x.maxRafGapMs), 0)]);
      }
  table(["scenario", "renderer", "switches", "long-task total", "longest task", "longest rAF gap"], rows);
}

/* ---- national ---- */
const nat = frameRows.filter((x) => x.mode !== "origin");
if (nat.length) {
  H("### National mode (deck only; 18:15 sweep 1095→1155, 300 frames; median of reps; ms)");
  const rows = [];
  for (const mode of uniq(nat.map((x) => x.mode)))
    for (const view of uniq(nat.map((x) => x.view)))
      for (const dpr of uniq(nat.map((x) => x.dpr)).sort())
        for (const thr of uniq(nat.map((x) => x.throttle)).sort()) {
          const g = nat.filter((x) => x.mode === mode && x.view === view && x.dpr === dpr && x.throttle === thr);
          if (!g.length) continue;
          rows.push([
            `${mode === "both" ? "A+B" : "A"} · ${view} · DPR ${dpr} · ${thr}×`, String(g.length),
            cell(g.map((x) => x.rafIntervalMs.p95)), cell(g.map((x) => x.droppedPct)), cell(g.map((x) => x.drawJsMs.p95)), cell(g.map((x) => x.drawPlusRasterMs.p95)),
            cell(g.map((x) => x.deckMetrics?.cpuTimePerFrame ?? NaN).filter((v) => !isNaN(v)), 2),
            uniq(g.map((x) => x.natDots)).join("/"), uniq(g.map((x) => x.natFlows)).join("/"),
            `${mb(med(g.map((x) => x.memory.jsHeapUsed)))}`,
            g[0].memory.deckPost ? mb(med(g.map((x) => x.memory.deckPost.gpuMemory))) : "–",
          ]);
        }
  table(["scenario", "reps", "rAF p95", "dropped %", "JS draw p95", "draw+raster p95", "deck cpuTimePerFrame", "dots", "sections", "JS heap MB", "gpuMemory post-pick MB"], rows);
}

/* ---- loads ---- */
if (loadRows.length) {
  H("### Load: first paint and map ready (median of reps; ms, KB transferred as the Resource Timing API reports it)");
  const rows = [];
  for (const net of uniq(loadRows.map((x) => x.net)))
    for (const dpr of uniq(loadRows.map((x) => x.dpr)).sort())
      for (const thr of uniq(loadRows.map((x) => x.throttle)).sort())
        for (const label of uniq(loadRows.map((x) => x.label))) {
          const g = loadRows.filter((x) => x.net === net && x.dpr === dpr && x.throttle === thr && x.label === label);
          if (!g.length) continue;
          const c = g.map((x) => x.cold), w = g.map((x) => x.warm);
          rows.push([
            `${net} · DPR ${dpr} · ${thr}×`, label, String(g.length),
            cell(c.map((x) => x.firstContentfulPaint ?? x.firstPaint ?? NaN).filter((v) => !isNaN(v)), 0),
            cell(c.map((x) => x.mapReadyMs), 0), c[0].firstFrameMs != null ? cell(c.map((x) => x.firstFrameMs), 0) : "–",
            kb(med(c.map((x) => x.bytesBeforeReady))), kb(med(c.map((x) => x.bytesTotal))),
            cell(w.map((x) => x.mapReadyMs), 0),
          ]);
        }
  table(["scenario", "build", "reps", "cold FCP", "cold map ready", "cold first deck frame", "KB before ready", "KB total", "warm map ready"], rows);
}

/* ---- run metadata ---- */
H("### Runs");
table(["file", "label", "mode", "renderer", "reps", "frames", "duration s", "load avg at end", "started"],
  runs.map((r) => [r.file, r.label, r.national || "origin", r.renderer, String(r.reps), String(r.frames), String(r.durationS), (r.machine?.loadavg || []).join(" / "), r.startedAt]));
const m = runs[0]?.machine;
if (m) out.push("", `Machine: ${m.cpu} (${m.cores} cores, ${m.memGB} GB), ${m.platform}; ${runs[0].browser}; node ${m.node}.`);
console.log(out.join("\n"));
