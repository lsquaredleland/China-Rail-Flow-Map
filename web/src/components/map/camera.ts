/* Camera: fit/zoom maths, the distance scale bar, canvas resize and the
   debounced view report. */
import type { MapCtx } from "./context";
import { draw } from "./render";

/* ---------- distance scale bar ----------
   The projection is equirectangular (px = lon/lat degrees x view.scale),
   so the true ground scale at the map centre follows from the centre
   latitude: one degree of longitude there spans (pi/180) * R * cos(lat)
   km on the ground. Pick the largest round distance whose on-screen
   length stays within ~60-140 px and write it straight into the DOM —
   the bar updates on every draw (pan, zoom, resize, origin switch)
   without a React re-render. */
export function updateScaleBar(M: MapCtx) {
  const { S, P, toLat, scaleWrapRef, scaleLabelRef, scaleBarRef } = M;
  const wrap = scaleWrapRef.current;
  const label = scaleLabelRef.current;
  const bar = scaleBarRef.current;
  if (!wrap || !label || !bar) return;
  const st = S.current;
  if (!P.current.cur || st.W <= 0 || st.H <= 0) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "";
  const latC = toLat(st.H / 2);
  const kmPerDegLon =
    ((Math.PI / 180) * 6371 * Math.cos((latC * Math.PI) / 180)) || 1;
  const pxPerKm = st.view.scale / kmPerDegLon;
  const unit = P.current.distUnit;
  const steps =
    unit === "km"
      ? [10, 20, 50, 100, 200, 500, 1000]
      : [10, 20, 50, 100, 200, 500];
  const toPx = (d: number) =>
    unit === "km" ? d * pxPerKm : d * 1.609344 * pxPerKm;
  let chosen = steps[0];
  for (let i = 0; i < steps.length; i++) {
    if (toPx(steps[i]) <= 140) chosen = steps[i];
    else break;
  }
  bar.style.width = Math.max(2, Math.round(toPx(chosen))) + "px";
  label.textContent = chosen.toLocaleString("en-US") + " " + unit;
}


export function fitExtent(
  M: MapCtx,
  lon0: number,
  lat0: number,
  lon1: number,
  lat1: number,
  pad: number,
) {
  const { S } = M;
  const { W, H, view } = S.current;
  const s = Math.min(W / (lon1 - lon0), H / (lat1 - lat0)) * (pad || 0.97);
  view.scale = s;
  view.tx = (W - (lon0 + lon1) * s) / 2;
  view.ty = (H + (lat0 + lat1) * s) / 2;
}

export function fitCountryCalc(M: MapCtx) {
  const { S, P } = M;
  const atlas = P.current.atlas;
  if (!atlas) return;
  const e = atlas.extent;
  fitExtent(M, e.lon0, e.lat0, e.lon1, e.lat1, 0.97);
  S.current.fitScale = S.current.view.scale;
}

export function fitGuangzhouInitialCalc(M: MapCtx) {
  fitCountryCalc(M);
  // Regional extent matching initial launch: Guangzhou near bottom,
  // Hunan/Hubei/Henan corridors extending north.
  fitExtent(M, 102.0, 20.8, 122.5, 36.8, 0.96);
}

export function fitHomeCalc(M: MapCtx) {
  const { P } = M;
  const cur = P.current.cur;
  if (!cur) return;
  const pt = cur.o.pt;
  fitExtent(M, pt[0] - 1.7, pt[1] - 1.3, pt[0] + 1.7, pt[1] + 1.3, 0.98);
}

/* Zoom progress for station sizes: 0 at the national fit, 1 at the
   maximum zoom (fitScale * 60, see zoomAt), log-spaced. Once per
   frame/pick; each dot's growth then follows its own base radius. */
export function stationT(M: MapCtx) {
  const { S } = M;
  const { view, fitScale } = S.current;
  const t = Math.log(view.scale / fitScale) / Math.log(60);
  return Math.min(1, Math.max(0, t));
}

export function zoomAt(M: MapCtx, px: number, py: number, factor: number) {
  const { S } = M;
  const st = S.current;
  const ns = Math.min(
    st.fitScale * 60,
    Math.max(st.fitScale * 0.55, st.view.scale * factor),
  );
  const k = ns / st.view.scale;
  st.view.tx = px - (px - st.view.tx) * k;
  st.view.ty = py - (py - st.view.ty) * k;
  st.view.scale = ns;
  st.interacted = true;
  draw(M);
}


export function reportViewChange(M: MapCtx) {
  const { S, P, toLon, toLat } = M;
  if (!P.current.onViewChange) return;
  const st = S.current;
  if (st.W <= 0 || st.H <= 0 || st.view.scale <= 0) return;
  const centerLon = toLon(st.W / 2);
  const centerLat = toLat(st.H / 2);
  const zoom = Math.log2((st.view.scale * 360) / 256);
  P.current.onViewChange({
    lon: centerLon,
    lat: centerLat,
    zoom,
    scale: st.view.scale,
  });
}


export function scheduleViewReport(M: MapCtx) {
  const { P, viewReportTimerRef } = M;
  if (!P.current.onViewChange) return;
  if (viewReportTimerRef.current) clearTimeout(viewReportTimerRef.current);
  viewReportTimerRef.current = window.setTimeout(() => {
    reportViewChange(M);
  }, 250);
}


export function resize(M: MapCtx) {
  const { S, P, toLon, toLat, canvasRef, wrapRef } = M;
  const wrap = wrapRef.current;
  const canvas = canvasRef.current;
  if (!wrap || !canvas) return;
  const st = S.current;
  const r = wrap.getBoundingClientRect();
  const newW = Math.max(50, r.width);
  const newH = Math.max(50, r.height);
  // When the user has taken the camera, keep the same geographic
  // centre at the same zoom across the resize (fold / unfold,
  // rotation): remember the centre in lon/lat before the size
  // changes, then re-anchor the translation on it afterwards.
  const keepCentre =
    st.interacted && st.W > 0 && st.H > 0 && P.current.cur
      ? { lon: toLon(st.W / 2), lat: toLat(st.H / 2) }
      : null;
  // Device-pixel-ratio-aware backing store, capped at 3 — foldables
  // and flagship phones run ~3x, and a 2x cap leaves strokes soft.
  st.DPR = Math.min(3, window.devicePixelRatio || 1);
  st.W = newW;
  st.H = newH;
  canvas.width = Math.round(st.W * st.DPR);
  canvas.height = Math.round(st.H * st.DPR);
  if (P.current.atlas && P.current.cur) {
    if (!st.interacted) {
      if (!st.initialViewApplied && P.current.initialCamera) {
        fitCountryCalc(M);
        const ic = P.current.initialCamera;
        const targetScale =
          ic.scale || (256 * Math.pow(2, ic.zoom || 5)) / 360;
        st.view.scale = targetScale;
        st.view.tx = st.W / 2 - ic.lon * targetScale;
        st.view.ty = st.H / 2 + ic.lat * targetScale;
        st.interacted = true;
        st.initialViewApplied = true;
      } else if (!st.initialViewApplied && P.current.cur.o.zh === "广州") {
        fitGuangzhouInitialCalc(M);
      } else {
        fitCountryCalc(M);
      }
    } else if (keepCentre) {
      st.view.tx = st.W / 2 - keepCentre.lon * st.view.scale;
      st.view.ty = st.H / 2 + keepCentre.lat * st.view.scale;
    }
  }
  draw(M);
}
