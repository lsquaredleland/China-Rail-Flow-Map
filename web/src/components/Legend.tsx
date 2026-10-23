import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Palette } from "../types";
import { WIDTH_K, flowColor, rampColor, stationR } from "../lib";

/** The map's render loop redraws the legend scales through this handle:
    the stepped width bar's heights depend on the live zoom ratio. The
    Infrastructure overlay never changes what the widths mean — they
    still encode trains/day — so the legend keeps this normal form
    whether the toggle is on or off. */
export interface LegendHandle {
  draw: (
    pal: Palette,
    zoomRatio: number,
    hasOrigin: boolean,
    showInfra?: boolean,
  ) => void;
}

/* The legend card contains the three scales and nothing else — a 0–24h
   travel-time bar of three flat colour bands (always shown), a stepped
   width bar in the manner of the 1933 Hungarian freight legends: one
   ribbon on a shared baseline growing in discrete steps for 1, 10, 50,
   100 trains/day, each step's height exactly that value's stroke width
   on the map at the current zoom, with the value labels centred beneath
   their steps — and a circle-size scale of sample dots at the map's own
   dot sizes. The explanatory notes are the page's closing footnote,
   not part of the card.

   Everything here is resolution-independent vector content: real DOM
   text plus one inline SVG whose geometry is nudged imperatively when
   the map redraws (the stepped bar tracks the live zoom). Nothing is
   rasterised, so the card stays razor sharp at any device pixel ratio. */
interface LegendProps {
  // The time-band caption: "Fastest time from origin" outbound,
  // "Fastest time to <City>" inbound. The scales themselves are driven
  // through the imperative handle.
  title: string;
}

const W = 196; // card content width in CSS px (matches the old canvas)
const STEPS = [1, 10, 50, 100];
// The time bar wears the dots' three bands (see TIME_BANDS in lib.ts):
// gradient stops in minutes — each band flat, with the same ±30-minute
// blend at the 4h / 12h joins — under three labels centred on their
// blocks. BAR_H is tall enough to carry the labels inside the bar.
const BAND_STOPS = [0, 210, 270, 690, 750, 1440];
const BAND_HEX = ["#1b9e77", "#1b9e77", "#e69f00", "#e69f00", "#7570b3", "#7570b3"];
const BAND_LABELS: { label: string; mid: number; ink: string }[] = [
  { label: "0–4h", mid: 120, ink: "#17211c" },
  { label: "4–12h", mid: 480, ink: "#17211c" },
  { label: "12–24h", mid: 1080, ink: "#ffffff" },
];
const BAR_H = 15;
const TIMESEC_H = 8 + BAR_H + 6; // vertical room the band section takes
const SAMPLES = [10, 50, 200];
const FONT = "Georgia, 'Times New Roman', 'Songti SC', serif";

