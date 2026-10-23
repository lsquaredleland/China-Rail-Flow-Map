import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  ChordVM,
  CityPointVM,
  DecodedAtlas,
  DecodedOutline,
  DecodedSet,
  DestVM,
  Direction,
  DistUnit,
  FlowVM,
  Hit,
  OriginVM,
  Palette,
  SrcVM,
} from "../types";
import {
  esc,
  flowColor,
  flowWidth,
  palette as makePalette,
  rampColor,
  sourceRowsHtml,
  stationLabel,
  stationR,
  stationRowsHtml,
} from "../lib";
import type { LegendHandle } from "./Legend";

/* Infrastructure overlay: each flow section's track geometry stroked
   once more at this fixed screen-space width, in CSS px — the canvas
   transform scales it by the device pixel ratio like everything else,
   and it never grows with zoom, so the superimposed centreline stays a
   crisp hairline tracing every corridor at any scale. */
const INFRA_WIDTH = 1.25;

/** Camera/tooltip controls the toolbar drives through a ref. */
export interface MapApi {
  fitCountry: () => void;
  fitHome: () => void;
  zoomCenter: (factor: number) => void;
  refreshTooltip: () => void;
  clearStationHover: () => void;
  selectDestByZh: (zh: string) => void;
  panZoomTo: (lon: number, lat: number, scale: number) => void;
}

interface Props {
  atlas: DecodedAtlas | null;
  outline?: DecodedOutline | null;
  showOutline?: boolean;
  connectorMode?: "solid" | "dashed" | "none";
  cur: OriginVM | null;
  direction: Direction;
  dark: boolean;
  showNetwork: boolean;
  showLabels: boolean;
  /** Infrastructure overlay: the proportional flows stay as they are
      and every flow section's track geometry is stroked again on top
      as one uniform thin line in the theme's ink tone. */
  showInfra: boolean;
  distUnit: DistUnit;
  panelDest: CityPointVM | null;
  loadError: string | null;
  /** True while the lazily-fetched inbound map file is still in
      flight: the map shows the standard loading affordance over the
      canvas. */
  inLoading: boolean;
  onSelectDest: (d: CityPointVM | null) => void;
  legendRef: RefObject<LegendHandle | null>;
  children?: ReactNode;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

interface Pt {
  x: number;
  y: number;
}

/* The map itself: a custom Canvas 2D renderer (no tiles, no libraries).
   React owns the surrounding UI state; the camera, hover and pointer
   bookkeeping live in refs, and drawing is imperative — one render()
   pass per frame request, exactly as a hand-rolled canvas map wants. */
const MapCanvas = forwardRef<MapApi, Props>(function MapCanvas(props, apiRef) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const scaleWrapRef = useRef<HTMLDivElement | null>(null);
  const scaleLabelRef = useRef<HTMLDivElement | null>(null);
  const scaleBarRef = useRef<HTMLDivElement | null>(null);
  const [switching, setSwitching] = useState(false);

  // Latest props, readable from the imperative engine below.
  const P = useRef(props);
  P.current = props;

  // Engine state (the vanilla module-level variables, kept in one ref).
  const S = useRef({
    view: { scale: 10, tx: 0, ty: 0 } as View,
    fitScale: 10,
    W: 0,
    H: 0,
    DPR: 1,
    interacted: false,
    hover: null as Hit | null,
    pinned: false,
    pointers: new Map<number, Pt>(),
    dragStart: null as Pt | null,
    moved: 0,
    pinchDist: 0,
    rafPending: false,
    lastTip: null as { hit: Hit; x: number; y: number } | null,
    labelWidthCache: new Map<string, number>(),
    destSecCountsCache: null as {
      cur: OriginVM | null;
      dest: CityPointVM;
      dir: Direction;
      counts: Map<number, number> | null;
    } | null,
  });

  /* ---------- camera helpers ---------- */
  const X = (lon: number) => lon * S.current.view.scale + S.current.view.tx;
  const Y = (lat: number) => -lat * S.current.view.scale + S.current.view.ty;
  const toLon = (px: number) => (px - S.current.view.tx) / S.current.view.scale;
  const toLat = (py: number) => (S.current.view.ty - py) / S.current.view.scale;
  const widthOf = (n: number) =>
    flowWidth(n, S.current.view.scale, S.current.fitScale);

  /* ---------- direction-aware views of the current origin ---------- */
  const points = (): CityPointVM[] => {
    const cur = P.current.cur;
    if (!cur) return [];
    return P.current.direction === "out" ? cur.dests : cur.srcs;
  };
  const flowsList = (): FlowVM[] => {
    const cur = P.current.cur;
    if (!cur) return [];
    return P.current.direction === "out" ? cur.flows : cur.inFlows;
  };
  const flowsSet = (): DecodedSet | null => {
    const atlas = P.current.atlas;
    if (!atlas) return null;
    return P.current.direction === "out" ? atlas.sec : atlas.inSec;
  };

  /* ---------- distance scale bar ----------
     The projection is equirectangular (px = lon/lat degrees x view.scale),
     so the true ground scale at the map centre follows from the centre
     latitude: one degree of longitude there spans (pi/180) * R * cos(lat)
     km on the ground. Pick the largest round distance whose on-screen
     length stays within ~60-140 px and write it straight into the DOM —
     the bar updates on every draw (pan, zoom, resize, origin switch)
     without a React re-render. */
  function updateScaleBar() {
    const wrap = scaleWrapRef.current;
    const label = scaleLabelRef.current;
    const bar = scaleBarRef.current;
    if (!wrap || !label || !bar) return;
    const st = S.current;
    if (!P.current.cur || st.W <= 0 || st.H <= 0) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "";
    const latC = toLat(st.H / 2);
    const kmPerDegLon =
      ((Math.PI / 180) * 6371 * Math.cos((latC * Math.PI) / 180)) || 1;
    const pxPerKm = st.view.scale / kmPerDegLon;
    const unit = P.current.distUnit;
    const steps =
      unit === "km"
        ? [10, 20, 50, 100, 200, 500, 1000]
        : [10, 20, 50, 100, 200, 500];
    const toPx = (d: number) =>
      unit === "km" ? d * pxPerKm : d * 1.609344 * pxPerKm;
    let chosen = steps[0];
    for (let i = 0; i < steps.length; i++) {
      if (toPx(steps[i]) <= 140) chosen = steps[i];
      else break;
    }
    bar.style.width = Math.max(2, Math.round(toPx(chosen))) + "px";
    label.textContent = chosen.toLocaleString("en-US") + " " + unit;
  }

  function fitExtent(
    lon0: number,
    lat0: number,
    lon1: number,
    lat1: number,
    pad: number,
  ) {
    const { W, H, view } = S.current;
    const s = Math.min(W / (lon1 - lon0), H / (lat1 - lat0)) * (pad || 0.97);
    view.scale = s;
    view.tx = (W - (lon0 + lon1) * s) / 2;
    view.ty = (H + (lat0 + lat1) * s) / 2;
  }
  function fitCountryCalc() {
    const atlas = P.current.atlas;
    if (!atlas) return;
    const e = atlas.extent;
    fitExtent(e.lon0, e.lat0, e.lon1, e.lat1, 0.97);
    S.current.fitScale = S.current.view.scale;
  }
  function fitHomeCalc() {
    const cur = P.current.cur;
    if (!cur) return;
    const pt = cur.o.pt;
    fitExtent(pt[0] - 1.7, pt[1] - 1.3, pt[0] + 1.7, pt[1] + 1.3, 0.98);
  }
  function zoomAt(px: number, py: number, factor: number) {
    const st = S.current;
    const ns = Math.min(
      st.fitScale * 60,
      Math.max(st.fitScale * 0.55, st.view.scale * factor),
    );
    const k = ns / st.view.scale;
    st.view.tx = px - (px - st.view.tx) * k;
    st.view.ty = py - (py - st.view.ty) * k;
    st.view.scale = ns;
    st.interacted = true;
    draw();
  }

  /* ---------- drawing ---------- */
  function inViewBB(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    marginDeg: number,
  ): boolean {
    const { W, H } = S.current;
    const m = marginDeg || 0;
    const lonL = toLon(-40) - m,
      lonR = toLon(W + 40) + m;
    const latB = toLat(H + 40) - m,
      latT = toLat(-40) + m;
    return x1 >= lonL && x0 <= lonR && y1 >= latB && y0 <= latT;
  }
  // Append one polyline (flat coords, offset in floats) to the current path,
  // skipping points that land on (nearly) the same pixel as the previous one.
  function traceInto(
    ctx: CanvasRenderingContext2D,
    arr: ArrayLike<number>,
    off: number,
    count: number,
  ) {
    let lx = -1e9,
      ly = -1e9,
      started = false;
    for (let i = 0; i < count; i++) {
      const x = X(arr[off + i * 2]),
        y = Y(arr[off + i * 2 + 1]);
      const dx = x - lx,
        dy = y - ly;
      if (started && dx * dx + dy * dy < 0.42 && i !== count - 1) continue;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
      lx = x;
      ly = y;
    }
  }
  function distKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
    const dx = (lon1 - lon2) * 111.0 * Math.cos(((lat1 + lat2) / 2) * 0.017453292519943295);
    const dy = (lat1 - lat2) * 111.0;
    return Math.hypot(dx, dy);
  }

