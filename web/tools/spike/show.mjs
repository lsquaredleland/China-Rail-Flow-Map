// print perf json rows: node tools/spike/show.mjs file.json
import fs from "node:fs";
const rows = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const keys = ["fps", "cpuTimePerFrame", "gpuTimePerFrame", "gpuMemory", "bufferMemory", "framesRedrawn", "setPropsTime", "updateAttributesTime", "layersCount"];
for (const x of rows) {
  console.log(x.view, "dpr", x.dpr, "thr", x.throttle, "raf", JSON.stringify(x.rafIntervalMs), "js", JSON.stringify(x.drawJsMs), "raster", JSON.stringify(x.drawPlusRasterMs));
  if (x.metrics) console.log("  ", JSON.stringify(Object.fromEntries(keys.map((k) => [k, x.metrics[k]]))));
  if (x.nat) console.log("  nat", JSON.stringify(x.nat));
}
