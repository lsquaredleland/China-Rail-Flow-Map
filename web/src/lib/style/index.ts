/* The style seam (skins P1): everything the map, legend, canvas labels, cards
   and tooltip need to *look* a certain way, resolved once per (skin, mode)
   into one frozen MapStyle. Facts live in the pack; presentation lives here.

   Two independent axes:
     skin  the look (paper today; terminal later), data only;
     mode  light / dark, as chosen by the day/night toggle.
   A skin declares the modes it supports; resolveMode maps an unsupported
   request onto the skin's default (a dark-only skin ignores "light").

   mapStyle(skin, mode) is memoised: the same resolved pair always returns the
   same object, so layer caches and deck updateTriggers may key on identity.
   Callers must not mutate it (its objects are frozen; its arrays, such as the
   RGBA tuples, are shared and must be treated as read-only). */
import type { Palette, RampStop } from "../../types";
import { palette, rgba } from "../palette";
import type { RGBA } from "../palette";
import { LINE_COLOR, NODE_COLOR, NODE_SIZE } from "./encodings";
import type { LineColorEncoding, NodeColorEncoding, NodeSizeEncoding, SpeedRamp } from "./encodings";

export { LINE_COLOR, NODE_COLOR, NODE_SIZE, SPEED_BANDS, boxSide, speedBand } from "./encodings";
export type {
  LineColorEncoding,
  LineColorId,
  LineColorStyle,
  LineFact,
  NodeColorEncoding,
  NodeColorId,
  NodeSizeEncoding,
  NodeSizeId,
  SpeedRamp,
} from "./encodings";

/** Light or dark: the day/night axis, independent of the skin. */
export type Mode = "light" | "dark";

/** A registered skin. Only "paper" (today's look) exists in P1. */
export type SkinId = "paper";

/** The skin used when nothing else selects one. */
export const DEFAULT_SKIN: SkinId = "paper";

/** One colour in both forms: `css` for Canvas 2D, SVG and HTML, `rgba` (0-255,
    from the same `rgba()` parse) for deck.gl. Never mutate `rgba`. */
export interface Ink {
  readonly css: string;
  readonly rgba: RGBA;
}

/** Named colours. Keys mirror the Palette where one exists; the rest are the
    literals formerly inlined as `dark ? a : b` across the client. */
export interface Inks {
  // --- the Palette's colours (see types.ts Palette) ---
  readonly paper: Ink;
  readonly network: Ink;
  readonly graticule: Ink;
  readonly flow: Ink;
  readonly flowHi: Ink;
  readonly chord: Ink;
  readonly infraLine: Ink;
  readonly infraHsr: Ink;
  readonly infraConv: Ink;
  readonly dot: Ink;
  readonly dotEdge: Ink;
  readonly label: Ink;
  readonly labelHalo: Ink;
  readonly origin: Ink;
  readonly legendInk: Ink;
  readonly legendLine: Ink;
  readonly outline: Ink;
  readonly dashLine: Ink;
  readonly landFill: Ink;
  // --- formerly inline literals ---
  /** Dashed Qiongzhou ferry crossing (backdrop, flow and infra dashes). */
  readonly ferry: Ink;
  /** The hovered ferry section's open-water dash (flows highlightLayers). */
  readonly ferryHi: Ink;
  /** Golden arrival ripple around a city marker. */
  readonly ripple: Ink;
  /** Selection / hover ring around a city or the origin. */
  readonly ring: Ink;
  /** The origin disc's fill and edge (deck), and its diamond (label overlay). */
  readonly originFill: Ink;
  readonly originEdge: Ink;
  readonly originMark: Ink;
  /** Boxed labels (origin, selected city): fill, 1 px frame and text. */
  readonly labelBox: Ink;
  readonly labelBoxEdge: Ink;
  readonly labelBoxText: Ink;
  /** Train classes: high-speed (G D C), conventional (Z T K S), the rest (普). */
  readonly trainHs: Ink;
  readonly trainConv: Ink;
  readonly trainOther: Ink;
  /** A train dot's core and the plain (non-isolated) train ring. */
  readonly trainCore: Ink;
  /** Train code tags on the label overlay: dark plate and its text. */
  readonly tagPlate: Ink;
  readonly tagText: Ink;
  /** Tooltip train-code badge: high-speed / conventional. */
  readonly badgeHs: Ink;
  readonly badgeConv: Ink;
  /** Tooltip train-code badge text ("#fff", byte-identical to the tooltip golden). */
  readonly badgeText: Ink;
  /** Tooltip status lines: boarding (dwell), arrived (final stop), muted note. */
  readonly statusDwell: Ink;
  readonly statusArrived: Ink;
  readonly statusMuted: Ink;
  /** Timeline rush badge: rush hours, all arrived, night, later days, regular. */
  readonly rushPeak: Ink;
  readonly rushDone: Ink;
  readonly rushNight: Ink;
  readonly rushTail: Ink;
  readonly rushRegular: Ink;
  /** Legend time-bar label text on the petrol / saffron / ultramarine blocks. */
  readonly bandLabelOnDark: Ink;
  readonly bandLabelOnLight: Ink;
}