  function getIntraCityConnector(): {
    netIdx: number;
    subN: number;
    bw0: number;
    col: string;
  } | null {
    const dest = P.current.panelDest;
    const atlas = P.current.atlas;
    const cur = P.current.cur;
    const destSecCounts = getDestSectionCounts();
    if (!dest || !atlas || !cur || !destSecCounts || destSecCounts.size === 0) return null;
    const mode = P.current.connectorMode ?? "solid";
    if (mode === "none") return null;

    const set = flowsSet();
    if (!set) return null;

    const [destLon, destLat] = dest.pt;

    let bestArrLon = 0,
      bestArrLat = 0,
      minTermDist = 1e9;

    for (const [s, count] of destSecCounts.entries()) {
      if (count <= 0) continue;
      const o = set.off[s];
      const l = set.len[s];
      if (l <= 0) continue;
      const x0 = set.pts[o];
      const y0 = set.pts[o + 1];
      const x1 = set.pts[o + (l - 1) * 2];
      const y1 = set.pts[o + (l - 1) * 2 + 1];

      const d0 = distKm(x0, y0, destLon, destLat);
      const d1 = distKm(x1, y1, destLon, destLat);
      if (d0 < minTermDist) {
        minTermDist = d0;
        bestArrLon = x0;
        bestArrLat = y0;
      }
      if (d1 < minTermDist) {
        minTermDist = d1;
        bestArrLon = x1;
        bestArrLat = y1;
      }
    }

    if (minTermDist < 2.5 || minTermDist > 70.0) return null;

    const { pts, off, len } = atlas.net;
    let bestNetIdx = -1;
    let minNetErr = 1e9;

    for (let i = 0; i < len.length; i++) {
      const o = off[i];
      const l = len[i];
      if (l <= 0) continue;
      const nx0 = pts[o];
      const ny0 = pts[o + 1];
      const nx1 = pts[o + (l - 1) * 2];
      const ny1 = pts[o + (l - 1) * 2 + 1];

      const err1 = distKm(nx0, ny0, bestArrLon, bestArrLat) + distKm(nx1, ny1, destLon, destLat);
      const err2 = distKm(nx1, ny1, bestArrLon, bestArrLat) + distKm(nx0, ny0, destLon, destLat);
      const err = Math.min(err1, err2);
      if (err < minNetErr) {
        minNetErr = err;
        bestNetIdx = i;
      }
    }

    if (bestNetIdx >= 0 && minNetErr < 5.0) {
      const subN = (dest as DestVM).trains || (dest as SrcVM).trains || 5;
      const maxN = P.current.direction === "out" ? cur.maxFlow : cur.maxInFlow;
      const pal = makePalette(P.current.dark);
      const bw0 = Math.round(widthOf(subN) * 4) / 4;
      const col = flowColor(subN, maxN, pal);
      return { netIdx: bestNetIdx, subN, bw0, col };
    }

    return null;
  }

  function drawOutline(ctx: CanvasRenderingContext2D, pal: Palette) {
    const outline = P.current.outline;
    if (!outline) return;
    const { rings, lines } = outline;

    // 1. Boundary rings (PRC mainland, Taiwan, Hainan, islands)
    if (rings && rings.len.length > 0) {
      ctx.fillStyle = pal.landFill;
      ctx.strokeStyle = pal.outline;
      ctx.lineWidth = Math.max(0.65, S.current.view.scale * 0.015);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setLineDash([]);
      ctx.beginPath();
      for (let i = 0; i < rings.len.length; i++) {
        if (
          inViewBB(
            rings.bb[i * 4],
            rings.bb[i * 4 + 1],
            rings.bb[i * 4 + 2],
            rings.bb[i * 4 + 3],
            0.2,
          )
        ) {
          traceInto(ctx, rings.pts, rings.off[i], rings.len[i]);
          ctx.closePath();
        }
      }
      ctx.fill();
      ctx.stroke();
    }

    // 2. Nine-dash line in the South China Sea (dashed maritime boundary)
    if (lines && lines.len.length > 0) {
      ctx.strokeStyle = pal.outline;
      const lw = Math.max(1.0, S.current.view.scale * 0.02);
      ctx.lineWidth = lw;
      ctx.lineCap = "butt";
      ctx.setLineDash([Math.max(6, lw * 2.2), Math.max(4, lw * 1.8)]);
      ctx.beginPath();
      for (let i = 0; i < lines.len.length; i++) {
        if (
          inViewBB(
            lines.bb[i * 4],
            lines.bb[i * 4 + 1],
            lines.bb[i * 4 + 2],
            lines.bb[i * 4 + 3],
            0.2,
          )
        ) {
          traceInto(ctx, lines.pts, lines.off[i], lines.len[i]);
        }
      }
      ctx.stroke();
      ctx.lineCap = "round";
      ctx.setLineDash([]);
    }
  }

