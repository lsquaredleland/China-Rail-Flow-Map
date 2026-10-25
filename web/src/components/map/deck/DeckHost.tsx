/* Stub until P1b.1: pulls in the deck.gl packages the migration needs so the
   lazy chunk (and its size budget) is real, and renders nothing. Only reached
   through load.ts, i.e. with ?renderer=deck. */
import { Deck, OrthographicView } from "@deck.gl/core";
import { DataFilterExtension, PathStyleExtension } from "@deck.gl/extensions";
import { TripsLayer } from "@deck.gl/geo-layers";
import { LineLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";

export const deckModules = {
  Deck, OrthographicView, DataFilterExtension, PathStyleExtension,
  TripsLayer, LineLayer, PathLayer, ScatterplotLayer, TextLayer,
};

export default function DeckHost() {
  return null;
}
