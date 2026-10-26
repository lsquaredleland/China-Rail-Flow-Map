/* The single import() entry for deck.gl code. The build emits it as a hashed
   lazy chunk, so a tab holding an old index.html can fail to fetch it after a
   deploy; that failure triggers one recovery reload (see staleReload.ts). */
import { maybeReloadForFailedImport } from "../../../staleReload";

type DeckHostModule = typeof import("./DeckHost");

export function loadDeck(): Promise<DeckHostModule> {
  return import("./DeckHost").catch((err) => {
    maybeReloadForFailedImport();
    throw err;
  });
}