  function drawGraticule(ctx: CanvasRenderingContext2D, pal: Palette) {
    const { W, H } = S.current;
    ctx.strokeStyle = pal.graticule;
    ctx.lineWidth = 0.5;
    const lonL = Math.floor(toLon(0) / 5) * 5,
      lonR = toLon(W);
    const latB = Math.floor(toLat(H) / 5) * 5,
      latT = toLat(0);
    ctx.beginPath();
    for (let lon = lonL; lon <= lonR; lon += 5) {
      ctx.moveTo(X(lon), 0);
      ctx.lineTo(X(lon), H);
    }
    for (let lat = latB; lat <= latT; lat += 5) {
      ctx.moveTo(0, Y(lat));
      ctx.lineTo(W, Y(lat));
    }
    ctx.stroke();
  }
  function drawNetwork(ctx: CanvasRenderingContext2D, pal: Palette) {
    const atlas = P.current.atlas;
    if (!atlas) return;
    const { pts, off, len, bb } = atlas.net;
    ctx.strokeStyle = pal.network;
    ctx.lineWidth = Math.max(0.45, S.current.view.scale * 0.016);

    const isFerry = (i: number) =>
      bb[i * 4 + 1] < 20.15 &&
      bb[i * 4 + 3] > 20.20 &&
      bb[i * 4] > 110.0 &&
      bb[i * 4 + 2] < 110.3;

    // Solid track network
    ctx.setLineDash([]);
    ctx.beginPath();
    for (let i = 0; i < len.length; i++) {
      if (isFerry(i)) continue;
      if (inViewBB(bb[i * 4], bb[i * 4 + 1], bb[i * 4 + 2], bb[i * 4 + 3], 0.3)) {
        traceInto(ctx, pts, off[i], len[i]);
      }
    }
    ctx.stroke();

    // Dashed ferry crossing line across Qiongzhou strait (maritime water blue)
    const netW = Math.max(0.65, S.current.view.scale * 0.02);
    ctx.strokeStyle = P.current.dark ? "#38BDF8" : "#0284C7";
    ctx.lineWidth = netW;
    ctx.lineCap = "butt";
    ctx.setLineDash([Math.max(8, netW * 2.5), Math.max(6, netW * 2.0)]);
    ctx.beginPath();
    for (let i = 0; i < len.length; i++) {
      if (!isFerry(i)) continue;
      if (inViewBB(bb[i * 4], bb[i * 4 + 1], bb[i * 4 + 2], bb[i * 4 + 3], 0.3)) {
        traceInto(ctx, pts, off[i], len[i]);
      }
    }
    ctx.stroke();
    ctx.lineCap = "round";
    ctx.setLineDash([]);
  }
  /* ---------- exact per-train section counts for a selected station ---------- */
  function getDestSectionCounts(): Map<number, number> | null {
    const dest = P.current.panelDest;
    const cur = P.current.cur;
    if (!dest || !cur) return null;
    const st = S.current;
    if (
      st.destSecCountsCache &&
      st.destSecCountsCache.cur === cur &&
      st.destSecCountsCache.dest === dest &&
      st.destSecCountsCache.dir === P.current.direction
    ) {
      return st.destSecCountsCache.counts;
    }

    if (P.current.direction === "out") {
      if (cur.o.dep_secs && cur.o.dep_secs.length > 0) {
        const d = dest as DestVM;
        const secCounts = new Map<number, number>();
        const calls = d.calls || [];
        for (let i = 0; i < calls.length; i++) {
          const c = calls[i];
          if (!c.dep || !c.dep.secs) continue;
          const secs = c.dep.secs;
          const lim = Math.min(secs.length, c.secCnt);
          for (let k = 0; k < lim; k++) {
            secCounts.set(secs[k], (secCounts.get(secs[k]) || 0) + 1);
          }
        }
        st.destSecCountsCache = { cur, dest, dir: "out", counts: secCounts };
        return secCounts;
      }
    } else {
      if (cur.o.arr_secs && cur.o.arr_secs.length > 0) {
        const s = dest as SrcVM;
        const secCounts = new Map<number, number>();
        const inCalls = s.inCalls || [];
        for (let i = 0; i < inCalls.length; i++) {
          const c = inCalls[i];
          if (!c.arr || !c.arr.secs) continue;
          const secs = c.arr.secs;
          const lim = Math.min(secs.length, c.secCnt);
          for (let k = 0; k < lim; k++) {
            secCounts.set(secs[k], (secCounts.get(secs[k]) || 0) + 1);
          }
        }
        st.destSecCountsCache = { cur, dest, dir: "in", counts: secCounts };
        return secCounts;
      }
    }
    st.destSecCountsCache = { cur, dest, dir: P.current.direction, counts: null };
    return null;
  }

  // Flow sections batched into one stroke per (width, colour) bucket
  // (0.25 px width steps). When a station is selected (`destSecCounts`),
  // Pass 1 draws all origin flows faded at full trunk width, and Pass 2
  // draws the exact city-pair flow on top at its exact train count.
  function drawFlows(
    ctx: CanvasRenderingContext2D,
    pal: Palette,
    destSecCounts: Map<number, number> | null,
  ) {
    const atlas = P.current.atlas;
    const cur = P.current.cur;
    const set = flowsSet();
    if (!atlas || !cur || !set) return;
    const { pts, off, len, bb } = set;
    const flows = flowsList();
    const maxN = P.current.direction === "out" ? cur.maxFlow : cur.maxInFlow;

    const isFerry = (s: number) =>
      bb[s * 4 + 1] < 20.15 &&
      bb[s * 4 + 3] > 20.20 &&
      bb[s * 4] > 110.0 &&
      bb[s * 4 + 2] < 110.3;

    function strokeFlowList(items: { s: number; n: number }[], alpha: number) {
      ctx.globalAlpha = alpha;
      let curW = -1,
        curCol = "",
        curDash = false,
        open = false;
      for (let i = 0; i < items.length; i++) {
        const f = items[i];
        if (
          !inViewBB(
            bb[f.s * 4],
            bb[f.s * 4 + 1],
            bb[f.s * 4 + 2],
            bb[f.s * 4 + 3],
            0.35,
          )
        )
          continue;
        const bw0 = Math.round(widthOf(f.n) * 4) / 4;
        const ferry = isFerry(f.s);
        // Water crossing blue: luminous azure in dark mode, vibrant ocean blue in light mode
        const col = ferry
          ? P.current.dark
            ? "#38BDF8"
            : "#0284C7"
          : flowColor(f.n, maxN, pal);
        if (bw0 !== curW || col !== curCol || ferry !== curDash) {
          if (open) ctx.stroke();
          ctx.beginPath();
          ctx.lineWidth = bw0;
          ctx.strokeStyle = col;
          if (ferry) {
            // Use butt cap and scale dash/gap with stroke width so dashes never merge at high zoom
            ctx.lineCap = "butt";
            const dashLen = Math.max(12, bw0 * 2.5);
            const gapLen = Math.max(9, bw0 * 1.8);
            ctx.setLineDash([dashLen, gapLen]);
          } else {
            ctx.lineCap = "round";
            ctx.setLineDash([]);
          }
          curW = bw0;
          curCol = col;
          curDash = ferry;
          open = true;
        }
        traceInto(ctx, pts, off[f.s], len[f.s]);
      }
      if (open) ctx.stroke();
      ctx.lineCap = "round";
      ctx.setLineDash([]);
    }

    if (destSecCounts) {
      // Pass 1: faded background of ALL flows at full origin width f.n
      strokeFlowList(flows, P.current.dark ? 0.16 : 0.18);
      // Pass 2: exact city-pair flow on top at widthOf(subN) and flowColor(subN, maxN, pal)
      if (destSecCounts.size > 0) {
        const subFlows: { s: number; n: number }[] = [];
        for (let i = 0; i < flows.length; i++) {
          const f = flows[i];
          const subN = destSecCounts.get(f.s) || 0;
          if (subN > 0) {
            subFlows.push({ s: f.s, n: subN });
          }
        }
        subFlows.sort((a, b) => b.n - a.n);
        strokeFlowList(subFlows, 1.0);

        // Intra-city track connector (bridges gap to metropolitan city marker)
        const conn = getIntraCityConnector();
        if (conn) {
          const mode = P.current.connectorMode ?? "solid";
          ctx.beginPath();
          if (mode === "dashed") {
            ctx.lineWidth = Math.max(1.8, conn.bw0 * 0.75);
            ctx.strokeStyle = conn.col;
            ctx.lineCap = "butt";
            ctx.setLineDash([8, 6]);
          } else {
            ctx.lineWidth = conn.bw0;
            ctx.strokeStyle = conn.col;
            ctx.lineCap = "round";
            ctx.setLineDash([]);
          }
          traceInto(
            ctx,
            atlas.net.pts,
            atlas.net.off[conn.netIdx],
            atlas.net.len[conn.netIdx],
          );
          ctx.stroke();
          ctx.lineCap = "round";
          ctx.setLineDash([]);
        }
      }
      ctx.globalAlpha = 1.0;
    } else {
      strokeFlowList(flows, 1.0);
    }
  }

