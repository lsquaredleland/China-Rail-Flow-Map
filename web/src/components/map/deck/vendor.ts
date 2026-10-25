// SPIKE (throwaway): the only module that imports deck.gl, so the deck
// code can be measured (min/gzip/brotli) as one standalone bundle.
export { Deck, OrthographicView, OrthographicViewport } from "@deck.gl/core";
export { PathLayer, ScatterplotLayer, LineLayer, SolidPolygonLayer } from "@deck.gl/layers";
export { DataFilterExtension, PathStyleExtension } from "@deck.gl/extensions";
