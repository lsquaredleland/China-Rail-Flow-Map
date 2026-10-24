// Usage: node scripts/strip_throats.mjs <v1 in (with throats)> <v1 out>
// Removes the O1 station throats from a combined v1 atlas file
// (china-flow-atlas-data.json): drops `throats`, drops throat entries from
// every dep_secs / arr_secs row and maps chord-leg and stop positions from
// whole-path to flow-section positions. The result is what the pre-O1 atlas
// writes for the same run, so main's atlaspack can pack it into a fmt 5 pack
// to compare against with check_pack_roundtrip.mjs.
import fs from "node:fs";

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) throw new Error("usage: strip_throats.mjs <v1 in> <v1 out>");
const v1 = JSON.parse(fs.readFileSync(inPath, "utf8"));
if (!Array.isArray(v1.throats)) throw new Error("input has no throats");
const strip = (path, nSec) => {
  const secs = [];
  const flowAt = [0]; // flowAt[q] = flow sections among path[0..q]
  for (const v of path) {
    if ((v < 0 ? ~v : v) < nSec) secs.push(v);
    flowAt.push(secs.length);
  }
  return { secs, flowAt };
};
for (const o of v1.origins) {
  for (const [secsKey, legsKey, stopsKey, nSec] of [
    ["dep_secs", "dep_chord_legs", "dep_stop_pos", v1.sections.length],
    ["arr_secs", "arr_chord_legs", null, v1.in_sections.length],
  ]) {
    o[secsKey] = o[secsKey].map((path, r) => {
      const { secs, flowAt } = strip(path, nSec);
      o[legsKey][r] = o[legsKey][r].map((l) => [l[0], flowAt[l[1]], flowAt[l[2]]]);
      if (stopsKey) o[stopsKey][r] = o[stopsKey][r].map((p) => flowAt[p]);
      return secs;
    });
  }
}
delete v1.throats;
delete v1.stats.throats;
fs.writeFileSync(outPath, JSON.stringify(v1));
console.log(`stripped throats: ${inPath} -> ${outPath}`);