/** Alphas that differ by mode (formerly `dark ? x : y` in lib/mapModel and the
    national cities). Each names its one use. */
export interface Alphas {
  /** Faded context flows and dimmed cities under a selected destination or
      filtered view; also the chords then (0.16 / 0.18). */
  readonly context: number;
  /** Flows an isolated train fades to (isoFlowAlpha). */
  readonly isoFlow: number;
  /** Chords while a train is isolated. */
  readonly isoChord: number;
  /** Infrastructure overlay while a train is isolated. */
  readonly isoInfra: number;
  /** Infrastructure overlay of the non-connected sections under a selected destination. */
  readonly contextInfra: number;
  /** National city circles' translucent fill. */
  readonly natCityFill: number;
}

/** How paths are stroked. The two flags are deck PathLayer props, so a solid
    path layer may spread `...style.line`. Dashed layers keep flat caps
    (`capRounded: false`) in every skin and take only `jointRounded`. */
export interface LineStyle {
  readonly capRounded: boolean;
  readonly jointRounded: boolean;
}

/** City marker shape. Only circles exist in P1 (boxes come with terminal). */
export type MarkerShape = "circle";

/** City markers. */
export interface MarkerStyle {
  readonly shape: MarkerShape;
  /** Edge stroke of a city marker in CSS px (origin dots; the national
      circles cap at it). */
  readonly edgeWidth: number;
}

/** Fonts for Canvas 2D and SVG text. */
export interface FontStyle {
  /** City labels (canvas) and the legend (SVG). */
  readonly family: string;
  /** Train code tags on the label overlay (canvas). */
  readonly tag: string;
}

/** The encodings a skin draws with, resolved from the registries. */
export interface Encodings {
  readonly lineColor: LineColorEncoding;
  readonly nodeColor: NodeColorEncoding;
  /** National city circles' fill. */
  readonly natNodeColor: NodeColorEncoding;
  readonly nodeSize: NodeSizeEncoding;
  readonly natNodeSize: NodeSizeEncoding;
}

/** Everything presentation needs for one (skin, mode). Built by mapStyle. */
export interface MapStyle {
  readonly skin: SkinId;
  /** The resolved mode (resolveMode), not necessarily the requested one. */
  readonly mode: Mode;
  /** `skin|mode`: a stable string for keys that cannot hold an object. */
  readonly key: string;
  /** The legacy palette, for the palette.ts helpers (flowColor, rampColor) and
      encodings. Prefer `ink` everywhere else. */
  readonly pal: Palette;
  /** The palette with the card's lifted ramp (MapCards cardBand): at night the
      saffron band lifts to #F0B85A; by day it is `pal`. */
  readonly cardPal: Palette;
  readonly ink: Inks;
  /** The speed-band ramp the speedLimit line colour reads (SPEED_BANDS order). */
  readonly speedBands: SpeedRamp;
  readonly alpha: Alphas;
  readonly line: LineStyle;
  readonly marker: MarkerStyle;
  readonly font: FontStyle;
  readonly enc: Encodings;
}

