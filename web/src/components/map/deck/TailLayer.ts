/* Motion-tail layer (C1): LineLayer has only getColor, so the tail fades from
   transparent at the source to opaque at the target by injecting
   `vColor.a *= positions.x` (positions.x is 0 at the source, 1 at the target).
   Used by layers/trains.ts. */
import { LineLayer } from "@deck.gl/layers";

export class TailLayer<DataT = unknown> extends LineLayer<DataT> {
  static layerName = "TailLayer";
  getShaders() {
    const shaders = super.getShaders();
    return {
      ...shaders,
      inject: { ...shaders.inject, "vs:#main-end": "vColor.a *= positions.x;" },
    };
  }
}
