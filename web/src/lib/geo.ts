/* Station lookups and great-circle distance. */
import type {
  AtlasData,
} from "../types";
import { enName } from "./format";

/* ---------- station lookups ---------- */

export function stationName(data: AtlasData, idx: number): string | null {
  if (idx === null || idx === undefined || idx < 0) return null;
  const s = data.station_table[idx];
  return s ? s.zh : null;
}

export function stationLabel(data: AtlasData, idx: number): string {
  const s = data.station_table[idx];
  if (!s) return "—";
  return enName(s.en) + " · " + s.zh;
}

/** Great-circle distance in km between two [lon, lat] points. */
export function haversineKm(
  a: [number, number],
  b: [number, number],
): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a[1] * rad) *
      Math.cos(b[1] * rad) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}
