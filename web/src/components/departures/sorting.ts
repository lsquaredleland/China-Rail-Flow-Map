import type { SortState } from "./types";

/** Click on a header: flip the direction of the active key, or switch key. */
export function nextSort<K>(s: SortState<K>, k: K): SortState<K> {
  return s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 };
}

export function sortArrow<K>(s: SortState<K>, k: K): string {
  return s.key === k ? (s.dir === 1 ? "▲" : "▼") : "";
}

export function ariaSort<K>(s: SortState<K>, k: K): "ascending" | "descending" | undefined {
  return s.key === k ? (s.dir === 1 ? "ascending" : "descending") : undefined;
}
