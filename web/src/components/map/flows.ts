/* Flow-model access for the pointer / pick code: the decisions live in lib/mapModel. */
import { getDestSectionCounts as modelDestSectionCounts } from "../../lib";
import type { ModelState } from "../../lib";
import type { MapCtx } from "./context";

export function modelState(M: MapCtx): ModelState {
  const { S, P } = M;
  return {
    cur: P.current.cur,
    baseCur: P.current.baseCur,
    dir: P.current.direction,
    animTime: S.current.animTime,
    animEnabled: S.current.animEnabled,
    showInfra: P.current.showInfra,
    panelDest: P.current.panelDest,
    iso: P.current.isolatedTrainCode,
    dark: P.current.dark,
  };
}

/* ---------- exact per-train section counts for a selected station ---------- */
export function getDestSectionCounts(M: MapCtx): Map<number, number> | null {
  return modelDestSectionCounts(modelState(M), M.S.current);
}
