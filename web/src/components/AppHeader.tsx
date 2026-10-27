import { useState } from "react";
import type { Direction, DistUnit, OriginVM } from "../types";

/** The phone toolbar's one-line stats ("1,498 trains daily · 653 direct cities ·
    359 busiest/day"): the same three numbers as the header's stat row. */
export function compactStats(o: {
  cur: OriginVM | null;
  viewCur: OriginVM | null;
  direction: Direction;
  filtered: boolean;
  outTablesReady: boolean;
  inTablesReady: boolean;
  trainCount: number;
  national?: { cities: number | null; maxFlow: number | null } | null;
}): [string, string][] | null {
  const n = (v: number | null | undefined) => (v == null ? "…" : v.toLocaleString("en-US"));
  if (o.national) {
    return [
      [n(o.trainCount || null), "trains running"],
      [n(o.national.cities), "cities"],
      [n(o.national.maxFlow), "busiest/day"],
    ];
  }
  const { cur, viewCur } = o;
  if (!cur || !viewCur) return null;
  return o.direction === "out"
    ? [
        [n(o.filtered && o.outTablesReady ? viewCur.deps.length : cur.o.outbound), "trains daily"],
        [n(viewCur.dests.length), "direct cities"],
        [n(viewCur.maxFlow), "busiest/day"],
      ]
    : [
        [n(o.filtered && o.inTablesReady ? viewCur.arrs.length : cur.o.inbound), "trains daily"],
        [n(viewCur.srcs.length), "direct cities"],
        [n(viewCur.maxInFlow), "busiest/day"],
      ];
}

