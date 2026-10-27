/* Backdrop layers: land fill, outline, graticule, base network and the
   dashed Qiongzhou ferry crossing. Pure props builders: a function of the
   decoded atlas / outline, the palette and the view scale. The geometry is
   uploaded once per data object (WeakMap caches); only colours and the
   scale-dependent dash/width values change between calls, through
   updateTriggers. */
import type { Layer } from "@deck.gl/core";
import { PathStyleExtension } from "@deck.gl/extensions";
import { LineLayer, PathLayer, SolidPolygonLayer } from "@deck.gl/layers";
import type { DecodedAtlas, DecodedOutline, DecodedSet } from "../../../../types";
import { isFerrySection, paletteRGBA, splitFerry } from "../../../../lib";
import { binaryPaths } from "./binary";
import type { BinaryPaths } from "./binary";

interface BackdropInput {
  atlas: DecodedAtlas;
  outline: DecodedOutline | null;
  showOutline: boolean;
  showNetwork: boolean;
  dark: boolean;
  /** View scale in px per degree (S.current.view.scale). */
  scale: number;
}

const dashExt = new PathStyleExtension({ dash: true });

/* ---------- static geometry, one upload per data object ---------- */

interface OutlineGeom {
  polys: number[][];
  ringStroke: BinaryPaths;
  solid: BinaryPaths;
  dashed: BinaryPaths;
}
const outlineCache = new WeakMap<DecodedOutline, OutlineGeom>();
function outlineGeom(outline: DecodedOutline): OutlineGeom {
  let g = outlineCache.get(outline);
  if (g) return g;
  const { rings, lines } = outline;
  const polys: number[][] = [];
  for (let i = 0; i < rings.len.length; i++) {
    polys.push(Array.from(rings.pts.subarray(rings.off[i], rings.off[i] + rings.len[i] * 2)));
  }
  g = {
    polys,
    ringStroke: binaryPaths(rings, { closed: true }),
    // Canvas rule (backdrop.ts drawOutline): polylines of <= 4 points are the nine-dash line.
    solid: binaryPaths(lines, { include: (i) => lines.len[i] > 4 }),
    dashed: binaryPaths(lines, { include: (i) => lines.len[i] <= 4 }),
  };
  outlineCache.set(outline, g);
  return g;
}

interface NetworkGeom {
  land: BinaryPaths;
  water: BinaryPaths;
}
const networkCache = new WeakMap<DecodedSet, NetworkGeom>();
function networkGeom(net: DecodedSet): NetworkGeom {
  let g = networkCache.get(net);
  if (g) return g;
  const { landPieces, waterPieces } = splitFerry(net);
  g = {
    // The ferry sections are drawn as their overland pieces; the water leg is its own dashed layer.
    land: binaryPaths(net, {
      include: (i) => !isFerrySection(net.bb, i),
      extra: landPieces.map((p) => p.pts),
    }),
    water: pathsFromPieces(waterPieces.map((p) => p.pts)),
  };
  networkCache.set(net, g);
  return g;
}
function pathsFromPieces(pieces: number[][]): BinaryPaths {
  const startIndices = new Uint32Array(pieces.length);
  let total = 0;
  pieces.forEach((p, i) => {
    startIndices[i] = total / 2;
    total += p.length;
  });
  const pts = new Float32Array(total);
  let w = 0;
  for (const p of pieces) {
    pts.set(p, w);
    w += p.length;
  }
  return { length: pieces.length, startIndices, attributes: { getPath: { value: pts, size: 2 } } };
}

// 5-degree graticule over the extent the Canvas path can ever show.
const graticule: { s: [number, number]; t: [number, number] }[] = [];
for (let lon = 30; lon <= 180; lon += 5) graticule.push({ s: [lon, -10], t: [lon, 80] });
for (let lat = -10; lat <= 80; lat += 5) graticule.push({ s: [30, lat], t: [180, lat] });

/** Stroke widths / dashes the Canvas path derives from the view scale (px). */
function backdropMetrics(scale: number) {
  const dashW = Math.max(1, scale * 0.02);
  const ferryW = Math.min(3.5, Math.max(0.75, scale * 0.01));
  return {
    nineDash: [Math.max(6, dashW * 2.2), Math.max(4, dashW * 1.8)] as [number, number],
    ferryW,
    ferryDash: [Math.max(12, ferryW * 3), Math.max(8, ferryW * 2)] as [number, number],
  };
}

export function backdropLayers(inp: BackdropInput): Layer[] {
  const { atlas, outline, showOutline, showNetwork, dark, scale } = inp;
  const pal = paletteRGBA(dark);
  const m = backdropMetrics(scale);
  const L: Layer[] = [];
  const themeKey = dark ? "dark" : "light";
  if (showOutline && outline) {
    const g = outlineGeom(outline);
    L.push(
      // Binary polygons: the closed rings uploaded for the stroke are the fill's boundaries too.
      new SolidPolygonLayer({
        id: "outline-fill",
        data: g.polys,
        getPolygon: (d: number[]) => d,
        positionFormat: "XY",
        getFillColor: pal.landFill,
        updateTriggers: { getFillColor: themeKey },
      }),
      new PathLayer({
        id: "outline-ring",
        data: g.ringStroke,
        _pathType: "open",
        widthUnits: "common",
        getWidth: 0.015,
        widthMinPixels: 0.65,
        capRounded: true,
        jointRounded: true,
        getColor: pal.outline,
        updateTriggers: { getColor: themeKey },
      }),
      new PathLayer({
        id: "outline-lines",
        data: g.solid,
        _pathType: "open",
        widthUnits: "common",
        getWidth: 0.015,
        widthMinPixels: 0.65,
        capRounded: true,
        jointRounded: true,
        getColor: pal.outline,
        updateTriggers: { getColor: themeKey },
      }),
      new PathLayer({
        id: "outline-dash",
        data: g.dashed,
        _pathType: "open",
        widthUnits: "common",
        getWidth: 0.02,
        widthMinPixels: 1,
        getColor: pal.outline,
        extensions: [dashExt],
        dashUnits: "pixels",
        getDashArray: m.nineDash,
        updateTriggers: { getColor: themeKey, getDashArray: m.nineDash.join() },
      } as object),
    );
  }
  L.push(
    new LineLayer<{ s: [number, number]; t: [number, number] }>({
      id: "graticule",
      data: graticule,
      getSourcePosition: (d) => d.s,
      getTargetPosition: (d) => d.t,
      widthUnits: "pixels",
      getWidth: 0.5,
      getColor: pal.graticule,
      updateTriggers: { getColor: themeKey },
    }),
  );
  if (showNetwork) {
    const g = networkGeom(atlas.net);
    L.push(
      new PathLayer({
        id: "network",
        data: g.land,
        _pathType: "open",
        widthUnits: "common",
        getWidth: 0.008,
        widthMinPixels: 0.45,
        widthMaxPixels: 2.5,
        capRounded: true,
        jointRounded: true,
        getColor: pal.network,
        updateTriggers: { getColor: themeKey },
      }),
    );
    if (g.water.length > 0) {
      L.push(
        new PathLayer({
          id: "ferry-water",
          data: g.water,
          _pathType: "open",
          widthUnits: "pixels",
          getWidth: m.ferryW,
          getColor: pal.ferry,
          extensions: [dashExt],
          dashUnits: "pixels",
          getDashArray: m.ferryDash,
          updateTriggers: { getColor: themeKey, getWidth: m.ferryW, getDashArray: m.ferryDash.join() },
        } as object),
      );
    }
  }
  return L;
}
