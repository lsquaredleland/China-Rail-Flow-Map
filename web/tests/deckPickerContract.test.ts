// dropDepthPickBuffer (deck/DeckHost.ts) relies on two private details of deck's DeckPicker. This
// reads the installed source so a @deck.gl/core bump that changes them fails `bun test` instead of
// silently bringing back the unused rgba32float pickZ framebuffer (42 MB at DPR 2, 95 MB at DPR 3).
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

function pickerSource(): string {
  const pkg = createRequire(import.meta.url).resolve("@deck.gl/core/package.json");
  return fs.readFileSync(path.join(path.dirname(pkg), "dist/lib/deck-picker.js"), "utf8");
}

/* The method definition, and the depth-framebuffer branch inside the body that follows it. */
function pickerHooksPresent(src: string): { resizeBuffer: boolean; depthBranch: boolean } {
  const m = /^\s*_resizeBuffer\s*\(/m.exec(src);
  const body = m ? src.slice(m.index, m.index + 3000) : "";
  return {
    resizeBuffer: !!m,
    depthBranch: /if\s*\(\s*this\.device\.isTextureFormatRenderable\(\s*['"]rgba32float['"]\s*\)\s*\)/.test(body),
  };
}

describe("deck picker contract", () => {
  test("installed deck-picker.js still has _resizeBuffer and the rgba32float depth branch", () => {
    expect(pickerHooksPresent(pickerSource())).toEqual({ resizeBuffer: true, depthBranch: true });
  });

  test("the matcher fails when either detail is renamed or removed", () => {
    const src = pickerSource();
    expect(pickerHooksPresent(src.replace("_resizeBuffer(canvasContext = ", "_resizeBuf(canvasContext = ")).resizeBuffer).toBe(false);
    expect(pickerHooksPresent(src.replace("isTextureFormatRenderable('rgba32float')", "isTextureFormatRenderable('rgba16float')")).depthBranch).toBe(false);
  });
});
