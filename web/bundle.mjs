/* Bundle the React + TSX sources into the single classic script that
   dist/index.html carries. Run with: bun bundle.mjs
   Produces dist/index.html from index.template.html (head + CSS verbatim)
   and copies public/assets into dist/assets. */
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

let rawJs;
if (typeof Bun !== "undefined") {
  const result = await Bun.build({
    entrypoints: ["src/main.tsx"],
    minify: true,
    format: "iife",
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  rawJs = await result.outputs[0].text();
} else {
  const esbuild = await import("esbuild");
  const res = await esbuild.build({
    entryPoints: ["src/main.tsx"],
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    define: { "process.env.NODE_ENV": '"production"' },
    write: false,
  });
  rawJs = res.outputFiles[0].text;
}
// A literal "</script" inside a JS string (React DOM has one) would end
// the inline script element early; "<\/script" is the same string in JS.
const js = rawJs.replace(/<\/script/g, "<\\/script");
if (js.includes("</script")) {
  console.error("bundle still contains a </script\" sequence; refusing to inline");
  process.exit(1);
}

const tpl = readFileSync("index.template.html", "utf8");
if (!tpl.includes("/*__BUNDLE__*/")) {
  console.error("template is missing the /*__BUNDLE__*/ placeholder");
  process.exit(1);
}

mkdirSync("dist", { recursive: true });
for (const f of readdirSync("public")) {
  cpSync(`public/${f}`, `dist/${f}`, { recursive: true });
}
writeFileSync(
  "dist/index.html",
  tpl.replace("/*__BUNDLE__*/", () => js),
);
console.log("dist/index.html written, bundle bytes:", js.length);
