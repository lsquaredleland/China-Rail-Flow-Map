// placeLabels: deterministic, collision-free, origin always placed.
import { describe, expect, test } from "bun:test";
import { placeLabels } from "../src/lib";
import type { CityPointVM } from "../src/types";
import { origin } from "./fixture";

const W = 1200,
  H = 800;
const measure = (text: string) => 7 * [...text].length;

function nationalFit(pts: CityPointVM[]) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.pt[0]); x1 = Math.max(x1, p.pt[0]);
    y0 = Math.min(y0, p.pt[1]); y1 = Math.max(y1, p.pt[1]);
  }
  const scale = Math.min((W - 160) / (x1 - x0), (H - 160) / (y1 - y0));
  return {
    scale,
    tx: W / 2 - ((x0 + x1) / 2) * scale,
    ty: H / 2 + ((y0 + y1) / 2) * scale,
  };
}

describe("placeLabels", () => {
  for (const zh of ["北京", "上海", "广州"]) {
    test(`${zh}: deterministic, origin first, no overlaps`, () => {
      const cur = origin(zh);
      const view = nationalFit(cur.dests);
      const run = (showDest: boolean) =>
        placeLabels(cur.dests, view, W, H, measure, {
          origin: { zh: cur.o.zh, en: cur.en, pt: cur.o.pt },
          panelDest: null,
          showDest,
          fitScale: view.scale,
          sk: 0,
        });
      const a = run(true);
      expect(run(true)).toEqual(a);
      // The origin label is always placed, first, boxed.
      expect(a[0].text).toBe(cur.en + " · " + cur.o.zh);
      expect(a[0].style.isBoxed).toBe(true);
      // Off: only the origin.
      expect(run(false).length).toBe(1);
      // Sparse but substantial at the national view.
      expect(a.length).toBeGreaterThan(5);
      expect(a.length).toBeLessThanOrEqual(1 + 22 + cur.dests.filter((c) => c.endpoint >= 5).length);
      for (let i = 0; i < a.length; i++)
        for (let j = i + 1; j < a.length; j++) {
          const p = a[i].box, q = a[j].box;
          const overlap = p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y;
          expect(overlap).toBe(false);
        }
      for (const l of a) {
        expect(l.box.x).toBeGreaterThanOrEqual(2);
        expect(l.box.x + l.box.w).toBeLessThanOrEqual(W - 2);
      }
    });
  }

  test("a selected destination gets a boxed label right after the origin", () => {
    const cur = origin("上海");
    const view = nationalFit(cur.dests);
    const d = cur.dests.find((x) => x.zh === "杭州")!;
    const a = placeLabels(cur.dests, view, W, H, measure, {
      origin: { zh: cur.o.zh, en: cur.en, pt: cur.o.pt },
      panelDest: d,
      showDest: false,
      fitScale: view.scale,
      sk: 0,
    });
    expect(a.length).toBe(2);
    expect(a[1].text).toBe(d.en + " · " + d.zh);
    expect(a[1].style.isBoxed).toBe(true);
  });
});
