import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Palette } from "../types";
import { NAT_WIDTH_FACTOR, WIDTH_K, flowColor, flowUnits, zoomWidthScale, rampColor, natCityR, stationR, stationZoomK } from "../lib";

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
    showAnim?: boolean,
    stationT?: number,
    damped?: boolean,
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
  // National mode: no travel-time bands (there is no origin), widths on the
  // national factor in steps of 10 / 100 / 300 / 500 trains/day, and circles
  // sized by a city's departures + arrivals.
  national?: boolean;
}

const W = 196; // card content width in CSS px (matches the old canvas)
const STEPS = [1, 10, 50, 100];
// The time bar wears the dots' three bands (see TIME_BANDS in lib.ts):
// gradient stops in minutes — each band flat, with the same ±30-minute
// blend at the 4h / 12h joins — under three labels centred on their
// blocks. BAR_H is tall enough to carry the labels inside the bar.
const BAND_STOPS = [0, 210, 270, 690, 750, 1440];
const BAND_HEX = ["#14746F", "#14746F", "#E3A63F", "#E3A63F", "#34488C", "#34488C"];
const BAND_LABELS: { label: string; mid: number; ink: string }[] = [
  { label: "0–4h", mid: 120, ink: "#ffffff" },
  { label: "4–12h", mid: 480, ink: "#111111" },
  { label: "12–24h", mid: 1080, ink: "#ffffff" },
];
const BAR_H = 15;
const TIMESEC_H = 8 + BAR_H + 6; // vertical room the band section takes
const SAMPLES = [10, 50, 200];
const NAT_STEPS = [10, 100, 300, 500];
const NAT_SAMPLES = [10, 100, 1000];
const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif';

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
  const circleRefs = useRef<(SVGCircleElement | null)[]>([]);
  const circleLabelRefs = useRef<(SVGTextElement | null)[]>([]);
  const circleHeadRef = useRef<SVGTextElement | null>(null);
  const circleGroupRef = useRef<SVGGElement | null>(null);
  const infraGroupRef = useRef<SVGGElement | null>(null);
  const infraHsrLineRef = useRef<SVGLineElement | null>(null);
  const infraConvLineRef = useRef<SVGLineElement | null>(null);
  const animGroupRef = useRef<SVGGElement | null>(null);
  // What the draw handle lays out: the origin legend's scales or the national ones.
  const national = !!props.national;
  const STEPS_NOW = national ? NAT_STEPS : STEPS;
  const SAMPLES_NOW = national ? NAT_SAMPLES : SAMPLES;
  const scaleRef = useRef({ steps: STEPS_NOW, samples: SAMPLES_NOW, k: WIDTH_K, nat: national });
  scaleRef.current = { steps: STEPS_NOW, samples: SAMPLES_NOW, k: national ? WIDTH_K * NAT_WIDTH_FACTOR : WIDTH_K, nat: national };
  const rOf = (n: number) => (scaleRef.current.nat ? natCityR(n) : stationR(n));
  const [collapsed, setCollapsed] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia &&
      window.matchMedia("(max-width: 640px)").matches,
  );

  // Phones start with the legend hidden; also when the window narrows to phone
  // width after load (e.g. a desktop browser switched to a mobile viewport).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 640px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setCollapsed(true);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      draw(
        pal: Palette,
        zoomRatio: number,
        hasOrigin: boolean,
        showInfra?: boolean,
        showAnim?: boolean,
        stationT = 0,
        damped = false,
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
        const capped = Math.min(zoomRatio, 8);
        const ratio = capped * zoomWidthScale(capped, damped);
        const { steps, samples, k } = scaleRef.current;
        let maxH = 0.5;
        for (let i = 0; i < steps.length; i++) {
          const h = Math.max(0.5, flowUnits(steps[i]) * k * ratio);
          if (h > maxH) maxH = h;
          const rect = stepRefs.current[i];
          if (rect) {
            rect.setAttribute("y", String(-h));
            rect.setAttribute("height", String(h));
            // Each step wears its ramp colour, normalised to the
            // legend's own widest step — salmon for the thinnest,
            // deep crimson for the widest. In the dark scheme
            // flowColor is the flat flow colour, as before.
            rect.style.fill = flowColor(steps[i], steps[steps.length - 1], pal);
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
        // Sample dots wear the map's zoom factor, laid out left to right
        // with the same spacing; the largest sets the row height.
        let cxp = 6;
        for (let i = 0; i < samples.length; i++) {
          const r0 = rOf(samples[i]);
          const rr = r0 * stationZoomK(r0, stationT);
          const ccx = cxp + rr;
          circleRefs.current[i]?.setAttribute("cx", String(ccx));
          circleRefs.current[i]?.setAttribute("cy", String(-rr));
          circleRefs.current[i]?.setAttribute("r", String(rr));
          circleLabelRefs.current[i]?.setAttribute("x", String(ccx));
          cxp = ccx + rr + 18;
        }
        const big = samples[samples.length - 1];
        const circD = rOf(big) * stationZoomK(rOf(big), stationT) * 2;
        const cbase = base + 24 + 8 + circD;
        circleHeadRef.current?.setAttribute("y", String(-(8 + circD)));
        if (circleGroupRef.current)
          circleGroupRef.current.setAttribute(
            "transform",
            "translate(0 " + cbase + ")",
          );
        const animH = showAnim ? 48 : 0;
        if (animGroupRef.current) {
          animGroupRef.current.style.display = showAnim ? "" : "none";
          animGroupRef.current.setAttribute(
            "transform",
            "translate(0 " + (cbase + 24) + ")",
          );
        }
        const infraH = showInfra ? 44 : 0;
        const infraBase = cbase + 24 + animH;
        if (infraGroupRef.current) {
          infraGroupRef.current.style.display = showInfra ? "" : "none";
          infraGroupRef.current.setAttribute(
            "transform",
            "translate(0 " + infraBase + ")",
          );
        }
        if (infraHsrLineRef.current)
          infraHsrLineRef.current.setAttribute("stroke", pal.infraHsr);
        if (infraConvLineRef.current)
          infraConvLineRef.current.setAttribute("stroke", pal.infraConv);
        const totalH = Math.round(
          headH + 15 + barH + 14 + 24 + 8 + circD + 14 + animH + infraH,
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
    for (let i = 0; i < SAMPLES_NOW.length; i++) {
      const rr = rOf(SAMPLES_NOW[i]);
      const ccx = cxp + rr;
      circles.push({ cx: ccx, r: rr, label: String(SAMPLES_NOW[i]) });
      cxp = ccx + rr + 18;
    }
  }
  const circD = rOf(SAMPLES_NOW[SAMPLES_NOW.length - 1]) * 2;
  // Initial geometry at zoom ratio 1 with the band bar shown; the first
  // map draw corrects it (palette + live zoom) before anything is read.
  const initMaxH = Math.max(0.5, flowUnits(STEPS_NOW[STEPS_NOW.length - 1]) * scaleRef.current.k * 1);
  const initBase = TIMESEC_H + 15 + initMaxH;
  const initCbase = initBase + 24 + 8 + circD;
  const initH = Math.round(TIMESEC_H + 15 + initMaxH + 14 + 24 + 8 + circD + 14);

  return (
    <div id="legend">
      <div className="lg-head">
        <h2 id="legendTitle">{props.title}</h2>
        <button
          id="legendToggle"
          type="button"
          aria-expanded={collapsed ? "false" : "true"}
          aria-label={collapsed ? "Show legend" : "Hide legend"}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? "Key" : "Hide"}
        </button>
      </div>
      <div id="legendBody" className={collapsed ? "collapsed" : undefined}>
        <svg
          id="legendSvg"
          ref={svgRef}
          width={W}
          height={initH}
          viewBox={"0 0 " + W + " " + initH}
          role="img"
          aria-label={
            national
              ? "Legend: line width in trains per day, circle size in a city's departures plus arrivals per day"
              : "Legend: fastest-time bands 0 to 4 hours, 4 to 12 hours and 12 to 24 hours, line width in trains per day, circle size in direct trains per day"
          }
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
                className="lg-band-label"
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
              {STEPS_NOW.map((s, i) => (
                <rect
                  key={s}
                  x={4 + i * ((W - 8) / STEPS_NOW.length)}
                  y={-Math.max(0.5, flowUnits(s) * scaleRef.current.k * 1)}
                  width={(W - 8) / STEPS_NOW.length}
                  height={Math.max(0.5, flowUnits(s) * scaleRef.current.k * 1)}
                  className="lg-steps"
                  ref={(el) => {
                    stepRefs.current[i] = el;
                  }}
                />
              ))}
              <rect x={4} y={0} width={W - 8} height={1} fill="currentColor" />
              {STEPS_NOW.map((s, i) => (
                <text
                  key={s}
                  x={4 + (i + 0.5) * ((W - 8) / STEPS_NOW.length)}
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
              ref={circleHeadRef}
              x={4}
              y={-(8 + circD)}
              fontSize={10.5}
              fontFamily={FONT}
              fill="currentColor"
              dominantBaseline="middle"
            >
              {national ? "Circle size = departures + arrivals/day" : "Circle size = direct trains/day"}
            </text>
            <rect x={4} y={0} width={W - 8} height={1} fill="currentColor" />
            {circles.map((c, i) => (
              <g key={c.label}>
                <circle
                  ref={(el) => {
                    circleRefs.current[i] = el;
                  }}
                  cx={c.cx}
                  cy={-c.r}
                  r={c.r}
                  className="lg-dot"
                  strokeWidth={0.8}
                />
                <text
                  ref={(el) => {
                    circleLabelRefs.current[i] = el;
                  }}
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
          {/* Animated trains key (shown when Flow Animation is running):
              colour swatches for High-speed (G/D/C) vs. Conventional (K/T/Z/S) */}
          <g
            ref={animGroupRef}
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
              Trains in motion = train class
            </text>
            <g transform="translate(0, 16)">
              <line x1={4} y1={0} x2={16} y2={0} stroke="#F59E0B" strokeWidth={2.5} strokeLinecap="round" opacity={0.65} />
              <circle cx={18} cy={0} r={4.5} fill="#F59E0B" />
              <circle cx={18} cy={0} r={2} fill="#ffffff" />
              <text x={28} y={0} fontSize={10.5} fontFamily={FONT} fill="currentColor" dominantBaseline="middle">
                High-speed (G / D / C)
              </text>
            </g>
            <g transform="translate(0, 32)">
              <line x1={4} y1={0} x2={16} y2={0} stroke="#06B6D4" strokeWidth={2.5} strokeLinecap="round" opacity={0.65} />
              <circle cx={18} cy={0} r={4.5} fill="#06B6D4" />
              <circle cx={18} cy={0} r={2} fill="#ffffff" />
              <text x={28} y={0} fontSize={10.5} fontFamily={FONT} fill="currentColor" dominantBaseline="middle">
                Conventional (K / T / Z / S)
              </text>
            </g>
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
              stroke="#FF6A00"
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
              stroke="#111111"
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
    </div>
  );
});

export default Legend;