  // Infrastructure overlay: uniform hairline in two colours (conventional
  // rail first, then high-speed rail on top), superimposed on the flow
  // mass.
  function drawInfra(
    ctx: CanvasRenderingContext2D,
    pal: Palette,
    destSecCounts: Map<number, number> | null,
  ) {
    const atlas = P.current.atlas;
    const cur = P.current.cur;
    const set = flowsSet();
    if (!atlas || !cur || !set) return;
    const { pts, off, len, bb, hsr } = set;
    const flows = flowsList();
    ctx.lineWidth = INFRA_WIDTH;
    ctx.setLineDash([]);

    function infraPass(wantConnected: boolean | null, alpha: number) {
      ctx.globalAlpha = alpha;
      const isFerry = (s: number) =>
        bb[s * 4 + 1] < 20.15 &&
        bb[s * 4 + 3] > 20.20 &&
        bb[s * 4] > 110.0 &&
        bb[s * 4 + 2] < 110.3;

      for (let pass = 0; pass < 2; pass++) {
        const wantHsr = pass === 1 ? 1 : 0;
        ctx.strokeStyle = pass === 1 ? pal.infraHsr : pal.infraConv;
        let any = false;
        ctx.beginPath();
        for (let i = 0; i < flows.length; i++) {
          const f = flows[i];
          if (
            wantConnected !== null &&
            (destSecCounts ? destSecCounts.has(f.s) : false) !== wantConnected
          )
            continue;
          if ((hsr[f.s] ? 1 : 0) !== wantHsr) continue;
          if (pass === 0 && isFerry(f.s)) continue;
          if (
            !inViewBB(
              bb[f.s * 4],
              bb[f.s * 4 + 1],
              bb[f.s * 4 + 2],
              bb[f.s * 4 + 3],
              0.35,
            )
          )
            continue;
          traceInto(ctx, pts, off[f.s], len[f.s]);
          any = true;
        }
        if (any) ctx.stroke();

        // Depict train ferry crossing with a maritime dashed line in water blue
        if (pass === 0) {
          ctx.beginPath();
          ctx.lineCap = "butt";
          ctx.strokeStyle = P.current.dark ? "#38BDF8" : "#0284C7";
          ctx.setLineDash([7, 6]);
          let anyFerry = false;
          for (let i = 0; i < flows.length; i++) {
            const f = flows[i];
            if (
              wantConnected !== null &&
              (destSecCounts ? destSecCounts.has(f.s) : false) !== wantConnected
            )
              continue;
            if (!isFerry(f.s)) continue;
            if (
              !inViewBB(
                bb[f.s * 4],
                bb[f.s * 4 + 1],
                bb[f.s * 4 + 2],
                bb[f.s * 4 + 3],
                0.35,
              )
            )
              continue;
            traceInto(ctx, pts, off[f.s], len[f.s]);
            anyFerry = true;
          }
          if (anyFerry) ctx.stroke();
          ctx.lineCap = "round";
          ctx.setLineDash([]);
        }
      }
    }

    if (destSecCounts) {
      infraPass(false, P.current.dark ? 0.18 : 0.2);
      if (destSecCounts.size > 0) infraPass(true, 1.0);
      ctx.globalAlpha = 1.0;
    } else {
      infraPass(null, 1.0);
    }
  }
  function drawChords(
    ctx: CanvasRenderingContext2D,
    pal: Palette,
    highlight: ChordVM | null,
    hasSelectedDest: boolean,
  ) {
    const cur = P.current.cur;
    if (!cur) return;
    if (hasSelectedDest) ctx.globalAlpha = P.current.dark ? 0.16 : 0.18;
    for (let i = 0; i < cur.chords.length; i++) {
      const ch = cur.chords[i];
      if (highlight === ch) continue;
      if (!inViewBB(ch.bb.x0, ch.bb.y0, ch.bb.x1, ch.bb.y1, 0.35)) continue;
      const w = widthOf(ch.n);
      ctx.lineWidth = w;
      ctx.strokeStyle = pal.chord;
      ctx.setLineDash([Math.max(3, w * 1.1), Math.max(2.5, w * 0.8)]);
      ctx.beginPath();
      traceInto(ctx, ch.flat, 0, ch.count);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
    ctx.setLineDash([]);
    if (highlight) {
      const hw = widthOf(highlight.n) + 1.6;
      ctx.lineWidth = hw;
      ctx.strokeStyle = pal.flowHi;
      ctx.setLineDash([Math.max(3, hw * 1.1), Math.max(2.5, hw * 0.8)]);
      ctx.beginPath();
      traceInto(ctx, highlight.flat, 0, highlight.count);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  function drawHighlightSeg(
    ctx: CanvasRenderingContext2D,
    pal: Palette,
    sIdx: number,
    n: number,
  ) {
    const set = flowsSet();
    if (!set) return;
    const isFerry =
      set.bb[sIdx * 4 + 1] < 20.15 &&
      set.bb[sIdx * 4 + 3] > 20.20 &&
      set.bb[sIdx * 4] > 110.0 &&
      set.bb[sIdx * 4 + 2] < 110.3;
    const hw = widthOf(n) + 1.6;
    ctx.lineWidth = hw;
    ctx.strokeStyle = isFerry
      ? P.current.dark
        ? "#7DD3FC"
        : "#0284C7"
      : pal.flowHi;
    if (isFerry) {
      ctx.lineCap = "butt";
      ctx.setLineDash([Math.max(12, hw * 2.5), Math.max(9, hw * 1.8)]);
    } else {
      ctx.lineCap = "round";
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    traceInto(ctx, set.pts, set.off[sIdx], set.len[sIdx]);
    ctx.stroke();
    ctx.lineCap = "round";
    ctx.setLineDash([]);
  }
  function drawStations(ctx: CanvasRenderingContext2D, pal: Palette) {
    const cur = P.current.cur;
    if (!cur) return;
    const { W, H, hover } = S.current;
    const pts = points();

    function drawDot(c: CityPointVM) {
      if (
        c.pt[0] < toLon(-30) ||
        c.pt[0] > toLon(W + 30) ||
        c.pt[1] < toLat(H + 30) ||
        c.pt[1] > toLat(-30)
      )
        return;
      const x = X(c.pt[0]),
        y = Y(c.pt[1]),
        r = stationR(c.trains);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 6.2832);
      // Dot colour is the fastest-time band — always on, no toggle.
      ctx.fillStyle =
        typeof c.fastest === "number" ? rampColor(c.fastest, pal) : pal.dot;
      ctx.fill();
      ctx.lineWidth = P.current.dark ? 3.0 : 1.5;
      ctx.strokeStyle = pal.dotEdge;
      ctx.stroke();
    }

    const pd = P.current.panelDest;
    const hoveredIdx =
      hover && hover.kind === "station" ? hover.station.idx : -1;

    if (pd) {
      // Dim non-selected, non-hovered city circles
      ctx.globalAlpha = P.current.dark ? 0.16 : 0.18;
      for (let i = 0; i < pts.length; i++) {
        const c = pts[i];
        if (c.idx !== pd.idx && c.idx !== hoveredIdx) {
          drawDot(c);
        }
      }
      // Draw selected and hovered station circles at full opacity on top
      ctx.globalAlpha = 1.0;
      let drawnPd = false;
      for (let i = 0; i < pts.length; i++) {
        const c = pts[i];
        if (c.idx === pd.idx) drawnPd = true;
        if (c.idx === pd.idx || c.idx === hoveredIdx) {
          drawDot(c);
        }
      }
      if (!drawnPd) drawDot(pd);
    } else {
      ctx.globalAlpha = 1.0;
      for (let i = 0; i < pts.length; i++) {
        drawDot(pts[i]);
      }
    }

    ctx.globalAlpha = 1.0;

    // The origin: solid black disc with white diamond in day mode,
    // or solid paper-white disc with night diamond in night mode.
    const cx = X(cur.o.pt[0]),
      cy = Y(cur.o.pt[1]);
    if (!P.current.dark) {
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, 6.2832);
      ctx.fillStyle = "#111111";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#ffffff";
      const s = 4.4;
      ctx.beginPath();
      ctx.rect(-s / 2, -s / 2, s, s);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, 6.2832);
      ctx.fillStyle = "#EDEDEA";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#1A1B1E";
      ctx.stroke();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#1A1B1E";
      const s = 4.4;
      ctx.beginPath();
      ctx.rect(-s / 2, -s / 2, s, s);
      ctx.fill();
      ctx.restore();
    }

    if (P.current.panelDest) {
      const pd = P.current.panelDest;
      ctx.beginPath();
      ctx.arc(X(pd.pt[0]), Y(pd.pt[1]), stationR(pd.trains) + 3.8, 0, 6.2832);
      ctx.strokeStyle = P.current.dark ? "#EDEDEA" : "#111111";
      ctx.lineWidth = 3.0;
      ctx.stroke();
    }
    if (hover && hover.kind === "station") {
      const hc = hover.station;
      ctx.beginPath();
      ctx.arc(X(hc.pt[0]), Y(hc.pt[1]), stationR(hc.trains) + 3.5, 0, 6.2832);
      ctx.strokeStyle = P.current.dark ? "#EDEDEA" : "#111111";
      ctx.lineWidth = 2.0;
      ctx.stroke();
    } else if (hover && hover.kind === "origin") {
      ctx.beginPath();
      ctx.arc(cx, cy, 14.5, 0, 6.2832);
      ctx.strokeStyle = P.current.dark ? "#EDEDEA" : "#111111";
      ctx.lineWidth = 2.0;
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
  }

  /* ---------- labels with collision care ----------
     Labels are off by default; the origin's own name is always drawn.
     When labels are on, the candidate set stays sparse: at the national
     view only the top ~22 destinations by trains/day, plus every
     substantial route terminus (5+ trains ending there) — and the
     collision pass, not the candidate list, decides which of those
     actually appear, so the result is never a wall of names. Zooming
     in admits progressively smaller cities; every candidate still has
     to win a collision-free spot, and unplaced termini get smaller /
     stepped-out last tries. */
  function drawLabels(ctx: CanvasRenderingContext2D, pal: Palette) {
    const cur = P.current.cur;
    if (!cur) return;
    const { W, H, view, fitScale, labelWidthCache } = S.current;
    const showDest = P.current.showLabels;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    ctx.textBaseline = "middle";
    function hits(box: { x: number; y: number; w: number; h: number }) {
      for (let i = 0; i < placed.length; i++) {
        const p = placed[i];
        if (
          box.x < p.x + p.w &&
          box.x + box.w > p.x &&
          box.y < p.y + p.h &&
          box.y + box.h > p.y
        )
          return true;
      }
      return false;
    }
    interface LabelStyle {
      fs: number;
      weight: string;
      pad: number;
      off: number;
      far?: boolean;
      isBoxed?: boolean;
    }
    function place(
      c: { zh: string; en: string; pt: [number, number] },
      style: LabelStyle,
    ): boolean {
      const x = X(c.pt[0]),
        y = Y(c.pt[1]);
      if (x < -90 || x > W + 90 || y < -30 || y > H + 30) return false;
      const text = c.en + " · " + c.zh;
      const fs = style.fs;
      ctx.font =
        style.weight +
        " " +
        fs +
        "px Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans SC', sans-serif";
      const cacheKey = text + "|" + fs + "|" + style.weight;
      let tw = labelWidthCache.get(cacheKey);
      if (tw === undefined) {
        tw = ctx.measureText(text).width;
        labelWidthCache.set(cacheKey, tw);
      }
      const r = style.off;
      const dyD = r + fs * 0.72;
      let offs: { dx: number; dy: number; align: CanvasTextAlign }[];
      if (style.far) {
        // Last-resort ring: labels for termini whose dot is a few pixels
        // from a big neighbour's dot (Hong Kong beside Shenzhen) — the
        // label steps ~30 px out into open space, still collision-checked.
        const R = 30;
        offs = [
          { dx: R * 0.75, dy: R * 0.75, align: "left" },
          { dx: R * 0.75, dy: -R * 0.75, align: "left" },
          { dx: -R * 0.75, dy: R * 0.75, align: "right" },
          { dx: -R * 0.75, dy: -R * 0.75, align: "right" },
          { dx: R, dy: 0, align: "left" },
          { dx: -R, dy: 0, align: "right" },
          { dx: 0, dy: R, align: "center" },
          { dx: 0, dy: -R, align: "center" },
        ];
      } else {
        offs = [
          { dx: r + 4, dy: 0, align: "left" },
          { dx: -(r + 4), dy: 0, align: "right" },
          { dx: 0, dy: -(r + fs * 0.75), align: "center" },
          { dx: 0, dy: r + fs * 0.75, align: "center" },
          { dx: r + 3, dy: dyD, align: "left" },
          { dx: r + 3, dy: -dyD, align: "left" },
          { dx: -(r + 3), dy: dyD, align: "right" },
          { dx: -(r + 3), dy: -dyD, align: "right" },
        ];
      }
      for (let i = 0; i < offs.length; i++) {
        const o = offs[i];
        const bx =
          o.align === "left"
            ? x + o.dx
            : o.align === "right"
              ? x + o.dx - tw
              : x + o.dx - tw / 2;
        const box = {
          x: bx - 1.5 - style.pad,
          y: y + o.dy - fs * 0.62 - style.pad * 0.4,
          w: tw + 3 + style.pad * 2,
          h: fs * 1.24 + style.pad * 0.8,
        };
        if (box.x < 2 || box.x + box.w > W - 2) continue;
        if (hits(box)) continue;
        placed.push(box);
        if (style.isBoxed && !P.current.dark) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(box.x, box.y, box.w, box.h);
          ctx.strokeStyle = "#111111";
          ctx.lineWidth = 1;
          ctx.strokeRect(box.x, box.y, box.w, box.h);
          ctx.fillStyle = "#111111";
        } else if (style.isBoxed && P.current.dark) {
          ctx.fillStyle = "#1A1B1E";
          ctx.fillRect(box.x, box.y, box.w, box.h);
          ctx.strokeStyle = "#EDEDEA";
          ctx.lineWidth = 1;
          ctx.strokeRect(box.x, box.y, box.w, box.h);
          ctx.fillStyle = "#EDEDEA";
        } else {
          ctx.fillStyle = pal.labelHalo;
          ctx.fillRect(box.x, box.y, box.w, box.h);
          ctx.fillStyle = pal.label;
        }
        ctx.textAlign = o.align;
        ctx.fillText(text, x + o.dx, y + o.dy);
        return true;
      }
      return false;
    }
    // The origin first, so its label always wins a spot — and it is the
    // only label drawn while destination labels are toggled off.
    place(
      { zh: cur.o.zh, en: cur.en, pt: cur.o.pt },
      { fs: 13, weight: "700", pad: 5, off: 13, isBoxed: true },
    );
    if (P.current.panelDest) {
      const pd = P.current.panelDest;
      place(
        { zh: pd.zh, en: pd.en, pt: pd.pt },
        { fs: 12.5, weight: "700", pad: 5, off: stationR(pd.trains) + 5, isBoxed: true },
      );
    }
    if (!showDest) return;
    // Candidate set by zoom (points are already sorted by trains/day).
    // "Termini" here are route ends in the current direction: trains
    // ending at the city outbound, starting there inbound.
    const all = points();
    const ratio = view.scale / fitScale;
    const cands: CityPointVM[] = [];
    let j: number;
    let c: CityPointVM;
    if (ratio < 2) {
      for (j = 0; j < all.length && cands.length < 22; j++)
        cands.push(all[j]);
      // Every substantial terminus joins the candidates, however far
      // down the trains list it sits — whether it is actually drawn is
      // decided by the collision pass, not by a candidate cap, so a
      // terminus in open country (Beijing) is never crowded out by
      // candidates that were only ever going to collide near the origin.
      for (j = 0; j < all.length; j++) {
        c = all[j];
        if (c.endpoint >= 5 && cands.indexOf(c) === -1) cands.push(c);
      }
    } else if (ratio < 5) {
      for (j = 0; j < all.length; j++) {
        c = all[j];
        if (c.trains >= 15 || (c.endpoint >= 1 && c.trains >= 6))
          cands.push(c);
      }
    } else if (ratio < 14) {
      for (j = 0; j < all.length; j++) {
        c = all[j];
        if (c.trains >= 5 || (c.endpoint >= 1 && c.trains >= 3))
          cands.push(c);
      }
    } else {
      cands.push(...all);
    }
    // Within a size tier, termini go first, and the most squeezed
    // terminus of the tier goes before its neighbours (Hong Kong's dot
    // sits ~5 px from Shenzhen's at national scale).
    function tier(c2: CityPointVM) {
      return c2.trains >= 50 ? 0 : c2.trains >= 20 ? 1 : 2;
    }
    cands.sort((a, b) => {
      const ta = tier(a),
        tb = tier(b);
      if (ta !== tb) return ta - tb;
      const ea = a.endpoint >= 1 ? 0 : 1,
        eb = b.endpoint >= 1 ? 0 : 1;
      if (ea !== eb) return ea - eb;
      if (ea === 0 && a.nn !== b.nn) return a.nn - b.nn;
      return b.trains - a.trains;
    });
    const unplacedTermini: CityPointVM[] = [];
    for (let k = 0; k < cands.length; k++) {
      const t = cands[k];
      let ok: boolean;
      if (t.trains >= 50)
        ok = place(t, { fs: 14, weight: "700", pad: 4, off: stationR(t.trains) + 2 });
      else if (t.trains >= 20)
        ok = place(t, { fs: 12, weight: "600", pad: 2.5, off: stationR(t.trains) + 2 });
      else if (t.trains >= 5)
        ok = place(t, { fs: 11, weight: "600", pad: 2, off: stationR(t.trains) + 2 });
      else ok = place(t, { fs: 11, weight: "", pad: 2, off: stationR(t.trains) + 2 });
      if (!ok && t.endpoint >= 1) unplacedTermini.push(t);
    }
    // Candidates that lost every spot at full size and end routes get
    // two last tries a touch smaller, the second stepped ~30 px out
    // into open space — a terminus label matters more than its size.
    for (let k = 0; k < unplacedTermini.length; k++) {
      const u = unplacedTermini[k];
      if (
        !place(u, { fs: 10.5, weight: "600", pad: 1.2, off: stationR(u.trains) + 1.5 })
      ) {
        place(u, {
          fs: 10.5,
          weight: "600",
          pad: 1.2,
          off: stationR(u.trains) + 1.5,
          far: true,
        });
      }
    }
  }

  function draw() {
    const atlas = P.current.atlas;
    const cur = P.current.cur;
    const canvas = canvasRef.current;
    if (!atlas || !cur || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const st = S.current;
    const pal = makePalette(P.current.dark);
    ctx.setTransform(st.DPR, 0, 0, st.DPR, 0, 0);
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, st.W, st.H);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (P.current.showOutline) drawOutline(ctx, pal);
    drawGraticule(ctx, pal);
    if (P.current.showNetwork) drawNetwork(ctx, pal);
    const destSecCounts = getDestSectionCounts();
    // Chords are drawn UNDER the routed flows: a dashed leg shows only
    // where a gap in the flow coverage lets it peek out, and is hidden
    // beneath the flows where lines bunch up around a busy origin.
    // There is no inbound chord data: dashed legs exist outbound only.
    if (P.current.direction === "out")
      drawChords(
        ctx,
        pal,
        st.hover && st.hover.kind === "chord" ? st.hover.chord : null,
        !!P.current.panelDest,
      );
    drawFlows(ctx, pal, destSecCounts);
    // The Infrastructure overlay is superimposed on the flows (below
    // the hover highlight, dots and labels).
    if (P.current.showInfra) drawInfra(ctx, pal, destSecCounts);
    if (st.hover && st.hover.kind === "seg")
      drawHighlightSeg(
        ctx,
        pal,
        st.hover.s,
        st.hover.subN !== undefined ? st.hover.subN : st.hover.n,
      );
    drawStations(ctx, pal);
    drawLabels(ctx, pal);
    if (P.current.legendRef.current)
      P.current.legendRef.current.draw(
        pal,
        st.view.scale / st.fitScale,
        true,
        P.current.showInfra,
      );
    updateScaleBar();
  }

  function resize() {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const st = S.current;
    const r = wrap.getBoundingClientRect();
    const newW = Math.max(50, r.width);
    const newH = Math.max(50, r.height);
    // When the user has taken the camera, keep the same geographic
    // centre at the same zoom across the resize (fold / unfold,
    // rotation): remember the centre in lon/lat before the size
    // changes, then re-anchor the translation on it afterwards.
    const keepCentre =
      st.interacted && st.W > 0 && st.H > 0 && P.current.cur
        ? { lon: toLon(st.W / 2), lat: toLat(st.H / 2) }
        : null;
    // Device-pixel-ratio-aware backing store, capped at 3 — foldables
    // and flagship phones run ~3x, and a 2x cap leaves strokes soft.
    st.DPR = Math.min(3, window.devicePixelRatio || 1);
    st.W = newW;
    st.H = newH;
    canvas.width = Math.round(st.W * st.DPR);
    canvas.height = Math.round(st.H * st.DPR);
    if (P.current.atlas && P.current.cur) {
      if (!st.interacted) fitCountryCalc();
      else if (keepCentre) {
        st.view.tx = st.W / 2 - keepCentre.lon * st.view.scale;
        st.view.ty = st.H / 2 + keepCentre.lat * st.view.scale;
      }
    }
    draw();
  }

  function scheduleDraw() {
    const st = S.current;
    if (st.rafPending) return;
    st.rafPending = true;
    requestAnimationFrame(() => {
      st.rafPending = false;
      draw();
    });
  }

  /* ---------- hit testing & tooltip ---------- */
  function distToSeg(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): number {
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const ex = ax + t * dx - px,
      ey = ay + t * dy - py;
    return Math.sqrt(ex * ex + ey * ey);
  }
  function pickStation(px: number, py: number): Hit | null {
    const cur = P.current.cur;
    if (!cur) return null;
    const { W, H } = S.current;
    const pts = points();
    let best: CityPointVM | null = null;
    let bestD2 = 14 * 14;
    for (let i = 0; i < pts.length; i++) {
      const c = pts[i];
      const x = X(c.pt[0]),
        y = Y(c.pt[1]);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      const dx = px - x,
        dy = py - y,
        d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        best = c;
        bestD2 = d2;
      }
    }
    const cx = X(cur.o.pt[0]),
      cy = Y(cur.o.pt[1]);
    const odx = px - cx,
      ody = py - cy,
      od2 = odx * odx + ody * ody;
    if (od2 <= 15 * 15 && (best === null || od2 <= bestD2))
      return { kind: "origin" };
    return best ? { kind: "station", station: best } : null;
  }
  function pickSegment(px: number, py: number): Hit | null {
    const atlas = P.current.atlas;
    const cur = P.current.cur;
    const set = flowsSet();
    if (!atlas || !cur || !set) return null;
    const sec = set;
    const flows = flowsList();
    const lon = toLon(px),
      lat = toLat(py);
    const thrDeg = 12 / S.current.view.scale;
    let segBest: FlowVM | null = null;
    let bestDist = 10;
    let i: number, k: number;
    for (i = 0; i < flows.length; i++) {
      const f = flows[i];
      const s = f.s;
      if (
        lon < sec.bb[s * 4] - thrDeg ||
        lon > sec.bb[s * 4 + 2] + thrDeg ||
        lat < sec.bb[s * 4 + 1] - thrDeg ||
        lat > sec.bb[s * 4 + 3] + thrDeg
      )
        continue;
      const off = sec.off[s],
        cnt = sec.len[s];
      for (k = 0; k + 1 < cnt; k++) {
        const d = distToSeg(
          px,
          py,
          X(sec.pts[off + k * 2]),
          Y(sec.pts[off + k * 2 + 1]),
          X(sec.pts[off + k * 2 + 2]),
          Y(sec.pts[off + k * 2 + 3]),
        );
        if (
          d < bestDist - 0.75 ||
          (d <= bestDist + 0.75 && segBest && f.n > segBest.n)
        ) {
          if (d < bestDist || (segBest && f.n > segBest.n)) {
            segBest = f;
            bestDist = Math.min(d, bestDist);
          }
        }
      }
    }
    if (segBest) {
      const destSecCounts = getDestSectionCounts();
      const subN =
        destSecCounts && destSecCounts.has(segBest.s)
          ? destSecCounts.get(segBest.s)
          : undefined;
      return { kind: "seg", s: segBest.s, n: segBest.n, subN };
    }
    if (P.current.direction !== "out") return null;
    let chordBest: ChordVM | null = null;
    for (i = 0; i < cur.chords.length; i++) {
      const ch = cur.chords[i];
      if (
        lon < ch.bb.x0 - thrDeg ||
        lon > ch.bb.x1 + thrDeg ||
        lat < ch.bb.y0 - thrDeg ||
        lat > ch.bb.y1 + thrDeg
      )
        continue;
      for (k = 0; k + 1 < ch.count; k++) {
        const dd = distToSeg(
          px,
          py,
          X(ch.flat[k * 2]),
          Y(ch.flat[k * 2 + 1]),
          X(ch.flat[k * 2 + 2]),
          Y(ch.flat[k * 2 + 3]),
        );
        if (dd < bestDist) {
          chordBest = ch;
          bestDist = dd;
        }
      }
    }
    return chordBest ? { kind: "chord", chord: chordBest } : null;
  }
  function pick(px: number, py: number): Hit | null {
    const c = pickStation(px, py);
    if (c) return c;
    return pickSegment(px, py);
  }
  function showTooltip(hit: Hit, px: number, py: number) {
    const atlas = P.current.atlas;
    const cur = P.current.cur;
    const tooltip = tooltipRef.current;
    if (!atlas || !cur || !tooltip) return;
    const st = S.current;
    st.lastTip = { hit, x: px, y: py };
    let html = "";
    if (hit.kind === "origin") {
      html =
        "<div class='t-title'>" +
        esc(cur.o.zh) +
        " &middot; " +
        esc(cur.en) +
        "</div>" +
        (P.current.direction === "out"
          ? "<div>The origin &mdash; " +
            cur.o.outbound +
            " trains a day leave " +
            esc(cur.en) +
            " for " +
            cur.dests.length +
            " cities, no change of train.</div>"
          : "<div>The destination &mdash; " +
            cur.o.inbound +
            " trains a day arrive in " +
            esc(cur.en) +
            " from " +
            cur.srcs.length +
            " cities, no change of train.</div>");
    } else if (hit.kind === "station") {
      const c = hit.station;
      if (P.current.panelDest && P.current.panelDest.idx === c.idx) {
        const isOrigin = atlas.data.origins.some((o) => o.zh === c.zh);
        html =
          "<div class='t-title'>" +
          esc(c.zh) +
          " &middot; " +
          esc(c.en) +
          "</div><div class='t-sub'>" +
          (isOrigin
            ? "Click again to set as origin city"
            : "Click again to clear selection") +
          "</div>";
      } else {
        html =
          "<div class='t-title'>" +
          esc(c.zh) +
          " &middot; " +
          esc(c.en) +
          "</div>" +
          (P.current.direction === "out"
            ? stationRowsHtml(c as DestVM, cur.en, P.current.distUnit)
            : sourceRowsHtml(c as SrcVM, cur.en, P.current.distUnit));
      }
    } else if (hit.kind === "chord") {
      const ch = hit.chord;
      html =
        "<div class='t-title'>" +
        esc(stationLabel(atlas.data, ch.a)) +
        " &rarr; " +
        esc(stationLabel(atlas.data, ch.b)) +
        "</div>" +
        "<table>" +
        "<tr><td>Trains / day</td><td>" +
        ch.n +
        "</td></tr>" +
        "</table>" +
        "<div class='t-sub'>No track routing &mdash; drawn straight</div>";
    } else if (hit.kind === "seg") {
      const set = flowsSet();
      const isFerry =
        set &&
        set.bb[hit.s * 4 + 1] < 20.15 &&
        set.bb[hit.s * 4 + 3] > 20.20 &&
        set.bb[hit.s * 4] > 110.0 &&
        set.bb[hit.s * 4 + 2] < 110.3;

      if (hit.subN !== undefined && hit.subN > 0 && P.current.panelDest) {
        const destName = P.current.panelDest.en;
        html =
          "<div class='t-title'>" +
          hit.subN +
          (hit.subN === 1 ? " train" : " trains") +
          (P.current.direction === "out" ? " to " : " from ") +
          esc(destName) +
          " <span style='opacity:0.75;font-size:0.9em'>(of " +
          hit.n +
          " total)</span></div>";
      } else {
        html =
          "<div class='t-title'>" +
          hit.n +
          (hit.n === 1 ? " train" : " trains") +
          " per day on this section</div>";
      }
      if (isFerry) {
        const blueCol = P.current.dark ? "#38BDF8" : "#0284C7";
        html +=
          `<div class='t-sub' style='color:${blueCol};font-weight:600'>` +
          "粤海铁路轮渡 (Guangdong–Hainan Train Ferry) &middot; Qiongzhou Strait crossing</div>";
      }
    }
    tooltip.innerHTML = html;
    tooltip.classList.add("show");
    const tw = tooltip.offsetWidth,
      th = tooltip.offsetHeight;
    let x = px + 14,
      y = py + 14;
    if (x + tw > st.W - 6) x = px - tw - 10;
    if (y + th > st.H - 6) y = py - th - 10;
    tooltip.style.left = Math.max(4, x) + "px";
    tooltip.style.top = Math.max(4, y) + "px";
  }
  function hideTooltip() {
    const tooltip = tooltipRef.current;
    if (tooltip) tooltip.classList.remove("show");
    S.current.pinned = false;
  }
  function sameHit(a: Hit | null, b: Hit | null): boolean {
    if (!a || !b) return a === b;
    if (a.kind !== b.kind) return false;
    if (a.kind === "seg" && b.kind === "seg") return a.s === b.s;
    if (a.kind === "chord" && b.kind === "chord") return a.chord === b.chord;
    if (a.kind === "station" && b.kind === "station")
      return a.station === b.station;
    return true; // origin
  }

