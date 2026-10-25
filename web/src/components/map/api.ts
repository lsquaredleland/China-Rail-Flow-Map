/* The imperative handle the toolbar / App drives through a ref. */
import type { MapApi, MapCtx } from "./context";
import { fitCountryCalc, fitHomeCalc, zoomAt } from "./camera";
import { draw } from "./render";
import { hideTooltip, showTooltip } from "./interaction";
import {
  getAnimState,
  setAnimEnabled,
  setPlaying,
  setSpeed,
  setTime,
  subscribeAnim,
  togglePlaying,
} from "./anim";

export function createMapApi(M: MapCtx): MapApi {
  const { S, P, tooltipRef, points } = M;
  return {
    fitCountry() {
      const st = S.current;
      st.interacted = false;
      st.initialViewApplied = true;
      hideTooltip(M);
      st.hover = null;
      fitCountryCalc(M);
      draw(M);
    },
    fitHome() {
      const st = S.current;
      if (!P.current.cur) return;
      st.interacted = true;
      hideTooltip(M);
      st.hover = null;
      fitHomeCalc(M);
      draw(M);
    },
    zoomCenter(factor: number) {
      zoomAt(M, S.current.W / 2, S.current.H / 2, factor);
    },
    refreshTooltip() {
      const st = S.current;
      const tooltip = tooltipRef.current;
      if (st.lastTip && tooltip && tooltip.classList.contains("show"))
        showTooltip(M, st.lastTip.hit, st.lastTip.x, st.lastTip.y);
    },
    clearStationHover() {
      const st = S.current;
      if (st.hover && st.hover.kind === "station") {
        st.hover = null;
        draw(M);
      }
    },
    selectDestByZh(zh: string) {
      const pt = points().find((p) => p.zh === zh);
      if (pt) {
        P.current.onSelectDest(pt);
        draw(M);
      }
    },
    panZoomTo(lon: number, lat: number, scale: number) {
      const st = S.current;
      st.interacted = true;
      st.view.scale = scale;
      st.view.tx = st.W / 2 - lon * scale;
      st.view.ty = st.H / 2 + lat * scale;
      draw(M);
    },
    setTime: (t) => setTime(M, t),
    setPlaying: (p) => setPlaying(M, p),
    togglePlaying: () => togglePlaying(M),
    setSpeed: (s) => setSpeed(M, s),
    setAnimEnabled: (e) => setAnimEnabled(M, e),
    getAnimState: () => getAnimState(M),
    subscribeAnim: (l) => subscribeAnim(M, l),
  };
}
