/* Google Analytics 4. The Measurement ID is baked in at build time from the
   GA_MEASUREMENT_ID env var (bundle.mjs); without one, nothing loads and
   track() is a no-op, so local builds, tests and previews send nothing. */

declare const __GA_ID__: string | undefined;

type Gtag = (...args: unknown[]) => void;
type Params = Record<string, string | number | boolean>;

const gaId = (): string => (typeof __GA_ID__ === "undefined" ? "" : __GA_ID__);

export function initAnalytics(): void {
  const id = gaId();
  if (!id) return;
  const w = window as unknown as { dataLayer: unknown[]; gtag: Gtag };
  w.dataLayer = w.dataLayer || [];
  // gtag.js reads the `arguments` object, not an array.
  w.gtag = function () {
    w.dataLayer.push(arguments);
  };
  w.gtag("js", new Date());
  w.gtag("config", id, { allow_google_signals: false, allow_ad_personalization_signals: false });
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(s);
}

/** Send one GA4 event; a no-op without a Measurement ID. */
export function track(name: string, params?: Params): void {
  const g = (window as unknown as { gtag?: Gtag }).gtag;
  if (g) g("event", name, params ?? {});
}
