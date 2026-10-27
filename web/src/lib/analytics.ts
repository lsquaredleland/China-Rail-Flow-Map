/* Google Analytics 4. It loads only on the production host, so local
   builds, tests and preview deployments send nothing and track() is a
   no-op there. A Measurement ID is public (it ships in every page). */

const GA_ID = "G-Z5R7L1HYS1";
const PROD_HOST = "china-rail-flow-map-web.vercel.app";

type Gtag = (...args: unknown[]) => void;
type Params = Record<string, string | number | boolean>;

export function initAnalytics(): void {
  if (window.location.hostname !== PROD_HOST) return;
  const w = window as unknown as { dataLayer: unknown[]; gtag: Gtag };
  w.dataLayer = w.dataLayer || [];
  // gtag.js reads the `arguments` object, not an array.
  w.gtag = function () {
    w.dataLayer.push(arguments);
  };
  w.gtag("js", new Date());
  w.gtag("config", GA_ID, { allow_google_signals: false, allow_ad_personalization_signals: false });
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
  document.head.appendChild(s);
}

/** Send one GA4 event; a no-op without a Measurement ID. */
export function track(name: string, params?: Params): void {
  const g = (window as unknown as { gtag?: Gtag }).gtag;
  if (g) g("event", name, params ?? {});
}
