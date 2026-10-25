// Pure helpers for the pack benchmark (unit-tested in helpers.test.ts).
export const median = (a: number[]): number => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
export const fmtMs = (t: number): string => t.toFixed(1) + " ms";
export const fmtMB = (b: number): string => (b / 1048576).toFixed(1) + " MB";
export const fmtKB = (n: number): string => (n / 1024).toFixed(0) + " KB";

/** "atlas-v2-out-tables.json.br" -> "atlas-v2-out-tables"; null for other files. */
export const packName = (file: string): string | null => (file.endsWith(".json.br") ? file.slice(0, -8) : null);

/** Which expand step (if any) a pack file feeds. */
export const expandKind = (name: string): "out" | "in" | null =>
  name.endsWith("-out-tables") ? "out" : name.endsWith("-in-tables") ? "in" : null;

/** Markdown table; columns after the first are right-aligned. */
export function renderTable(head: string[], rows: string[][]): string {
  const line = (r: string[]) => `| ${r.join(" | ")} |`;
  const sep = head.map((_, i) => (i === 0 ? "---" : "---:"));
  return [line(head), line(sep), ...rows.map(line)].join("\n");
}
