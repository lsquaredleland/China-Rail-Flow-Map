import { useMemo, useState } from "react";
import type {
  CityPointVM,
  DestVM,
  Direction,
  DistUnit,
  OriginVM,
  SrcVM,
} from "../types";

export interface DistBinFilter {
  bin: number;
  nb: number;
  size: number;
  label: string;
}

export interface DurBinFilter {
  bin: number;
  nb: number;
  size: number; // in minutes (60 = 1h)
  label: string;
}

interface Props {
  cur: OriginVM;
  unit: DistUnit;
  direction: Direction;
  panelCity?: CityPointVM | null;
  selectedClasses?: string[];
  selectedHour?: number | null;
  onSelectHour?: (hour: number | null) => void;
  selectedDistBin?: DistBinFilter | null;
  onSelectDistBin?: (bin: DistBinFilter | null) => void;
  selectedDurBin?: DurBinFilter | null;
  onSelectDurBin?: (bin: DurBinFilter | null) => void;
}

const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif';
const W = 560;
const H = 106;
const PAD_L = 4;
const PAD_R = 4;
const TOP = 17; // headroom for the peak bar's count label
const BASE = 84; // baseline y; axis labels hang below it
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = BASE - TOP;

interface Tick {
  x: number;
  label: string;
  anchor: "start" | "middle" | "end";
}

