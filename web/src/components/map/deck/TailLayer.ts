// @ts-nocheck
// SPIKE (C1): LineLayer has only getColor; the tail fades alpha source -> target
// by injecting `vColor.a *= positions.x` (positions.x = 0 at source, 1 at target).
import { LineLayer } from "@deck.gl/layers";

export class TailLayer extends LineLayer {
  static layerName = "TailLayer";
  getShaders() {
    const shaders = super.getShaders();
    return { ...shaders, inject: { ...(shaders.inject || {}), "vs:#main-end": "vColor.a *= positions.x;" } };
  }
}
