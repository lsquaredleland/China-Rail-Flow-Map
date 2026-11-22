/* Screen effects (an exploration, terminal skin only): `?fx=crt` turns on the
   "CRT capture" look of the reference video. Fixed per page load. Tuning for
   the exploration: `&fxSplit=` (channel offset, CSS px), `&fxGlow=` (bloom). */
export type Fx = "crt" | null;

export function fxFromUrl(search: string = typeof location === "undefined" ? "" : location.search): Fx {
  return new URLSearchParams(search).get("fx") === "crt" ? "crt" : null;
}

/** Numeric tuning param, or undefined when absent or not a finite number. */
export function fxNum(name: string, search: string = typeof location === "undefined" ? "" : location.search): number | undefined {
  const v = new URLSearchParams(search).get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** The CRT look's face: Hershey Simplex (A. V. Hershey's plotter lettering,
    AVHershey-OTF, CC0/WTFPL), self-hosted in public/fonts. Registered as
    'CRT Face' only under ?fx=crt, so the terminal stack's first entry is
    otherwise absent and Share Tech Mono draws. Call once before the first render. */
export function registerFxFont(): void {
  if (fxFromUrl() !== "crt" || typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) return;
  const face = new FontFace("CRT Face", "url(fonts/AVHersheySimplexMedium.otf)");
  document.fonts.add(face);
  face.load().catch(() => {});
}
