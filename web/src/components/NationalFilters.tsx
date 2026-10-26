import { useMemo, useState } from "react";
import type { DistBinFilter, DistUnit, DurBinFilter, NationalIndexPack, RawTrain } from "../types";
import { NAT_DIST_BINS, NAT_DIST_SIZE, NAT_DUR_BINS, NAT_HOUR_BINS, natHistogram } from "../lib";
import type { NatFilter } from "../lib";
import { Chart, PAD_L, PLOT_W } from "./Histograms";
import type { Tick } from "./Histograms";

/* National mode's filters beyond the class buttons: hour / distance / duration
   histograms of every national train (each under all the other filters) and a
   train-code box. They live in the toolbar's Filters panel, so on narrow
   screens they fold into its dropdown. All counts come from the per-train
   index; the selected bins and codes drive the map through the same filter
   state as the origin view. */

const pad2 = (n: number) => (n < 10 ? "0" + n : String(n));
const trainsWord = (n: number) => (n === 1 ? " train" : " trains");

/** Plain click selects one bin (or clears it); ctrl / cmd / shift click adds or removes. */
function toggleBin<T extends { bin: number }>(cur: readonly T[], make: (b: number) => T, b: number, e: React.MouseEvent): T[] {
  const has = cur.some((x) => x.bin === b);
  if (e.metaKey || e.ctrlKey || e.shiftKey) {
    return has ? cur.filter((x) => x.bin !== b) : [...cur, make(b)].sort((x, y) => x.bin - y.bin);
  }
  return has && cur.length === 1 ? [] : [make(b)];
}

