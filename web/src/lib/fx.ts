/* Screen effects (terminal skin only). The "CRT capture" look of the
   reference video is the terminal default; `?fx=off` turns it off. Fixed per
   page load. Tuning: `&fxSplit=` (channel offset, CSS px), `&fxGlow=` (bloom). */
export type Fx = "crt" | null;

export function fxFromUrl(search: string = typeof location === "undefined" ? "" : location.search): Fx {
  const v = new URLSearchParams(search).get("fx");
  return v === "off" || v === "none" ? null : "crt";
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
    'CRT Face' only on the terminal skin with the CRT look on (the pre-paint
    script has set data-skin by now), so otherwise the terminal stack's first
    entry is absent and Share Tech Mono draws. Call once before the first render. */
export function registerFxFont(): void {
  if (typeof document === "undefined" || !document.fonts || typeof FontFace === "undefined") return;
  if (fxFromUrl() !== "crt" || document.documentElement.getAttribute("data-skin") !== "terminal") return;
  const face = new FontFace("CRT Face", "url(fonts/AVHersheySimplexMedium.otf)");
  document.fonts.add(face);
  face.load().catch(() => {});
}
