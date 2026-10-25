/* Storage that never throws. Reading `window.localStorage` itself can
   throw (blocked site data, sandboxed iframes, some private modes), as can
   every get/set/remove (quota, disabled storage), so each access is wrapped
   and a failure reads as "nothing stored" / "write dropped". */
export interface SafeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

function safeStorage(kind: "local" | "session"): SafeStorage {
  const area = (): Storage | null => {
    try {
      return kind === "local" ? window.localStorage : window.sessionStorage;
    } catch {
      return null;
    }
  };
  return {
    get(key) {
      try {
        return area()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        area()?.setItem(key, value);
      } catch {
        /* storage unavailable or full: the preference just isn't kept */
      }
    },
    remove(key) {
      try {
        area()?.removeItem(key);
      } catch {
        /* storage unavailable */
      }
    },
  };
}

export const local = safeStorage("local");
export const session = safeStorage("session");