export default function NationalFilters({
  index,
  failed,
  trainTable,
  filter,
  unit,
  onHours,
  onDistBins,
  onDurBins,
  onTrainCodes,
}: {
  index: NationalIndexPack | null;
  failed: boolean;
  trainTable: readonly RawTrain[];
  filter: NatFilter;
  unit: DistUnit;
  onHours: (h: number[]) => void;
  onDistBins: (b: DistBinFilter[]) => void;
  onDurBins: (b: DurBinFilter[]) => void;
  onTrainCodes: (c: string[]) => void;
}) {
  const [code, setCode] = useState("");
  const [bad, setBad] = useState(false);
  const h = useMemo(() => (index ? natHistogram(trainTable, index, filter, "hour") : null), [index, trainTable, filter]);
  const d = useMemo(() => (index ? natHistogram(trainTable, index, filter, "dist") : null), [index, trainTable, filter]);
  const t = useMemo(() => (index ? natHistogram(trainTable, index, filter, "dur") : null), [index, trainTable, filter]);

  if (failed) return null;
  if (!index || !h || !d || !t) {
    return <div className="nat-filters nat-filters-loading">Loading national filters…</div>;
  }

  const nb = NAT_DIST_BINS[unit];
  const size = NAT_DIST_SIZE[unit];
  const u = unit === "km" ? " km" : " mi";
  const distLabel = (b: number) =>
    b === nb - 1 ? (b * size).toLocaleString("en-US") + "+" + u : (b * size).toLocaleString("en-US") + "–" + ((b + 1) * size).toLocaleString("en-US") + u;
  const durLabel = (b: number) => (b === NAT_DUR_BINS - 1 ? b + "h+" : b + "–" + (b + 1) + "h");
  const makeDist = (b: number): DistBinFilter => ({ bin: b, nb, size, label: distLabel(b) });
  const makeDur = (b: number): DurBinFilter => ({ bin: b, nb: NAT_DUR_BINS, size: 60, label: durLabel(b) });

  const hourTicks: Tick[] = [0, 6, 12, 18, 23].map((x) => ({
    x: PAD_L + ((x + 0.5) / NAT_HOUR_BINS) * PLOT_W,
    label: pad2(x),
    anchor: "middle" as const,
  }));
  const xDist = (v: number) => PAD_L + (v / nb) * PLOT_W;
  const distTicks: Tick[] = [{ x: xDist(0), label: "0", anchor: "start" }];
  const step = unit === "km" ? 5 : 5; // every 500 km / 250 mi
  for (let b = step; b + 2 <= nb - 1; b += step) {
    distTicks.push({ x: xDist(b), label: (b * size).toLocaleString("en-US"), anchor: "middle" });
  }
  distTicks.push({ x: xDist(nb - 1), label: (nb - 1) * size + "+", anchor: "middle" });
  const xDur = (v: number) => PAD_L + (v / NAT_DUR_BINS) * PLOT_W;
  const durTicks: Tick[] = [{ x: xDur(0), label: "0h", anchor: "start" }];
  for (let b = 4; b + 2 <= NAT_DUR_BINS - 1; b += 4) durTicks.push({ x: xDur(b), label: b + "h", anchor: "middle" });
  durTicks.push({ x: xDur(NAT_DUR_BINS - 1), label: NAT_DUR_BINS - 1 + "h+", anchor: "middle" });

  const addCode = () => {
    const c = code.trim().toUpperCase();
    if (!c) return;
    if (!trainTable.some((r) => r.code === c)) {
      setBad(true);
      return;
    }
    setBad(false);
    setCode("");
    if (!filter.trainCodes.includes(c)) onTrainCodes([...filter.trainCodes, c]);
  };

  return (
    <div className="nat-filters">
      <div className="hist-strip">
        <figure className="hist">
          <figcaption>
            <span>Trains by departure hour</span>
            <span className="hist-hint">Click a bar to filter</span>
          </figcaption>
          <Chart
            counts={h}
            ticks={hourTicks}
            titles={h.map((c, i) => pad2(i) + ":00–" + pad2(i + 1) + ":00 · " + c + trainsWord(c))}
            barClass="bar-h"
            selectedBins={[...filter.hours]}
            onSelectBin={(b, e) => {
              const has = filter.hours.includes(b);
              onHours(
                e.metaKey || e.ctrlKey || e.shiftKey
                  ? has ? filter.hours.filter((x) => x !== b) : [...filter.hours, b].sort((x, y) => x - y)
                  : has && filter.hours.length === 1 ? [] : [b],
              );
            }}
            ariaLabel="Histogram of all national trains by departure hour"
          />
        </figure>
        <figure className="hist">
          <figcaption>
            <span>Trains by journey distance</span>
            <span className="hist-hint">Click a bar to filter</span>
          </figcaption>
          <Chart
            counts={d}
            ticks={distTicks}
            titles={d.map((c, i) => distLabel(i) + " · " + c + trainsWord(c))}
            barClass="bar-d"
            selectedBins={filter.distBins.map((x) => x.bin)}
            onSelectBin={(b, e) => onDistBins(toggleBin(filter.distBins, makeDist, b, e))}
            ariaLabel="Histogram of all national trains by journey distance"
          />
        </figure>
        <figure className="hist">
          <figcaption>
            <span>Trains by journey time</span>
            <span className="hist-hint">Click a bar to filter</span>
          </figcaption>
          <Chart
            counts={t}
            ticks={durTicks}
            titles={t.map((c, i) => durLabel(i) + " · " + c + trainsWord(c))}
            barClass={(i) => (i < 4 ? "bar-t bar-t-petrol" : i < 12 ? "bar-t bar-t-saffron" : "bar-t bar-t-ultra")}
            selectedBins={filter.durBins.map((x) => x.bin)}
            onSelectBin={(b, e) => onDurBins(toggleBin(filter.durBins, makeDur, b, e))}
            ariaLabel="Histogram of all national trains by journey duration in 1-hour bins"
          />
        </figure>
      </div>
      <form
        className="nat-code"
        onSubmit={(e) => {
          e.preventDefault();
          addCode();
        }}
      >
        <label htmlFor="natCode">Train</label>
        <input
          id="natCode"
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          placeholder="e.g. G1"
          value={code}
          aria-invalid={bad ? "true" : "false"}
          onChange={(e) => {
            setCode(e.target.value);
            setBad(false);
          }}
        />
        <button type="submit">Add</button>
        {bad && <span className="nat-code-bad">No such train</span>}
      </form>
    </div>
  );
}
