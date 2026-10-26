// Two-city focus (owner): with a destination selected, other cities do not
// answer the pointer until the focus is closed.
import { describe, expect, test } from "bun:test";
import { pick } from "../src/components/map/interaction";
import { createMapCtx } from "../src/components/map/context";
import type { MapCtx, Props } from "../src/components/map/context";
import { origin, pack } from "./fixture";

const ref = <T>(v: T | null = null) => ({ current: v });

function ctx(panelDest: unknown): MapCtx {
  const P = {
    current: { atlas: pack().atlas, cur: origin("广州"), baseCur: origin("广州"), direction: "out", national: false, panelDest } as unknown as Props,
  };
  const M = createMapCtx(P, {
    wrapRef: ref(),
    canvasRef: ref(),
    tooltipRef: ref(),
    scaleWrapRef: ref(),
    scaleLabelRef: ref(),
    scaleBarRef: ref(),
    viewReportTimerRef: { current: null },
  });
  const st = M.S.current;
  st.W = 1280;
  st.H = 800;
  st.view = { scale: 30, tx: 640 - 113.3 * 30, ty: 400 + 23.1 * 30 };
  st.fitScale = 13;
  (M as { deck: unknown }).deck = { pickRect: () => [] };
  return M;
}

describe("two-city focus hover", () => {
  const cur = origin("广州");
  const dests = cur.dests;
  const sel = dests.find((d) => d.zh === "深圳")!;
  const other = dests.find((d) => d.zh === "长沙")!;
  const at = (M: MapCtx, d: { pt: [number, number] }) => pick(M, M.X(d.pt[0]), M.Y(d.pt[1]));

  test("no focus: any city is picked", () => {
    const M = ctx(null);
    const h = at(M, other);
    expect(h?.kind).toBe("station");
    expect(h && h.kind === "station" ? h.station.zh : null).toBe("长沙");
  });

  test("focus on 深圳: 长沙 is not picked, 深圳 still is", () => {
    const M = ctx(sel);
    const h = at(M, other);
    expect(h === null || h.kind !== "station").toBe(true);
    const hs = at(M, sel);
    expect(hs && hs.kind === "station" ? hs.station.zh : null).toBe("深圳");
  });
});