/** A skin's declaration: which modes it supports and how to build each. */
export interface SkinDef {
  readonly id: SkinId;
  /** Supported modes, non-empty. A single-mode skin hides the day/night toggle. */
  readonly modes: readonly Mode[];
  /** Used when the requested mode is not in `modes`. */
  readonly defaultMode: Mode;
  /** Builds the style for a supported mode (called once per mode, memoised). */
  build(mode: Mode): Omit<MapStyle, "skin" | "mode" | "key">;
}

const ink = (css: string): Ink => ({ css, rgba: rgba(css) });
const pick = (mode: Mode, light: string, dark: string) => ink(mode === "dark" ? dark : light);

/* The saffron band of the time ramp, and its night lift on cards. */
const SAFFRON: readonly number[] = [227, 166, 63];
const SAFFRON_CARD_NIGHT: [number, number, number] = [240, 184, 90];

/** Paper: today's look, light and dark. Every value is the one formerly
    inlined at its call site. */
const PAPER: SkinDef = {
  id: "paper",
  modes: ["light", "dark"],
  defaultMode: "light",
  build(mode) {
    const dark = mode === "dark";
    const pal = palette(dark);
    const cardPal: Palette = dark
      ? {
          ...pal,
          ramp: pal.ramp.map(([t, c]) =>
            [t, c[0] === SAFFRON[0] && c[1] === SAFFRON[1] && c[2] === SAFFRON[2] ? SAFFRON_CARD_NIGHT : c] as RampStop),
        }
      : pal;
    const inks: Inks = {
      paper: ink(pal.paper),
      network: ink(pal.network),
      graticule: ink(pal.graticule),
      flow: ink(pal.flow),
      flowHi: ink(pal.flowHi),
      chord: ink(pal.chord),
      infraLine: ink(pal.infraLine),
      infraHsr: ink(pal.infraHsr),
      infraConv: ink(pal.infraConv),
      dot: ink(pal.dot),
      dotEdge: ink(pal.dotEdge),
      label: ink(pal.label),
      labelHalo: ink(pal.labelHalo),
      origin: ink(pal.origin),
      legendInk: ink(pal.legendInk),
      legendLine: ink(pal.legendLine),
      outline: ink(pal.outline),
      dashLine: ink(pal.dashLine),
      landFill: ink(pal.landFill),
      ferry: pick(mode, "#0284C7", "#38BDF8"),
      ferryHi: pick(mode, "#0284C7", "#7DD3FC"),
      ripple: pick(mode, "#D97706", "#F59E0B"),
      ring: pick(mode, "#111111", "#EDEDEA"),
      originFill: pick(mode, "#111111", "#EDEDEA"),
      originEdge: pick(mode, "#ffffff", "#1A1B1E"),
      originMark: pick(mode, "#ffffff", "#1A1B1E"),
      labelBox: pick(mode, "#ffffff", "#1A1B1E"),
      labelBoxEdge: pick(mode, "#111111", "#EDEDEA"),
      labelBoxText: pick(mode, "#111111", "#EDEDEA"),
      trainHs: ink("#F59E0B"),
      trainConv: ink("#06B6D4"),
      trainOther: ink("#E2E8F0"),
      trainCore: ink("#ffffff"),
      tagPlate: ink("rgba(15, 23, 42, 0.90)"),
      tagText: ink("#FFFFFF"),
      badgeHs: ink("#F59E0B"),
      badgeConv: ink("#0284C7"),
      badgeText: ink("#fff"),
      statusDwell: ink("#F59E0B"),
      statusArrived: ink("#10B981"),
      statusMuted: ink("#9CA3AF"),
      rushPeak: pick(mode, "#C8302A", "#E54035"),
      rushDone: ink("#10B981"),
      rushNight: pick(mode, "#9CA3AF", "#6B7280"),
      rushTail: pick(mode, "#D97706", "#F59E0B"),
      rushRegular: pick(mode, "#6B7280", "#4B5563"),
      bandLabelOnDark: ink("#ffffff"),
      bandLabelOnLight: ink("#111111"),
    };
    return {
      pal,
      cardPal,
      ink: inks,
      // Unused while paper colours lines by volume: the time bands and the flow red.
      speedBands: {
        bands: ["#8E1B17", "#C8302A", "#E3A63F", "#14746F", dark ? "#8F9CF2" : "#34488C"],
        untagged: pal.network,
      },
      alpha: {
        context: dark ? 0.16 : 0.18,
        isoFlow: dark ? 0.06 : 0.08,
        isoChord: dark ? 0.05 : 0.08,
        isoInfra: dark ? 0.08 : 0.1,
        contextInfra: dark ? 0.18 : 0.2,
        natCityFill: dark ? 0.4 : 0.35,
      },
      line: { capRounded: true, jointRounded: true },
      marker: { shape: "circle", edgeWidth: dark ? 3.0 : 1.5 },
      font: {
        family: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans SC', sans-serif",
        tag: "monospace",
      },
      enc: {
        lineColor: LINE_COLOR.volume,
        nodeColor: NODE_COLOR.timeBand,
        natNodeColor: NODE_COLOR.flat,
        nodeSize: NODE_SIZE.stationRadius,
        natNodeSize: NODE_SIZE.natCityRadius,
      },
    };
  },
};

