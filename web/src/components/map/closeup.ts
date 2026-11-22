/* The origin view's city close-ups (lib/closeups) in the current frame: the
   deck host steps the split once per frame; the dots, labels and picking read
   the same progress back. */
import { CLOSEUP_Z, cityStations, retarget, scaleOfZoom, splitK } from "../../lib";
import type { CloseupStation } from "../../lib";
import type { MapCtx } from "./context";

export interface Closeup {
  /** City name (zh) → its stations, for the cities that split. */
  byCity: Map<string, CloseupStation[]>;
  /** Split progress, 0 merged .. 1 split. */
  k: number;
}

/** Moves the split to this frame and asks for the next one while it is under way. */
export function stepCloseup(M: MapCtx): void {
  const st = M.S.current;
  const now = performance.now();
  st.closeup = retarget(st.closeup, st.view.scale >= scaleOfZoom(CLOSEUP_Z) ? 1 : 0, now);
  st.closeupK = splitK(st.closeup, now);
  if (st.closeupK !== st.closeup.to && !st.closeupRaf) {
    st.closeupRaf = requestAnimationFrame(() => {
      st.closeupRaf = 0;
      M.render();
    });
  }
}

/** Only the origin city and the selected destination split; every other
    city keeps one dot and one label, so zooming into a hub shows its own
    stations, not those of every multi-station city around it. */
let splitMemo: { all: Map<string, CloseupStation[]>; a: string; b: string; out: Map<string, CloseupStation[]> } | null = null;
export function splitCities(all: Map<string, CloseupStation[]>, origin: string, dest: string): Map<string, CloseupStation[]> {
  if (splitMemo && splitMemo.all === all && splitMemo.a === origin && splitMemo.b === dest) return splitMemo.out;
  const out = new Map<string, CloseupStation[]>();
  for (const zh of [origin, dest]) {
    const l = zh ? all.get(zh) : undefined;
    if (l) out.set(zh, l);
  }
  splitMemo = { all, a: origin, b: dest, out };
  return out;
}

/** The close-ups of the last frame; null while nothing is split. */
export function closeupOf(M: MapCtx): Closeup | null {
  const P = M.P.current;
  const atlas = P.atlas;
  const k = M.S.current.closeupK;
  if (!atlas || k <= 0 || P.national) return null;
  const all = cityStations(atlas.data.station_table, atlas.data.city_table);
  return { byCity: splitCities(all, P.cur?.o.zh ?? "", P.panelDest?.zh ?? ""), k };
}
