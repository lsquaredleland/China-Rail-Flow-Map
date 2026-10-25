import { useEffect } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* Focus handling for a modal dialog (the element `ref` points at, which
   needs tabIndex={-1}): focus moves into the dialog when it opens, Tab and
   Shift+Tab stay inside it, and focus goes back to whatever had it before
   when the dialog closes. Spread the returned `onKeyDown` on the element.
   Escape is left to the caller's window-level listener so it keeps working
   wherever focus is. */
export function useDialogFocus(ref: RefObject<HTMLElement | null>): {
  onKeyDown: (e: ReactKeyboardEvent) => void;
} {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (opener && opener !== document.body && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [ref]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const root = ref.current;
    if (e.key !== "Tab" || !root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null,
    );
    if (items.length === 0) {
      e.preventDefault();
      root.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return { onKeyDown };
}