  /* ---------- imperative API for the toolbar / App ---------- */
  useImperativeHandle(
    apiRef,
    () => ({
      fitCountry() {
        const st = S.current;
        st.interacted = false;
        hideTooltip();
        st.hover = null;
        fitCountryCalc();
        draw();
      },
      fitHome() {
        const st = S.current;
        if (!P.current.cur) return;
        st.interacted = true;
        hideTooltip();
        st.hover = null;
        fitHomeCalc();
        draw();
      },
      zoomCenter(factor: number) {
        zoomAt(S.current.W / 2, S.current.H / 2, factor);
      },
      refreshTooltip() {
        const st = S.current;
        const tooltip = tooltipRef.current;
        if (st.lastTip && tooltip && tooltip.classList.contains("show"))
          showTooltip(st.lastTip.hit, st.lastTip.x, st.lastTip.y);
      },
      clearStationHover() {
        const st = S.current;
        if (st.hover && st.hover.kind === "station") {
          st.hover = null;
          draw();
        }
      },
      selectDestByZh(zh: string) {
        const pts = points();
        const pt = pts.find((p) => p.zh === zh);
        if (pt) {
          P.current.onSelectDest(pt);
          draw();
        }
      },
      panZoomTo(lon: number, lat: number, scale: number) {
        const st = S.current;
        st.interacted = true;
        st.view.scale = scale;
        st.view.tx = st.W / 2 - lon * scale;
        st.view.ty = st.H / 2 + lat * scale;
        draw();
      },
    }),
    [],
  );

