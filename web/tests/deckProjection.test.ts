// M8: OrthographicViewport({flipY:false}).project equals camera.ts X/Y.
import { describe, expect, test } from "bun:test";
import { OrthographicViewport } from "@deck.gl/core";
import { viewToViewState, viewStateToView } from "../src/components/map/deck/viewstate";

describe("M8 projection exactness", () => {
  test("1000 random points x 5 zooms, <= 1e-6 px", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    let worst = 0;
    for (const k of [0.55, 1, 4, 10, 60]) {
      for (let r = 0; r < 200; r++) {
        const W = 300 + rnd() * 1700, H = 300 + rnd() * 900;
        const scale = 12 * k * (0.9 + rnd() * 0.2);
        const view = { scale, tx: -rnd() * 2000, ty: rnd() * 3000 };
        const vs = viewToViewState(view, W, H);
        const vp = new OrthographicViewport({ width: W, height: H, flipY: false, target: vs.target, zoom: vs.zoom } as any);
        const back = viewStateToView(vs, W, H);
        worst = Math.max(worst, Math.abs(back.scale - scale) / scale, Math.abs(back.tx - view.tx) / 1e6, Math.abs(back.ty - view.ty) / 1e6);
        for (let i = 0; i < 5; i++) {
          const lon = 70 + rnd() * 70, lat = 15 + rnd() * 40;
          const [x, y] = vp.project([lon, lat]);
          const ex = lon * scale + view.tx, ey = -lat * scale + view.ty;
          worst = Math.max(worst, Math.abs(x - ex), Math.abs(y - ey));
        }
      }
    }
    console.log("M8 worst error (px):", worst);
    expect(worst).toBeLessThanOrEqual(1e-6);
  });
});
