/* The Guangdong-Hainan train ferry across the Qiongzhou Strait: which
   sections are the ferry corridor and where their water leg is. */

/** True when section `s` (bounding boxes `bb`, 4 floats per section:
    lon0 lat0 lon1 lat1) spans the strait. */
export function isFerrySection(bb: ArrayLike<number>, s: number): boolean {
  return (
    bb[s * 4 + 1] < 20.15 &&
    bb[s * 4 + 3] > 20.20 &&
    bb[s * 4] > 110.0 &&
    bb[s * 4 + 2] < 110.3
  );
}

/** A step between two consecutive points is the open-water crossing. */
export function isWaterCross(
  prevLon: number,
  prevLat: number,
  lon: number,
  lat: number,
): boolean {
  return (
    ((prevLat < 20.10 && lat > 20.18) || (prevLat > 20.18 && lat < 20.10)) &&
    prevLon > 109.9 && prevLon < 110.4 &&
    lon > 109.9 && lon < 110.4
  );
}

export interface FerryPiece {
  /** Section index. */
  s: number;
  /** Flat [lon, lat, lon, lat, ...]. */
  pts: number[];
}

/** Splits every ferry section of `set` into overland pieces and the water
    leg, using the same rule as the canvas "landOnly"/"waterOnly" tracing. */
export function splitFerry(set: {
  pts: ArrayLike<number>;
  off: ArrayLike<number>;
  len: ArrayLike<number>;
  bb: ArrayLike<number>;
}): { landPieces: FerryPiece[]; waterPieces: FerryPiece[] } {
  const landPieces: FerryPiece[] = [];
  const waterPieces: FerryPiece[] = [];
  const n = set.len.length;
  for (let s = 0; s < n; s++) {
    if (!isFerrySection(set.bb, s)) continue;
    const off = set.off[s];
    const count = set.len[s];
    let cur: number[] = [];
    for (let i = 0; i < count; i++) {
      const lon = set.pts[off + i * 2];
      const lat = set.pts[off + i * 2 + 1];
      if (i > 0) {
        const pLon = set.pts[off + (i - 1) * 2];
        const pLat = set.pts[off + (i - 1) * 2 + 1];
        if (isWaterCross(pLon, pLat, lon, lat)) {
          if (cur.length >= 4) landPieces.push({ s, pts: cur });
          cur = [];
          waterPieces.push({ s, pts: [pLon, pLat, lon, lat] });
        }
      }
      cur.push(lon, lat);
    }
    if (cur.length >= 4) landPieces.push({ s, pts: cur });
  }
  return { landPieces, waterPieces };
}