/** Every skin by id. */
export const SKINS: Readonly<Record<SkinId, SkinDef>> = { paper: PAPER };

/** The mode a skin actually draws for a requested mode: the request when the
    skin supports it, else the skin's default (e.g. a dark-only skin). */
export function resolveMode(skin: SkinId, requested: Mode): Mode {
  const def = SKINS[skin];
  return def.modes.includes(requested) ? requested : def.defaultMode;
}

/** A skin id from untrusted text (`?skin=`, storage): a registered id as is,
    anything else (unknown, empty, null) the default skin. */
export function parseSkin(s: string | null | undefined): SkinId {
  return s && Object.prototype.hasOwnProperty.call(SKINS, s) ? (s as SkinId) : DEFAULT_SKIN;
}

/** True when the skin supports both modes, i.e. the day/night toggle applies. */
export function skinHasModeToggle(skin: SkinId): boolean {
  return SKINS[skin].modes.length > 1;
}

/** The P1 bridge from the legacy `dark` boolean to a Mode. */
export const modeOf = (dark: boolean): Mode => (dark ? "dark" : "light");

const memo = new Map<string, MapStyle>();

/* Freezes the style's objects but not its arrays: the RGBA tuples are the
   shared rgba() cache entries that layers already pass to deck as is. */
function freezeDeep<T extends object>(o: T): T {
  for (const v of Object.values(o)) if (v && typeof v === "object" && !Array.isArray(v) && !Object.isFrozen(v)) freezeDeep(v as object);
  return Object.freeze(o);
}

/** The resolved style of `skin` in `mode` (an unsupported mode resolves to the
    skin's default). Memoised: the same resolved pair returns the same object. */
export function mapStyle(skin: SkinId, mode: Mode): MapStyle {
  const m = resolveMode(skin, mode);
  const key = skin + "|" + m;
  let st = memo.get(key);
  if (!st) {
    st = freezeDeep({ skin, mode: m, key, ...SKINS[skin].build(m) });
    memo.set(key, st);
  }
  return st;
}