export default function AppHeader({
  cur,
  viewCur,
  direction,
  distUnit,
  selectedClasses,
  hasHistFilter,
  selectedTrainCodes,
  outTablesReady,
  inTablesReady,
  trainCount,
  national,
  isNational,
  onSetNational,
  compact,
}: {
  cur: OriginVM | null;
  viewCur: OriginVM | null;
  direction: Direction;
  distUnit: DistUnit;
  selectedClasses: string[];
  /** Any histogram / train filter (not counting the class filter). */
  hasHistFilter: boolean;
  selectedTrainCodes: string[];
  outTablesReady: boolean;
  inTablesReady: boolean;
  /** Trains in the pack (train_table rows); 0 until the pack loads. */
  trainCount: number;
  /** National mode: the pack-wide numbers the stat row shows (null while the flows load). */
  national?: { cities: number | null; maxFlow: number | null } | null;
  /** National mode is on; `onSetNational` switches between it and the origin view. */
  isNational: boolean;
  onSetNational: (on: boolean) => void;
  /** Phones: the three stats as one line under the description (compactStats). */
  compact?: [string, string][] | null;
}) {
  // Phones clamp the description to two lines; a tap shows the rest.
  const [subOpen, setSubOpen] = useState(false);
  return (
    <header>
      <div className="head-row">
      <h1>
        <span className="cr-logo-wrap">
          <svg
            className="cr-logo"
            viewBox="-100 -110 200 230"
            aria-hidden="true"
          >
            <path
              d="M34.899004 68.637159a77 77 0 1 0-69.798007 0l-14.151965 18.506415A100 100 0 0 1-18.99159-98.180036 10 10 0 0 1-10-109.544511a110 110 0 0 1 20 0 10 10 0 0 1 8.99159 11.364475 100 100 0 0 1 30.059378 185.32361zm26.885461 38.719734A4 4 0 0 1 65 111.279216V120H-65v-8.720784a4 4 0 0 1 3.215535-3.922323l42.530091-8.506018A14 14 0 0 0-8 85.122745V28.2573a10 10 0 0 0-7.252789-9.615239L-35 13V-5.169757A14 14 0 0 1-22.105263-19.12606a280 280 0 0 1 44.210526 0A14 14 0 0 1 35-5.169757V13l-19.747211 5.64206A10 10 0 0 0 8 28.2573v56.865445a14 14 0 0 0 11.254373 13.728129z"
              fill="currentColor"
            />
          </svg>
        </span>
        <span>
          China Rail Flow Map <span className="zh"><span className="zh-sep">· </span>铁路客流图</span>
        </span>
      </h1>
      <div className="group units mode-switch" role="group" aria-label="View">
        <button
          id="modeOrigin"
          type="button"
          aria-pressed={isNational ? "false" : "true"}
          onClick={() => onSetNational(false)}
        >
          Origin City
        </button>
        <button
          id="tglNational"
          type="button"
          aria-pressed={isNational ? "true" : "false"}
          onClick={() => onSetNational(true)}
          title="Every covered train in China on one 24h clock (beta)"
        >
          National Beta
        </button>
      </div>
      </div>
      <p className={"subtitle" + (subOpen ? " open" : "")} onClick={() => setSubOpen((v) => !v)}>
        A Minard inspired animated flow diagram of trains departing and
        arriving across China&rsquo;s top rail hubs. The width of each line
        corresponds to the number of trains that traverse said corridor.
        Spanning{" "}
        <b>{trainCount ? trainCount.toLocaleString("en-US") : "…"}</b>{" "}
        scheduled passenger services across over{" "}
        <b>{distUnit === "mi" ? "30,000 mi" : "50,000 km"}</b> of high speed
        rail (and even more conventional rail). Click on a city pair to see
        how traffic flows between them.
      </p>
      {compact && (
        <p className="mob-stats" aria-hidden="true">
          {compact.map(([v, l], i) => (
            <span key={l}>
              {i > 0 && " · "}
              <b>{v}</b> {l}
            </span>
          ))}
        </p>
      )}
      <div className="stats" id="stats">
        {national && (
          <>
            <div>
              <b>{trainCount ? trainCount.toLocaleString("en-US") : "…"}</b>{" "}
              <span>trains running</span>
            </div>
            <div>
              <b>{national.cities?.toLocaleString("en-US") ?? "…"}</b> <span>cities connected</span>
            </div>
            <div>
              <b>{national.maxFlow?.toLocaleString("en-US") ?? "…"}</b>{" "}
              <span data-short="trains/day, busiest">trains/day on the busiest corridor</span>
            </div>
          </>
        )}
        {cur &&
          viewCur &&
          (() => {
            const hasAnyFilter =
              selectedClasses.length > 0 || hasHistFilter;
            const filterLabel =
              selectedTrainCodes.length > 0
                ? selectedTrainCodes.length === 1
                  ? "train selected"
                  : "trains selected"
                : "trains matching filter";

            return direction === "out" ? (
              <>
                <div>
                  <b>
                    {(hasAnyFilter && outTablesReady
                      ? viewCur.deps.length
                      : cur.o.outbound
                    ).toLocaleString("en-US")}
                  </b>{" "}
                  <span data-short={selectedClasses.length || hasHistFilter ? undefined : "trains depart daily"}>
                    {hasHistFilter
                      ? filterLabel
                      : selectedClasses.length > 0
                        ? selectedClasses
                            .map((c) => (c === "plain" ? "普" : c))
                            .join("/") +
                          " trains Depart " +
                          cur.en +
                          " daily"
                        : "trains Depart " + cur.en + " daily"}
                  </span>
                </div>
                <div>
                  <b>{viewCur.dests.length}</b>{" "}
                  <span data-short="direct cities">cities with a direct connection</span>
                </div>
                <div>
                  <b>{viewCur.maxFlow}</b>{" "}
                  <span data-short="trains/day, busiest">trains/day on the busiest corridors</span>
                </div>
              </>
            ) : (
              <>
                <div>
                  <b>
                    {(hasAnyFilter && inTablesReady
                      ? viewCur.arrs.length
                      : cur.o.inbound
                    ).toLocaleString("en-US")}
                  </b>{" "}
                  <span data-short={selectedClasses.length || hasHistFilter ? undefined : "trains arrive daily"}>
                    {hasHistFilter
                      ? filterLabel
                      : selectedClasses.length > 0
                        ? selectedClasses
                            .map((c) => (c === "plain" ? "普" : c))
                            .join("/") +
                          " trains Arrive in " +
                          cur.en +
                          " daily"
                        : "trains Arrive in " + cur.en + " daily"}
                  </span>
                </div>
                <div>
                  <b>{viewCur.srcs.length}</b>{" "}
                  <span data-short="direct cities">cities with a direct connection</span>
                </div>
                <div>
                  <b>{viewCur.maxInFlow}</b>{" "}
                  <span data-short="trains/day, busiest">trains/day on the busiest corridors</span>
                </div>
              </>
            );
          })()}
      </div>
    </header>
  );
}