const Legend = forwardRef<LegendHandle, LegendProps>(function Legend(
  props,
  ref,
) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gradGroupRef = useRef<SVGGElement | null>(null);
  const stopRefs = useRef<(SVGStopElement | null)[]>([]);
  const stepRefs = useRef<(SVGRectElement | null)[]>([]);
  const widthGroupRef = useRef<SVGGElement | null>(null);
  const widthHeadRef = useRef<SVGTextElement | null>(null);
  const circleGroupRef = useRef<SVGGElement | null>(null);
  const infraGroupRef = useRef<SVGGElement | null>(null);
  const infraHsrLineRef = useRef<SVGLineElement | null>(null);
  const infraConvLineRef = useRef<SVGLineElement | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia &&
      window.matchMedia("(max-width: 640px)").matches,
  );

  useImperativeHandle(
    ref,
    () => ({
      draw(
        pal: Palette,
        zoomRatio: number,
        hasOrigin: boolean,
        showInfra?: boolean,
      ) {
        const svg = svgRef.current;
        if (!svg) return;
        // Band stop colours come from the same rampColor as the dots
        // (the bands are identical in the light and dark schemes).
        for (let i = 0; i < BAND_STOPS.length; i++) {
          const stop = stopRefs.current[i];
          if (stop)
            stop.setAttribute("stop-color", rampColor(BAND_STOPS[i], pal));
        }
        if (gradGroupRef.current)
          gradGroupRef.current.style.display = hasOrigin ? "" : "none";
        // Same width mapping as the map; the zoom factor is capped for
        // the legend alone so a deep zoom cannot grow the panel without
        // bound. Step i spans [4 + i*stepW, ...] on a shared baseline.
        const ratio = Math.min(zoomRatio, 8);
        let maxH = 0.5;
        for (let i = 0; i < STEPS.length; i++) {
          const h = Math.max(0.5, STEPS[i] * WIDTH_K * ratio);
          if (h > maxH) maxH = h;
          const rect = stepRefs.current[i];
          if (rect) {
            rect.setAttribute("y", String(-h));
            rect.setAttribute("height", String(h));
            // Each step wears its ramp colour, normalised to the
            // legend's own widest step — salmon for the thinnest,
            // deep crimson for the widest. In the dark scheme
            // flowColor is the flat flow colour, as before.
            rect.style.fill = flowColor(STEPS[i], STEPS[STEPS.length - 1], pal);
          }
        }
        const barH = maxH;
        // The stepped bar's baseline sits headH + 15 below the top; the
        // rest of the card hangs off it, so both lower groups translate.
        const headH = hasOrigin ? TIMESEC_H : 8;
        if (widthHeadRef.current)
          widthHeadRef.current.setAttribute("y", String(headH + 2));
        const base = headH + 15 + barH;
        if (widthGroupRef.current)
          widthGroupRef.current.setAttribute(
            "transform",
            "translate(0 " + base + ")",
          );
        const circD = stationR(200) * 2;
        const cbase = base + 24 + 8 + circD;
        if (circleGroupRef.current)
          circleGroupRef.current.setAttribute(
            "transform",
            "translate(0 " + cbase + ")",
          );
        const infraH = showInfra ? 44 : 0;
        if (infraGroupRef.current) {
          infraGroupRef.current.style.display = showInfra ? "" : "none";
          infraGroupRef.current.setAttribute(
            "transform",
            "translate(0 " + (cbase + 24) + ")",
          );
        }
        if (infraHsrLineRef.current)
          infraHsrLineRef.current.setAttribute("stroke", pal.infraHsr);
        if (infraConvLineRef.current)
          infraConvLineRef.current.setAttribute("stroke", pal.infraConv);
        const totalH = Math.round(
          headH + 15 + barH + 14 + 24 + 8 + circD + 14 + infraH,
        );
        svg.setAttribute("viewBox", "0 0 " + W + " " + totalH);
        svg.setAttribute("height", String(totalH));
      },
    }),
    [],
  );

  // Circle samples laid out left to right, each sitting on the shared
  // baseline (the group origin), exactly as the old canvas drew them.
  const circles: { cx: number; r: number; label: string }[] = [];
  {
    let cxp = 4 + 2;
    for (let i = 0; i < SAMPLES.length; i++) {
      const rr = stationR(SAMPLES[i]);
      const ccx = cxp + rr;
      circles.push({ cx: ccx, r: rr, label: String(SAMPLES[i]) });
      cxp = ccx + rr + 18;
    }
  }
  const circD = stationR(200) * 2;
  // Initial geometry at zoom ratio 1 with the band bar shown; the first
  // map draw corrects it (palette + live zoom) before anything is read.
  const initMaxH = Math.max(0.5, 100 * WIDTH_K * 1);
  const initBase = TIMESEC_H + 15 + initMaxH;
  const initCbase = initBase + 24 + 8 + circD;
  const initH = Math.round(TIMESEC_H + 15 + initMaxH + 14 + 24 + 8 + circD + 14);

  return (
    <div id="legend">
      <h2 id="legendTitle">{props.title}</h2>
      <div id="legendBody" className={collapsed ? "collapsed" : undefined}>
        <svg
          id="legendSvg"
          ref={svgRef}
          width={W}
          height={initH}
          viewBox={"0 0 " + W + " " + initH}
          role="img"
          aria-label="Legend: fastest-time bands 0 to 4 hours, 4 to 12 hours and 12 to 24 hours, line width in trains per day, circle size in direct trains per day"
        >
          <defs>
            <linearGradient id="legendRamp" x1="0" y1="0" x2="1" y2="0">
              {BAND_STOPS.map((t, i) => (
                <stop
                  key={t}
                  offset={t / 1440}
                  stopColor={BAND_HEX[i]}
                  ref={(el) => {
                    stopRefs.current[i] = el;
                  }}
                />
              ))}
            </linearGradient>
          </defs>
          {/* Travel-time band bar (hidden until an origin loads): three
              flat blocks — 0–4h green, 4–12h amber, 12–24h purple — with
              the labels inside their blocks and only a slight blend
              where the blocks meet. */}
          <g ref={gradGroupRef}>
            <rect
              x={4}
              y={8}
              width={W - 8}
              height={BAR_H}
              fill="url(#legendRamp)"
              stroke="currentColor"
              strokeOpacity={0.55}
              strokeWidth={0.5}
            />
            {BAND_LABELS.map((b) => (
              <text
                key={b.label}
                x={4 + (b.mid / 1440) * (W - 8)}
                y={8 + BAR_H / 2}
                fontSize={10}
                fontFamily={FONT}
                fill={b.ink}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {b.label}
              </text>
            ))}
          </g>
          {/* Stepped width bar: the group origin is the shared baseline. */}
          <text
            ref={widthHeadRef}
            x={4}
            y={TIMESEC_H + 2}
            fontSize={10.5}
            fontFamily={FONT}
            fill="currentColor"
            dominantBaseline="middle"
          >
            Line width = trains/day
          </text>
          <g ref={widthGroupRef} transform={"translate(0 " + initBase + ")"}>
            {/* The samples, baseline and value labels, as one group. */}
            <g>
              {STEPS.map((s, i) => (
                <rect
                  key={s}
                  x={4 + i * ((W - 8) / STEPS.length)}
                  y={-Math.max(0.5, s * WIDTH_K * 1)}
                  width={(W - 8) / STEPS.length}
                  height={Math.max(0.5, s * WIDTH_K * 1)}
                  className="lg-steps"
                  ref={(el) => {
                    stepRefs.current[i] = el;
                  }}
                />
              ))}
              <rect x={4} y={0} width={W - 8} height={1} fill="currentColor" />
              {STEPS.map((s, i) => (
                <text
                  key={s}
                  x={4 + (i + 0.5) * ((W - 8) / STEPS.length)}
                  y={8}
                  fontSize={10.5}
                  fontFamily={FONT}
                  fill="currentColor"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {s}
                </text>
              ))}
            </g>
          </g>
          {/* Circle-size scale: the group origin is its shared baseline;
              the heading rides inside the group at a fixed offset above
              it (baseline − 8 − largest diameter = the old base + 24). */}
          <g ref={circleGroupRef} transform={"translate(0 " + initCbase + ")"}>
            <text
              x={4}
              y={-(8 + circD)}
              fontSize={10.5}
              fontFamily={FONT}
              fill="currentColor"
              dominantBaseline="middle"
            >
              Circle size = direct trains/day
            </text>
            <rect x={4} y={0} width={W - 8} height={1} fill="currentColor" />
            {circles.map((c) => (
              <g key={c.label}>
                <circle
                  cx={c.cx}
                  cy={-c.r}
                  r={c.r}
                  className="lg-dot"
                  strokeWidth={0.8}
                />
                <text
                  x={c.cx}
                  y={8}
                  fontSize={10.5}
                  fontFamily={FONT}
                  fill="currentColor"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {c.label}
                </text>
              </g>
            ))}
          </g>
          {/* Infrastructure overlay key (shown when Infrastructure is active):
              two colour swatches for high-speed rail (HSR) vs. conventional rail. */}
          <g
            ref={infraGroupRef}
            transform={"translate(0 " + (initCbase + 24) + ")"}
            style={{ display: "none" }}
          >
            <text
              x={4}
              y={0}
              fontSize={10.5}
              fontFamily={FONT}
              fill="currentColor"
              dominantBaseline="middle"
            >
              Infrastructure = track class
            </text>
            <line
              ref={infraHsrLineRef}
              x1={4}
              y1={14}
              x2={24}
              y2={14}
              stroke="#0066cc"
              strokeWidth={2.2}
              strokeLinecap="round"
            />
            <text
              x={30}
              y={14}
              fontSize={10.5}
              fontFamily={FONT}
              fill="currentColor"
              dominantBaseline="middle"
            >
              High-speed rail (HSR)
            </text>
            <line
              ref={infraConvLineRef}
              x1={4}
              y1={28}
              x2={24}
              y2={28}
              stroke="#40231a"
              strokeWidth={2.2}
              strokeLinecap="round"
            />
            <text
              x={30}
              y={28}
              fontSize={10.5}
              fontFamily={FONT}
              fill="currentColor"
              dominantBaseline="middle"
            >
              Conventional rail
            </text>
          </g>
        </svg>
      </div>
      <button
        id="legendToggle"
        type="button"
        aria-expanded={collapsed ? "false" : "true"}
        onClick={() => setCollapsed((c) => !c)}
      >
        {collapsed ? "Show legend" : "Hide legend"}
      </button>
    </div>
  );
});

export default Legend;