  /* ---------- lifecycle ---------- */
  // Wheel zoom needs a non-passive listener (React attaches passive ones).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomAt(
        e.clientX - r.left,
        e.clientY - r.top,
        Math.exp(-e.deltaY * 0.0016),
      );
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Folding / unfolding, rotation and browser-chrome changes reach
    // the page through several channels and not always promptly;
    // listen to all of them (plus a ResizeObserver on the wrap, which
    // fires for any layout change) and coalesce bursts into one
    // resize on the next frame, so the canvas never stays stuck at a
    // stale folded size.
    let raf = 0;
    const onResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        resize();
      });
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    const vv = window.visualViewport;
    if (vv) vv.addEventListener("resize", onResize);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && wrapRef.current) {
      ro = new ResizeObserver(onResize);
      ro.observe(wrapRef.current);
    }
    resize();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      if (vv) vv.removeEventListener("resize", onResize);
      if (ro) ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new origin: reset the camera to the national fit and fade in.
  // A rebuild of the SAME origin (the inbound half merging in) only
  // redraws — the camera, hover and fade belong to origin switches.
  const curRef = useRef<OriginVM | null>(null);
  useEffect(() => {
    if (!props.cur || props.cur === curRef.current) return;
    if (curRef.current && props.cur.o === curRef.current.o) {
      curRef.current = props.cur;
      draw();
      return;
    }
    curRef.current = props.cur;
    const st = S.current;
    st.hover = null;
    hideTooltip();
    st.interacted = false;
    resize();
    setSwitching(true);
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setSwitching(false)),
    );
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.cur]);

  // Toggle / theme / direction / selected-station changes just need a redraw.
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.showNetwork,
    props.showLabels,
    props.showInfra,
    props.showOutline,
    props.outline,
    props.connectorMode,
    props.dark,
    props.direction,
    props.panelDest,
  ]);

  // The scale bar's round distance follows the km/mi switcher.
  useEffect(() => {
    updateScaleBar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.distUnit]);

  /* ---------- pointer handlers ---------- */
  const localPos = (e: React.PointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const p = localPos(e);
    const st = S.current;
    st.pointers.set(e.pointerId, p);
    if (st.pointers.size === 1) {
      st.dragStart = p;
      st.moved = 0;
    }
    if (st.pointers.size === 2) {
      const pts = Array.from(st.pointers.values());
      st.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
    canvas.classList.add("dragging");
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const st = S.current;
    const p = localPos(e);
    if (st.pointers.has(e.pointerId)) {
      const prev = st.pointers.get(e.pointerId)!;
      st.pointers.set(e.pointerId, p);
      if (st.pointers.size === 1 && st.dragStart) {
        const dx = p.x - prev.x,
          dy = p.y - prev.y;
        st.moved += Math.abs(dx) + Math.abs(dy);
        if (st.moved > 3) {
          st.view.tx += dx;
          st.view.ty += dy;
          st.interacted = true;
          hideTooltip();
          if (st.hover) st.hover = null;
          scheduleDraw();
        }
      } else if (st.pointers.size === 2) {
        const pts = Array.from(st.pointers.values());
        const nd = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const mid = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2,
        };
        if (st.pinchDist > 0) zoomAt(mid.x, mid.y, nd / st.pinchDist);
        st.pinchDist = nd;
        st.moved = 99;
      }
      return;
    }
    if (e.pointerType === "mouse" && P.current.cur) {
      const hit = pick(p.x, p.y);
      if (!sameHit(hit, st.hover)) {
        st.hover = hit;
        draw();
      }
      if (hit) showTooltip(hit, p.x, p.y);
      else if (!st.pinned) hideTooltip();
      canvas.style.cursor = hit ? "pointer" : "grab";
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const st = S.current;
    const wasTap = st.pointers.size === 1 && !!st.dragStart && st.moved <= 5;
    const p = localPos(e);
    st.pointers.delete(e.pointerId);
    if (st.pointers.size === 0) {
      canvas.classList.remove("dragging");
      if (wasTap && P.current.cur) {
        const hit = pick(p.x, p.y);
        st.hover = hit;
        if (hit && hit.kind === "station") {
          // A tap/click on a destination pins the detail panel instead of
          // the floating tooltip; another destination updates it.
          P.current.onSelectDest(hit.station);
          hideTooltip();
        } else if (hit) {
          st.pinned = true;
          showTooltip(hit, p.x, p.y);
        } else {
          hideTooltip();
          P.current.onSelectDest(null);
        }
        draw();
      }
      st.dragStart = null;
      st.moved = 0;
      st.pinchDist = 0;
    }
  };

  const onPointerLeave = () => {
    const st = S.current;
    if (!st.pinned) {
      st.hover = null;
      hideTooltip();
      draw();
    }
  };

  const { cur, loadError, inLoading, children } = props;

  return (
    <div id="mapwrap" ref={wrapRef}>
      <canvas
        id="map"
        ref={canvasRef}
        className={switching ? "switching" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={onPointerLeave}
      />
      {(!cur || inLoading) && (
        <div id="loading" style={cur ? { pointerEvents: "none" } : undefined}>
          {loadError && !cur
            ? "The timetable data could not be loaded (" + loadError + ")."
            : "Unfolding the timetable…"}
        </div>
      )}
      <div id="tooltip" role="status" ref={tooltipRef}></div>
      <div
        id="scalebar"
        ref={scaleWrapRef}
        aria-hidden="true"
        style={{ display: "none" }}
      >
        <div className="sb-label" ref={scaleLabelRef}></div>
        <div className="sb-bar" ref={scaleBarRef}></div>
      </div>
      {children}
    </div>
  );
});

export default MapCanvas;