function Chart({
  counts,
  subCounts,
  ticks,
  titles,
  barClass,
  subBarClass,
  selectedBin,
  onSelectBin,
  ariaLabel,
}: {
  counts: number[];
  subCounts?: number[] | null;
  ticks: Tick[];
  titles: string[];
  barClass: string | ((i: number) => string);
  subBarClass?: string | ((i: number) => string);
  selectedBin?: number | null;
  onSelectBin?: (bin: number) => void;
  ariaLabel: string;
}) {
  const [hoveredBin, setHoveredBin] = useState<number | null>(null);
  const n = counts.length;
  const max = Math.max(1, ...counts);
  const peak = counts.indexOf(Math.max(...counts));
  const hasSub = !!subCounts && subCounts.length === n;
  const subMax = hasSub ? Math.max(0, ...subCounts!) : 0;
  const subPeak = hasSub && subMax > 0 ? subCounts!.indexOf(subMax) : -1;
  const bw = PLOT_W / n;
  const gap = n > 30 ? 1 : Math.min(2, bw * 0.18);
  const barW = Math.max(0.5, bw - gap);
  const hasSelection = selectedBin !== null && selectedBin !== undefined;

  return (
    <svg
      viewBox={"0 0 " + W + " " + H}
      role="img"
      aria-label={ariaLabel}
    >
      {counts.map((c, i) => {
        const h = (c / max) * PLOT_H;
        const sc = hasSub ? subCounts![i] : 0;
        const sh = (sc / max) * PLOT_H;
        const x = PAD_L + i * bw;
        const isSelected = selectedBin === i;
        const isHovered = hoveredBin === i;
        const canClick = !!onSelectBin && (c > 0 || isSelected);
        const colClass =
          "hist-col" +
          (canClick ? " clickable" : "") +
          (isSelected ? " is-selected" : "") +
          (hasSelection && !isSelected ? " is-dimmed" : "");

        const showMainLabel =
          (i === peak || isSelected || isHovered) && (c > 0 || isHovered);
        const showSubLabel =
          hasSub &&
          (i === subPeak || isSelected || isHovered) &&
          sc > 0 &&
          !(i === peak && sc === c) &&
          !(isSelected && sc === c) &&
          !(isHovered && sc === c);

        const bCls = typeof barClass === "function" ? barClass(i) : barClass;
        const sbCls =
          typeof subBarClass === "function"
            ? subBarClass(i)
            : subBarClass || bCls;

        return (
          <g
            key={i}
            className={colClass}
            onMouseEnter={() => setHoveredBin(i)}
            onMouseLeave={() =>
              setHoveredBin((prev) => (prev === i ? null : prev))
            }
            onClick={canClick ? () => onSelectBin!(i) : undefined}
          >
            <rect
              className="hist-col-bg"
              x={x}
              y={2}
              width={bw}
              height={BASE - 2}
              rx={2}
            >
              <title>
                {titles[i] +
                  (canClick
                    ? isSelected
                      ? " · Click to clear filter"
                      : " · Click to filter table"
                    : "")}
              </title>
            </rect>
            {c > 0 ? (
              <rect
                className={
                  "hist-bar " + (hasSub ? bCls + " muted" : bCls)
                }
                x={x + gap / 2}
                y={BASE - h}
                width={barW}
                height={h}
              >
                <title>
                  {titles[i] +
                    (canClick
                      ? isSelected
                        ? " · Click to clear filter"
                        : " · Click to filter table"
                      : "")}
                </title>
              </rect>
            ) : null}
            {hasSub && sc > 0 ? (
              <rect
                className={"hist-bar " + sbCls}
                x={x + gap / 2}
                y={BASE - sh}
                width={barW}
                height={sh}
              >
                <title>
                  {titles[i] +
                    (canClick
                      ? isSelected
                        ? " · Click to clear filter"
                        : " · Click to filter table"
                      : "")}
                </title>
              </rect>
            ) : null}
            {showMainLabel ? (
              <text
                className={
                  (hasSub && !isSelected && !isHovered
                    ? "hist-peak muted"
                    : "hist-peak") + (isHovered ? " is-hover" : "")
                }
                x={x + bw / 2}
                y={Math.max(12, BASE - h - 4)}
                fontSize={isHovered ? 12 : 11.5}
                fontFamily={FONT}
                textAnchor="middle"
              >
                {c}
              </text>
            ) : null}
            {showSubLabel ? (
              <text
                className={"hist-peak-sub" + (isHovered ? " is-hover" : "")}
                x={x + bw / 2}
                y={
                  showMainLabel && h - sh < 12
                    ? Math.max(11, BASE - h - 15)
                    : Math.max(12, BASE - sh - 4)
                }
                fontSize={isHovered ? 11.5 : 11}
                fontFamily={FONT}
                textAnchor="middle"
              >
                {sc}
              </text>
            ) : null}
          </g>
        );
      })}
      <rect className="hist-base" x={PAD_L} y={BASE} width={PLOT_W} height={1} />
      {ticks.map((t, i) => (
        <g key={i}>
          <rect
            className="hist-tickmark"
            x={t.x - 0.5}
            y={BASE + 1}
            width={1}
            height={3}
          />
          <text
            className="hist-tick"
            x={t.x}
            y={BASE + 6}
            fontSize={10.5}
            fontFamily={FONT}
            textAnchor={t.anchor}
            dominantBaseline="hanging"
          >
            {t.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function trainsWord(n: number): string {
  return n === 1 ? " train" : " trains";
}

export default function Histograms({
  cur,
  unit,
  direction,
  panelCity,
  selectedClasses,
  selectedHour,
  onSelectHour,
  selectedDistBin,
  onSelectDistBin,
  selectedDurBin,
  onSelectDurBin,
}: Props) {
  const inbound = direction === "in";
  const hasClassFilter = !!selectedClasses && selectedClasses.length > 0;
  const clsText = hasClassFilter
    ? selectedClasses!.map((c) => (c === "plain" ? "普" : c)).join("/")
    : "";

  const {
    hourCounts,
    subHourCounts,
    distCounts,
    subDistCounts,
    distBinSize,
    distNb,
    distRanges,
    distTicks,
    hourTitles,
    distTitles,
    durCounts,
    subDurCounts,
    durBinSize,
    durNb,
    durRanges,
    durTicks,
    durTitles,
  } = useMemo(() => {
    const fullCity = panelCity
      ? (inbound
          ? cur.srcs.find((s) => s.idx === panelCity.idx)
          : cur.dests.find((d) => d.idx === panelCity.idx)) || panelCity
      : null;

    const rows = inbound
      ? cur.arrs.map((a) => ({
          time: a.arr,
          distKm: a.distKm,
          dur: a.dur,
          cls: a.cls,
        }))
      : cur.deps.map((d) => ({
          time: d.dep,
          distKm: d.distKm,
          dur: d.dur,
          cls: d.cls,
        }));

    let subRows: { time: string; distKm: number; dur: number; cls: string }[] | null =
      null;
    if (fullCity) {
      const cityRows = inbound
        ? ((fullCity as SrcVM).inCalls || []).map((c) => ({
            time: c.arr.arr,
            distKm: c.arr.distKm,
            dur: c.arr.dur,
            cls: c.arr.cls,
          }))
        : ((fullCity as DestVM).calls || []).map((c) => ({
            time: c.dep.dep,
            distKm: c.dep.distKm,
            dur: c.dep.dur,
            cls: c.dep.cls,
          }));
      subRows = hasClassFilter
        ? cityRows.filter((r) => selectedClasses!.includes(r.cls))
        : cityRows;
    } else if (hasClassFilter) {
      subRows = rows.filter((r) => selectedClasses!.includes(r.cls));
    }

    const hours = new Array<number>(24).fill(0);
    for (const d of rows) {
      const h = parseInt(d.time.slice(0, 2), 10);
      if (h >= 0 && h < 24) hours[h]++;
    }
    const subHours = subRows ? new Array<number>(24).fill(0) : null;
    if (subRows && subHours) {
      for (const d of subRows) {
        const h = parseInt(d.time.slice(0, 2), 10);
        if (h >= 0 && h < 24) subHours[h]++;
      }
    }
    const prep = inbound ? "from " : "to ";
    const subDesc = fullCity
      ? prep + fullCity.en + (hasClassFilter ? " (" + clsText + ")" : "")
      : clsText;
    const hTitles = hours.map((c, h) => {
      const base = pad2(h) + ":00–" + pad2(h + 1) + ":00 · ";
      if (subHours && subDesc) {
        const sc = subHours[h];
        return (
          base +
          sc +
          " " +
          subDesc +
          " (of " +
          c +
          trainsWord(c) +
          ")"
        );
      }
      return base + c + trainsWord(c);
    });

    const size = unit === "km" ? 100 : 50;
    const vals = rows.map((d) =>
      unit === "km" ? d.distKm : d.distKm * 0.621371,
    );
    let maxV = 0;
    for (const v of vals) if (v > maxV) maxV = v;
    const nb = Math.max(1, Math.floor(maxV / size) + 1);
    const dist = new Array<number>(nb).fill(0);
    for (const v of vals) {
      const b = Math.min(nb - 1, Math.floor(v / size));
      dist[b]++;
    }
    const subDist = subRows ? new Array<number>(nb).fill(0) : null;
    if (subRows && subDist) {
      for (const d of subRows) {
        const v = unit === "km" ? d.distKm : d.distKm * 0.621371;
        const b = Math.min(nb - 1, Math.max(0, Math.floor(v / size)));
        subDist[b]++;
      }
    }
    const lastStart = (nb - 1) * size;
    const u = unit === "km" ? " km" : " mi";
    const ranges = dist.map((_, b) =>
      b === nb - 1
        ? lastStart.toLocaleString("en-US") + "+" + u
        : (b * size).toLocaleString("en-US") +
          "–" +
          ((b + 1) * size).toLocaleString("en-US") +
          u,
    );
    const dTitles = dist.map((c, b) => {
      const range = ranges[b];
      if (subDist && subDesc) {
        const sc = subDist[b];
        return (
          range +
          " · " +
          sc +
          " " +
          subDesc +
          " (of " +
          c +
          trainsWord(c) +
          ")"
        );
      }
      return range + " · " + c + trainsWord(c);
    });
    const span = nb * size;
    const xFor = (v: number) => PAD_L + (v / span) * PLOT_W;
    const ticks: Tick[] = [{ x: xFor(0), label: "0", anchor: "start" }];
    for (let v = 500; v + size * 2 <= lastStart; v += 500) {
      ticks.push({ x: xFor(v), label: v.toLocaleString("en-US"), anchor: "middle" });
    }
    if (lastStart > 0) {
      ticks.push({
        x: xFor(lastStart),
        label: lastStart.toLocaleString("en-US") + "+",
        anchor: "middle",
      });
    }

    // Journey duration histogram: 1-hour (60-minute) bins, capped at 25 bins (24h+)
    const durSize = 60;
    let maxDur = 0;
    for (const r of rows) {
      if (r.dur > maxDur) maxDur = r.dur;
    }
    const dNb = Math.max(1, Math.min(25, Math.floor(maxDur / durSize) + 1));
    const dur = new Array<number>(dNb).fill(0);
    for (const r of rows) {
      if (r.dur >= 0) {
        const b = Math.min(dNb - 1, Math.floor(r.dur / durSize));
        dur[b]++;
      }
    }
    const subDur = subRows ? new Array<number>(dNb).fill(0) : null;
    if (subRows && subDur) {
      for (const r of subRows) {
        if (r.dur >= 0) {
          const b = Math.min(dNb - 1, Math.floor(r.dur / durSize));
          subDur[b]++;
        }
      }
    }
    const dRanges = dur.map((_, b) =>
      b === dNb - 1
        ? b + "h+"
        : b + "–" + (b + 1) + "h",
    );
    const tTitles = dur.map((c, b) => {
      const range = dRanges[b];
      if (subDur && subDesc) {
        const sc = subDur[b];
        return (
          range +
          " · " +
          sc +
          " " +
          subDesc +
          " (of " +
          c +
          trainsWord(c) +
          ")"
        );
      }
      return range + " · " + c + trainsWord(c);
    });
    const xForDur = (h: number) => PAD_L + (h / dNb) * PLOT_W;
    const tTicks: Tick[] = [{ x: xForDur(0), label: "0h", anchor: "start" }];
    const stepH = dNb > 14 ? 4 : 2;
    for (let h = stepH; h + 2 <= dNb - 1; h += stepH) {
      tTicks.push({ x: xForDur(h), label: h + "h", anchor: "middle" });
    }
    if (dNb - 1 > 0) {
      tTicks.push({
        x: xForDur(dNb - 1),
        label: dNb - 1 + "h+",
        anchor: "middle",
      });
    }

    return {
      hourCounts: hours,
      subHourCounts: subHours,
      distCounts: dist,
      subDistCounts: subDist,
      distBinSize: size,
      distNb: nb,
      distRanges: ranges,
      distTicks: ticks,
      hourTitles: hTitles,
      distTitles: dTitles,
      durCounts: dur,
      subDurCounts: subDur,
      durBinSize: durSize,
      durNb: dNb,
      durRanges: dRanges,
      durTicks: tTicks,
      durTitles: tTitles,
    };
  }, [cur, unit, inbound, panelCity, hasClassFilter, selectedClasses, clsText]);

  if ((inbound ? cur.arrs.length : cur.deps.length) === 0) return null;

  const hourTicks: Tick[] = [0, 6, 12, 18, 23].map((h) => ({
    x: PAD_L + ((h + 0.5) / 24) * PLOT_W,
    label: pad2(h),
    anchor: "middle" as const,
  }));

  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
  const subLabel = panelCity
    ? (inbound ? "From " : "To ") +
      panelCity.en +
      (hasClassFilter ? " (" + clsText + ")" : "")
    : hasClassFilter
      ? clsText + " trains"
      : null;

  const handleHourClick = (h: number) => {
    if (!onSelectHour) return;
    onSelectHour(selectedHour === h ? null : h);
  };

  const handleDistClick = (b: number) => {
    if (!onSelectDistBin) return;
    if (selectedDistBin && selectedDistBin.bin === b) {
      onSelectDistBin(null);
    } else {
      onSelectDistBin({
        bin: b,
        nb: distNb,
        size: distBinSize,
        label: distRanges[b],
      });
    }
  };

  const handleDurClick = (b: number) => {
    if (!onSelectDurBin) return;
    if (selectedDurBin && selectedDurBin.bin === b) {
      onSelectDurBin(null);
    } else {
      onSelectDurBin({
        bin: b,
        nb: durNb,
        size: durBinSize,
        label: durRanges[b],
      });
    }
  };

  return (
    <div className="hist-strip">
      <figure className="hist">
        <figcaption>
          <span>{inbound ? "Arrivals by hour" : "Departures by hour"}</span>
          {subLabel ? (
            <span className="hist-key">
              <span className="swatch swatch-h-sub" />
              {subLabel}
              <span className="swatch swatch-h-muted" />
              All {cur.en}
            </span>
          ) : (
            <span className="hist-hint">Click a bar to filter</span>
          )}
        </figcaption>
        <Chart
          counts={hourCounts}
          subCounts={subHourCounts}
          ticks={hourTicks}
          titles={hourTitles}
          barClass="bar-h"
          subBarClass="bar-h-sub"
          selectedBin={selectedHour}
          onSelectBin={handleHourClick}
          ariaLabel={
            "Histogram of " +
            (inbound ? "arrivals" : "departures") +
            " by hour of day " +
            (inbound ? "in " : "from ") +
            cur.en +
            (panelCity
              ? " with " +
                (inbound ? "arrivals from " : "calls at ") +
                panelCity.en +
                " overlaid"
              : "") +
            "; the busiest hour is " +
            pad2(peakHour) +
            ":00 with " +
            Math.max(...hourCounts) +
            " trains"
          }
        />
      </figure>
      <figure className="hist">
        <figcaption>
          <span>Trains by journey distance</span>
          {subLabel ? (
            <span className="hist-key">
              <span className="swatch swatch-d-sub" />
              {subLabel}
              <span className="swatch swatch-d-muted" />
              All {cur.en}
            </span>
          ) : (
            <span className="hist-hint">Click a bar to filter</span>
          )}
        </figcaption>
        <Chart
          counts={distCounts}
          subCounts={subDistCounts}
          ticks={distTicks}
          titles={distTitles}
          barClass="bar-d"
          subBarClass="bar-d-sub"
          selectedBin={selectedDistBin ? selectedDistBin.bin : null}
          onSelectBin={handleDistClick}
          ariaLabel={
            "Histogram of trains " +
            (inbound ? "arriving in " : "from ") +
            cur.en +
            " by journey distance " +
            (inbound ? "from their origin" : "to their final destination") +
            (panelCity
              ? " with " +
                (inbound ? "trains from " : "trains calling at ") +
                panelCity.en +
                " overlaid"
              : "") +
            ", in bins of " +
            distBinSize +
            (unit === "km" ? " kilometres" : " miles")
          }
        />
      </figure>
      <figure className="hist">
        <figcaption>
          <span>Trains by journey time</span>
          {subLabel ? (
            <span className="hist-key">
              <span className="swatch swatch-t-sub" />
              {subLabel}
              <span className="swatch swatch-t-muted" />
              All {cur.en}
            </span>
          ) : (
            <span className="hist-hint">Click a bar to filter</span>
          )}
        </figcaption>
        <Chart
          counts={durCounts}
          subCounts={subDurCounts}
          ticks={durTicks}
          titles={durTitles}
          barClass={(i) => {
            const h = (i * durBinSize) / 60;
            return h < 4
              ? "bar-t bar-t-petrol"
              : h < 12
                ? "bar-t bar-t-saffron"
                : "bar-t bar-t-ultra";
          }}
          subBarClass={(i) => {
            const h = (i * durBinSize) / 60;
            return h < 4
              ? "bar-t-sub bar-t-petrol"
              : h < 12
                ? "bar-t-sub bar-t-saffron"
                : "bar-t-sub bar-t-ultra";
          }}
          selectedBin={selectedDurBin ? selectedDurBin.bin : null}
          onSelectBin={handleDurClick}
          ariaLabel={
            "Histogram of trains " +
            (inbound ? "arriving in " : "from ") +
            cur.en +
            " by journey duration in 1-hour bins"
          }
        />
      </figure>
    </div>
  );
}
