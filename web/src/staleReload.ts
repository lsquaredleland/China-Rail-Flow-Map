/* Recovery from a deploy that happened while the tab was open. The build
   content-hashes the data packs and index.html names them, so a tab holding
   the old index.html 404s on its lazily fetched packs once the new deploy
   has replaced them. One page reload picks up the new index.html. */
import { session } from "./storage";

const RELOAD_KEY = "staleReloadAt";
export const RELOAD_COOLDOWN_MS = 60_000;
export const RELOAD_NOTICE = "A newer version of the map is available — reloading…";

/* Hashed pack, e.g. assets/out-tables.1a2b3c4d.json.br (or .ta1.br) */
const HASHED_PACK = /(^|\/)assets\/[^/?#]+\.[0-9a-f]{8}\.(json|ta1)\.br(\?|#|$)/;

/* Pure decision: reload only for an HTTP 404 on a hashed pack, and not if a
   reload already happened within the cooldown (guards a reload loop when the
   file is genuinely gone). lastReloadAt is null when none is recorded. */
export function staleDecision(
  status: number,
  url: string,
  lastReloadAt: number | null,
  now: number,
): "reload" | "error" {
  if (status !== 404 || !HASHED_PACK.test(url)) return "error";
  if (lastReloadAt !== null && now - lastReloadAt >= 0 && now - lastReloadAt < RELOAD_COOLDOWN_MS) return "error";
  return "reload";
}

let listener: (() => void) | null = null;
/* The UI subscribes to show RELOAD_NOTICE while the reload is pending. */
export function onStaleReload(cb: (() => void) | null): void {
  listener = cb;
}

/* Pure decision for a failed dynamic import() of a hashed chunk: reload once
   (a new deploy replaced the chunk), unless offline (a reload would not help)
   or a reload already happened within the cooldown. */
export function importFailureDecision(
  lastReloadAt: number | null,
  now: number,
  online: boolean,
): "reload" | "error" {
  if (!online) return "error";
  if (lastReloadAt !== null && now - lastReloadAt >= 0 && now - lastReloadAt < RELOAD_COOLDOWN_MS) return "error";
  return "reload";
}

function startReload(): void {
  listener?.();
  // Brief pause so the notice is readable rather than a flash.
  setTimeout(() => location.reload(), 800);
}

/* Returns true if a reload was started (the caller should then stop). */
export function maybeReloadForFailedImport(): boolean {
  const raw = session.get(RELOAD_KEY);
  const last = raw === null || !Number.isFinite(+raw) ? null : +raw;
  const now = Date.now();
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  if (importFailureDecision(last, now, online) !== "reload") return false;
  session.set(RELOAD_KEY, String(now));
  startReload();
  return true;
}

/* Returns true if a reload was started (the caller should then stop). */
export function maybeReloadForStale(status: number, url: string): boolean {
  const raw = session.get(RELOAD_KEY);
  const last = raw === null || !Number.isFinite(+raw) ? null : +raw;
  const now = Date.now();
  if (staleDecision(status, url, last, now) !== "reload") return false;
  session.set(RELOAD_KEY, String(now));
  startReload();
  return true;
}
