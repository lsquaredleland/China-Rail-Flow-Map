/* The "CRT capture" look (terminal skin, ?fx=crt; an exploration): a GPU
   post-process pass over the map, as the reference video's misconverged
   tube shows it. Each colour channel is sampled slightly apart (red ghost to
   the left, green to the right), strokes bloom a little, and edges soften.
   Grain and scanlines are a CSS overlay over the whole page (terminal.css),
   so the HTML chrome and the map share them. */
import { PostProcessEffect } from "@deck.gl/core";
import type { Effect } from "@deck.gl/core";

export interface CrtProps {
  /** Channel offset, device px. */
  split: number;
  /** Bloom strength (0 none). */
  glow: number;
  /** Bloom radius, device px. */
  radius: number;
}

const fs = /* glsl */ `\
uniform crtUniforms {
  float split;
  float glow;
  float radius;
} crt;

vec4 crt_sampleColor(sampler2D source, vec2 texSize, vec2 coord) {
  vec2 px = 1.0 / texSize;
  vec2 o = vec2(crt.split, 0.0) * px;
  vec4 c = texture(source, coord);
  vec4 r = texture(source, coord - o);
  vec4 g = texture(source, coord + o);
  // misconvergence: each channel's ghost, never darker than the image itself
  vec3 col = vec3(max(c.r, r.r * 0.9), max(c.g, g.g * 0.8), c.b);
  float a = max(c.a, max(r.a * 0.9, g.a * 0.8));
  // bloom: a small ring of taps
  vec4 b = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.785398;
    b += texture(source, coord + vec2(cos(ang), sin(ang)) * crt.radius * px);
  }
  b *= 0.125;
  col += b.rgb * crt.glow;
  a = max(a, b.a * crt.glow);
  return vec4(min(col, vec3(1.0)), min(a, 1.0));
}
`;

const crtModule = {
  name: "crt",
  fs,
  uniformTypes: { split: "f32", glow: "f32", radius: "f32" },
  defaultUniforms: { split: 1.5, glow: 0.35, radius: 2.0 },
  passes: [{ sampler: true }],
};

/** The map's CRT pass, scaled to the device pixel ratio. */
export function crtEffect(dpr: number, p: Partial<CrtProps> = {}): Effect {
  const props: CrtProps = { split: 1.5 * dpr, glow: 0.35, radius: 2 * dpr, ...p };
  return new PostProcessEffect(crtModule as never, props as never) as unknown as Effect;
}
