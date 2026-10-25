import type { CityPointVM, DepVM, Direction, OriginVM } from "../../types";

export const CLASS_NAMES: Record<string, string> = {
  G: "G · High-speed (Fuxing / Hexie)",
  D: "D · Bullet (CRH / EMU)",
  C: "C · Intercity high-speed",
  S: "S · Suburban / commuter",
  Z: "Z · Direct express",
  T: "T · Express",
  K: "K · Fast",
  Y: "Y · Tourist",
  plain: "普 · Ordinary",
};

export function depDayOffset(d: DepVM): number {
  if (d.dur < 0) return 0;
  const dm =
    parseInt(d.dep.slice(0, 2), 10) * 60 + parseInt(d.dep.slice(3, 5), 10);
  return Math.floor((dm + d.dur) / 1440);
}

export function normCityStr(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f'’]/g, "");
}

/** Match a search query against the map's reachable cities in the current
    direction so typing a city name in the search bar activates the same
    "Calling at" / "Arriving from" city-pair view as clicking its dot. */
export function matchCityFromQuery(
  cur: OriginVM | null,
  direction: Direction,
  q: string,
): { city: CityPointVM | null; restQuery: string } {
  if (!cur || !q) return { city: null, restQuery: q };
  const points: CityPointVM[] = direction === "out" ? cur.dests : cur.srcs;
  const qNorm = normCityStr(q);
  // 1. Exact match on English or Chinese city name
  const exact = points.find(
    (c) => normCityStr(c.en) === qNorm || c.zh === q,
  );
  if (exact) return { city: exact, restQuery: "" };
  // 2. City name followed by a sub-filter token (e.g. "Chongqing G")
  for (const c of points) {
    const enN = normCityStr(c.en);
    if (qNorm.startsWith(enN + " ")) {
      return { city: c, restQuery: q.slice(c.en.length).trim() };
    }
    if (q.startsWith(c.zh + " ")) {
      return { city: c, restQuery: q.slice(c.zh.length).trim() };
    }
  }
  // 3. Unique prefix match (at least 3 Latin chars or 2 Chinese chars)
  const isCjk = /[\u4e00-\u9fff]/.test(q);
  if (isCjk ? q.length >= 2 : qNorm.length >= 3) {
    const pref = points.filter(
      (c) => normCityStr(c.en).startsWith(qNorm) || c.zh.startsWith(q),
    );
    if (pref.length === 1) return { city: pref[0], restQuery: "" };
  }
  return { city: null, restQuery: q };
}

/** "D", "G/D", "普": the selected train classes as the top stat words them. */
export const classTag = (classes: string[]): string =>
  classes.map((c) => (c === "plain" ? "普" : c)).join("/");

/** Rows whose train class is selected (no selection keeps all): the heading
    count. Only the class chips narrow it; search and histograms do not. */
export const byClass = <T,>(rows: T[], classes: string[], cls: (r: T) => string) =>
  classes.length ? rows.filter((r) => classes.includes(cls(r))) : rows;
