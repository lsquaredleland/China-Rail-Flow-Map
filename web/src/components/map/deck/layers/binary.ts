/* Binary PathLayer data from a DecodedSet: the geometry is uploaded as flat
   typed arrays (no per-vertex JS accessors). Pure; no deck.gl import. */
import type { DecodedSet } from "../../../../types";

export interface BinaryPaths {
  length: number;
  startIndices: Uint32Array;
  attributes: { getPath: { value: Float32Array; size: 2 } };
}

/** Paths of `set` for which `include(i)` holds (all when omitted), plus
    `extra` flat [lon, lat, ...] pieces. `closed` repeats each path's first
    point, for ring outlines. A set whose polylines already sit back to back
    in `pts` is wrapped without copying. */
export function binaryPaths(
  set: DecodedSet,
  opts: { include?: (i: number) => boolean; extra?: ArrayLike<number>[]; closed?: boolean } = {},
): BinaryPaths {
  const { include, extra = [], closed = false } = opts;
  const n = set.len.length;
  if (!include && !closed && extra.length === 0) {
    let contiguous = true;
    let expect = 0;
    for (let i = 0; i < n; i++) {
      if (set.off[i] !== expect) {
        contiguous = false;
        break;
      }
      expect += set.len[i] * 2;
    }
    if (contiguous && expect === set.pts.length) {
      const startIndices = new Uint32Array(n);
      for (let i = 0; i < n; i++) startIndices[i] = set.off[i] / 2;
      return { length: n, startIndices, attributes: { getPath: { value: set.pts, size: 2 } } };
    }
  }
  const sel: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (include && !include(i)) continue;
    sel.push(i);
    total += set.len[i] + (closed ? 1 : 0);
  }
  for (const e of extra) total += e.length / 2;
  const pts = new Float32Array(total * 2);
  const startIndices = new Uint32Array(sel.length + extra.length);
  let w = 0;
  let k = 0;
  for (const i of sel) {
    startIndices[k++] = w / 2;
    pts.set(set.pts.subarray(set.off[i], set.off[i] + set.len[i] * 2), w);
    w += set.len[i] * 2;
    if (closed) {
      pts[w] = set.pts[set.off[i]];
      pts[w + 1] = set.pts[set.off[i] + 1];
      w += 2;
    }
  }
  for (const e of extra) {
    startIndices[k++] = w / 2;
    for (let j = 0; j < e.length; j++) pts[w++] = e[j];
  }
  return { length: startIndices.length, startIndices, attributes: { getPath: { value: pts, size: 2 } } };
}
