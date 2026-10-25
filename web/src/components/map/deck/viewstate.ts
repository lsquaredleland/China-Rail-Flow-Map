// SPIKE: Canvas view {scale, tx, ty} <-> OrthographicView({flipY:false}) viewState.
// px = lon*scale + tx ; py = -lat*scale + ty  (camera.ts)
export interface View {
  scale: number;
  tx: number;
  ty: number;
}

export function viewToViewState(view: View, W: number, H: number) {
  return {
    target: [(W / 2 - view.tx) / view.scale, (view.ty - H / 2) / view.scale, 0] as [number, number, number],
    zoom: Math.log2(view.scale),
  };
}

export function viewStateToView(vs: { target: number[]; zoom: number }, W: number, H: number): View {
  const scale = Math.pow(2, vs.zoom);
  return { scale, tx: W / 2 - vs.target[0] * scale, ty: H / 2 + vs.target[1] * scale };
}
