/* Square markers (skins P2, MarkerShape "box"): a ScatterplotLayer whose
   fragment shader measures the Chebyshev distance max(|x|, |y|) instead of
   length(), so the disc of radius R becomes the axis-aligned square of
   half-side R. Everything else is the ScatterplotLayer's: the same quad,
   stroke centred on R, antialiasing, picking (the same discard) and
   attributes, so dots, rings, ripples and the animation's growth carry over
   unchanged. Size it with markerRadius (a square of the circle's area).
   Used by layers/stations.ts and layers/national/cities.ts. */
import { ScatterplotLayer } from "@deck.gl/layers";
import { boxSide } from "../../../lib";
import type { MapStyle } from "../../../lib";

/** The circle distance in the ScatterplotLayer fragment shader (deck.gl 9.4),
    and its square replacement. */
export const CIRCLE_DIST = "length(unitPosition)";
export const BOX_DIST = "max(abs(unitPosition.x), abs(unitPosition.y))";

export class BoxLayer<DataT = unknown, ExtraPropsT extends {} = {}> extends ScatterplotLayer<DataT, ExtraPropsT> {
  static layerName = "BoxLayer";
  getShaders() {
    const shaders = super.getShaders();
    // Fail loudly if a deck.gl upgrade renames the expression (tests run this).
    if (!shaders.fs.includes(CIRCLE_DIST)) throw new Error("BoxLayer: ScatterplotLayer fragment shader changed");
    return { ...shaders, fs: shaders.fs.split(CIRCLE_DIST).join(BOX_DIST) };
  }
}

/** The layer class for the style's city markers: BoxLayer for "box", the
    plain ScatterplotLayer for "circle". */
export function markerLayer(style: MapStyle): typeof ScatterplotLayer {
  return style.marker.shape === "box" ? BoxLayer : ScatterplotLayer;
}

/** The radius (circle) or half-side (box) to draw a marker that a circle of
    radius r would draw: r itself, or half of boxSide(r) so the square has
    the circle's area. */
export function markerRadius(style: MapStyle, r: number): number {
  return style.marker.shape === "box" ? boxSide(r) / 2 : r;
}
