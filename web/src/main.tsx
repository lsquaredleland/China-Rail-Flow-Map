import { createRoot } from "react-dom/client";
import App from "./App";
import { loadDeck } from "./components/map/deck/load";
import { RELOAD_NOTICE, onStaleReload } from "./staleReload";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<App />);
}

/* ?renderer=deck: temporary hook until P1b.1 mounts DeckHost from MapCanvas.
   Loads the lazy deck chunk; on failure shows the reload notice or an error. */
if (new URLSearchParams(location.search).get("renderer") === "deck") {
  const note = (msg: string) => {
    let el = document.getElementById("deck-status");
    if (!el) {
      el = document.createElement("div");
      el.id = "deck-status";
      el.style.cssText =
        "position:fixed;left:12px;bottom:12px;z-index:99;padding:6px 10px;border-radius:6px;background:#222;color:#fff;font:13px sans-serif";
      document.body.appendChild(el);
    }
    el.textContent = msg;
  };
  onStaleReload(() => note(RELOAD_NOTICE));
  loadDeck().catch(() => {
    // The recovery reload (if any) has already announced itself via onStaleReload.
    if (document.getElementById("deck-status")?.textContent !== RELOAD_NOTICE) {
      note("Could not load the deck.gl renderer — please reload the page.");
    }
  });
}
