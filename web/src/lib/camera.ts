/* Pure camera maths. The projection is equirectangular:
   px = lon * scale + tx, py = -lat * scale + ty. */

export interface View {
  scale: number;
  tx: number;
  ty: number;
}

/** deck.gl OrthographicView({flipY: false}) state for the same camera. */
export interface ViewState {
  target: [number, number, number];
  zoom: number;
}

export function viewToViewState(view: View, W: number, H: number): ViewState {
  return {
    target: [(W / 2 - view.tx) / view.scale, (view.ty - H / 2) / view.scale, 0],
    zoom: Math.log2(view.scale),
  };
}

export function viewStateToView(vs: ViewState, W: number, H: number): View {
  const scale = Math.pow(2, vs.zoom);
  return {
    scale,
    tx: W / 2 - vs.target[0] * scale,
    ty: H / 2 + vs.target[1] * scale,
  };
}

/** Scale limits relative to the national fit. */
export function zoomBounds(fitScale: number) {
  const min = fitScale * 0.55;
  const max = fitScale * 60;
  return { min, max, minZoom: Math.log2(min), maxZoom: Math.log2(max) };
}

export function fitExtentView(
  W: number,
  H: number,
  lon0: number,
  lat0: number,
  lon1: number,
  lat1: number,
  pad: number,
): View {
  const s = Math.min(W / (lon1 - lon0), H / (lat1 - lat0)) * (pad || 0.97);
  return {
    scale: s,
    tx: (W - (lon0 + lon1) * s) / 2,
    ty: (H + (lat0 + lat1) * s) / 2,
  };
}

export interface Extent {
  lon0: number;
  lat0: number;
  lon1: number;
  lat1: number;
}

export function fitCountryView(W: number, H: number, e: Extent): View {
  return fitExtentView(W, H, e.lon0, e.lat0, e.lon1, e.lat1, 0.97);
}

/** Regional launch extent: Guangzhou near the bottom, the Hunan / Hubei /
    Henan corridors extending north. */
export function fitGuangzhouInitialView(W: number, H: number): View {
  return fitExtentView(W, H, 102.0, 20.8, 122.5, 36.8, 0.96);
}

export function fitHomeView(W: number, H: number, pt: [number, number]): View {
  return fitExtentView(W, H, pt[0] - 1.7, pt[1] - 1.3, pt[0] + 1.7, pt[1] + 1.3, 0.98);
}

/** Zoom progress for station sizes: 0 at the national fit, 1 at the
    maximum zoom (fitScale * 60), log-spaced. */
export function stationT(view: View, fitScale: number): number {
  const t = Math.log(view.scale / fitScale) / Math.log(60);
  return Math.min(1, Math.max(0, t));
}
