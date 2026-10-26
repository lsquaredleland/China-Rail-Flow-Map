import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { DepVM, ArrVM, DistUnit, RawTrain, SchedulesData, ScheduleStop } from "../types";
import { RunsLabel } from "./departures/RunsCell";
import type { MapApi } from "./MapCanvas";
import { formatScheduleStops } from "../lib";
import { useDialogFocus } from "../hooks/useDialog";

interface Props {
  code: string | null;
  trainT: number | null; // train_table index; keys the schedules file
  trainRow?: RawTrain | null; // its train_table row (run days)
  calendar?: readonly string[];
  onClose: () => void;
  schedulesData: SchedulesData | null;
  stationTable: { zh: string; en: string }[];
  dark: boolean;
  unit?: DistUnit;
  trainVM?: DepVM | ArrVM | null;
  currentTime?: number;
  isIsolated?: boolean;
  onToggleIsolate?: (code: string) => void;
  onJumpToTime?: (mins: number) => void;
  mapRef?: RefObject<MapApi | null>;
  originCityZh?: string;
  originCityEn?: string;
  direction?: string;
  /** National mode: no origin; the train's own first stop anchors the times and
      the clock wraps every 24 h, so the live time is folded into the train's run. */
  national?: boolean;
}

interface AlignedStop extends ScheduleStop {
  simArrMins: number;
  simDepMins: number;
}

function fmtStName(zh: string, en?: string): string {
  if (en && en !== zh) {
    return `${zh} (${en})`;
  }
  return zh;
}

export default function TrainScheduleModal({
  code,
  trainT,
  trainRow,
  calendar,
  onClose,
  schedulesData,
  stationTable,
  dark,
  unit = "km",
  currentTime,
  isIsolated = false,
  onToggleIsolate,
  onJumpToTime,
  mapRef,
  originCityZh,
  originCityEn,
  direction,
  national = false,
  trainVM: trainVMProp,
}: Props) {
  const titleId = useId();
  const [minimized, setMinimized] = useState(false);
  const [rawTime, setLiveTime] = useState<number>(() => currentTime ?? 360);

  // Subscribe to live simulation ticks
  useEffect(() => {
    if (!mapRef?.current?.subscribeAnim) return;
    const unsub = mapRef.current.subscribeAnim((st) => {
      setLiveTime(st.time);
    });
    return unsub;
  }, [mapRef]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const stops = useMemo(() => {
    if (!code || trainT === null || !schedulesData) return null;
    return formatScheduleStops(schedulesData, stationTable, trainT);
  }, [code, trainT, schedulesData, stationTable]);

  // National mode has no origin row: the train's own first and last stops stand
  // in for it (the same fields the origin row gives the header, the route line
  // and the jump button).
  const trainVM = useMemo<DepVM | ArrVM | null | undefined>(() => {
    if (trainVMProp || !national || !stops || stops.length < 2 || !code) return trainVMProp;
    const first = stops[0], last = stops[stops.length - 1];
    let day = 0;
    let prev = first.depMins >= 0 ? first.depMins : first.arrMins;
    let arrAbs = prev;
    for (const s of stops) {
      for (const m of [s.arrMins, s.depMins]) {
        if (m < 0) continue;
        if (m < prev) day++;
        prev = m;
      }
      if (s === last) arrAbs = day * 1440 + (last.arrMins >= 0 ? last.arrMins : prev);
    }
    const dep = first.depMins >= 0 ? first.depMins : 0;
    return {
      code,
      cls: trainRow?.class ?? code.charAt(0),
      dep: first.dep,
      arr: last.arr,
      depMins: dep,
      arrMins: arrAbs,
      dur: Math.max(0, arrAbs - dep),
      fsZh: first.stZh,
      fsEn: first.stEn,
      tsZh: last.stZh,
      tsEn: last.stEn,
    } as unknown as DepVM;
  }, [trainVMProp, national, stops, code, trainRow]);

  // Identify the station corresponding to the currently selected city (e.g. Guangzhou, Wuhan, Beijing)
  const originStationZh = trainVM
    ? (trainVM.fsZh || trainVM.tsZh || "")
    : "";

  const originStDisplay = trainVM
    ? fmtStName(trainVM.fsZh || "", trainVM.fsEn)
    : "";
  const destStDisplay = trainVM
    ? fmtStName(trainVM.tsZh || "", trainVM.tsEn)
    : "";

  const originStop = useMemo(() => {
    if (!stops || national) return null; // national mode has no selected origin
    return (
      stops.find(
        (s) =>
          (originStationZh && (s.stZh === originStationZh || s.stEn === originStationZh)) ||
          (originCityZh && (s.stZh === originCityZh || s.stZh.startsWith(originCityZh))) ||
          (originCityEn &&
            (s.stEn.toLowerCase() === originCityEn.toLowerCase() ||
              s.stEn.toLowerCase().startsWith(originCityEn.toLowerCase()))),
      ) || null
    );
  }, [stops, national, originStationZh, originCityZh, originCityEn]);

  // Align schedule stops chronologically and anchor to the selected trainVM's simulation departure/arrival
  const alignedStops = useMemo<AlignedStop[] | null>(() => {
    if (!stops || stops.length === 0) return null;

    // Step 1: Unroll schedule minutes monotonically along route to handle midnight rollovers
    let currentDay = 0;
    let prevMins = stops[0].depMins >= 0 ? stops[0].depMins : stops[0].arrMins;

    const unrolled = stops.map((s) => {
      let unrolledArr = -1;
      let unrolledDep = -1;

      if (s.arrMins >= 0) {
        if (s.arrMins < prevMins) {
          currentDay += 1;
        }
        unrolledArr = currentDay * 1440 + s.arrMins;
        prevMins = s.arrMins;
      }

      if (s.depMins >= 0) {
        if (s.depMins < prevMins) {
          currentDay += 1;
        }
        unrolledDep = currentDay * 1440 + s.depMins;
        prevMins = s.depMins;
      }

      return {
        ...s,
        unrolledArr,
        unrolledDep,
      };
    });

    // Step 2: Find the anchor stop corresponding to the selected station/city
    let anchorIdx = -1;
    if (trainVM) {
      anchorIdx = unrolled.findIndex(
        (s) =>
          (originStationZh && (s.stZh === originStationZh || s.stEn === originStationZh)) ||
          (originCityZh && (s.stZh === originCityZh || s.stZh.startsWith(originCityZh))) ||
          (originCityEn &&
            (s.stEn.toLowerCase() === originCityEn.toLowerCase() ||
              s.stEn.toLowerCase().startsWith(originCityEn.toLowerCase()))),
      );
    }

    let timeShift = 0;
    if (anchorIdx >= 0 && trainVM) {
      const anchor = unrolled[anchorIdx];
      const isArrVM = "fcIdx" in trainVM;
      if (isArrVM && anchor.unrolledArr >= 0) {
        timeShift = trainVM.arrMins - anchor.unrolledArr;
      } else if (anchor.unrolledDep >= 0) {
        timeShift = trainVM.depMins - anchor.unrolledDep;
      }
    }

    return unrolled.map((s) => ({
      ...s,
      simArrMins: s.unrolledArr >= 0 ? s.unrolledArr + timeShift : -1,
      simDepMins: s.unrolledDep >= 0 ? s.unrolledDep + timeShift : -1,
    }));
  }, [stops, trainVM, originStationZh, originCityZh, originCityEn]);

  // The national clock wraps every 24 h: take the run's occurrence at or after
  // its start (a run past midnight is then still on the line after 00:00);
  // between the end and the next start the train waits for tomorrow's departure.
  const liveTime = useMemo(() => {
    if (!national || !alignedStops || alignedStops.length === 0) return rawTime;
    const first = alignedStops[0].simDepMins, last = alignedStops[alignedStops.length - 1].simArrMins;
    const t = rawTime + 1440 * Math.ceil((first - rawTime) / 1440);
    return t > last ? t - 1440 : t;
  }, [national, alignedStops, rawTime]);

  // Determine current active trip status
  const currentStatus = useMemo(() => {
    if (!alignedStops || alignedStops.length === 0) return null;
    const first = alignedStops[0];
    const last = alignedStops[alignedStops.length - 1];

    if (liveTime < first.simDepMins) {
      const wait = Math.max(0, Math.round(first.simDepMins - liveTime));
      return {
        state: "pre" as const,
        text: `Departs ${fmtStName(first.stZh, first.stEn)} in ${wait > 60 ? `${Math.floor(wait / 60)}h ${wait % 60}m` : `${wait}m`} (at ${first.dep})`,
      };
    }
    if (liveTime >= last.simArrMins) {
      return {
        state: "post" as const,
        text: `Completed journey to ${fmtStName(last.stZh, last.stEn)} at ${last.arr}`,
      };
    }

    // Check if currently stopped at a station
    for (let i = 0; i < alignedStops.length; i++) {
      const s = alignedStops[i];
      if (
        s.simArrMins >= 0 &&
        s.simDepMins >= 0 &&
        liveTime >= s.simArrMins &&
        liveTime <= s.simDepMins
      ) {
        const rem = Math.max(0, Math.round(s.simDepMins - liveTime));
        return {
          state: "stopped" as const,
          text: `Stopped at ${fmtStName(s.stZh, s.stEn)} · Departs in ${rem}m (${s.dep})`,
          stopIdx: i,
        };
      }
    }

    // In transit between stops
    for (let i = 0; i < alignedStops.length - 1; i++) {
      const curr = alignedStops[i];
      const next = alignedStops[i + 1];
      if (liveTime >= curr.simDepMins && liveTime < next.simArrMins) {
        const eta = Math.max(0, Math.round(next.simArrMins - liveTime));
        const finalEta = Math.max(0, Math.round(last.simArrMins - liveTime));
        const finalH = Math.floor(finalEta / 60);
        const finalM = finalEta % 60;
        const finalEtaStr =
          finalH > 0
            ? finalM > 0
              ? `${finalH}h ${finalM}m`
              : `${finalH}h`
            : `${finalM}m`;
        return {
          state: "transit" as const,
          text: `En route: ${fmtStName(curr.stZh, curr.stEn)} ➔ ${fmtStName(next.stZh, next.stEn)} · ETA in ${finalEtaStr} (${last.arr})`,
          fromIdx: i,
          toIdx: i + 1,
          eta,
          finalEta,
          finalEtaStr,
        };
      }
    }

    return null;
  }, [alignedStops, liveTime]);

  const overallProgress = useMemo(() => {
    if (!alignedStops || alignedStops.length === 0) return 0;
    const first = alignedStops[0];
    const last = alignedStops[alignedStops.length - 1];
    const totalTrip = Math.max(1, last.simArrMins - first.simDepMins);
    return Math.max(0, Math.min(1, (liveTime - first.simDepMins) / totalTrip));
  }, [alignedStops, liveTime]);

  const legProgress = useMemo(() => {
    if (!currentStatus || currentStatus.state !== "transit" || !alignedStops) return 0;
    const curr = alignedStops[currentStatus.fromIdx];
    const next = alignedStops[currentStatus.toIdx];
    const legDur = Math.max(1, next.simArrMins - curr.simDepMins);
    return Math.max(0, Math.min(1, (liveTime - curr.simDepMins) / legDur));
  }, [currentStatus, alignedStops, liveTime]);

  if (!code) return null;

  const cls = trainVM ? trainVM.cls : code.charAt(0);
  const isHighSpeed = cls === "G" || cls === "D" || cls === "C";
  const codeClass = "tsm-code" + (isHighSpeed ? " is-hs" : "");
  const route = trainVM ? `${originStDisplay} ➔ ${destStDisplay}` : null;
  const legDist = (km: number) =>
    unit === "mi" ? `${(km * 0.621371).toFixed(1)} mi` : `${km} km`;

  // Minimized floating dock pill (not modal: the map stays usable)
  if (minimized) {
    return (
      <div
        className={"tsm-hud" + (isIsolated ? " is-isolated" : "")}
        role="dialog"
        aria-label={`Train ${code} schedule (minimized)`}
      >
        <span className={codeClass}>{code}</span>
        <div className="tsm-hud-main">
          <div className="tsm-hud-route">{route ?? code}</div>
          {currentStatus && (
            <div className="tsm-hud-status">{currentStatus.text}</div>
          )}
        </div>
        <button
          type="button"
          className="tsm-hud-expand"
          onClick={() => setMinimized(false)}
          title="Expand timetable"
        >
          ⤢ Timetable
        </button>
        <button
          type="button"
          className="tsm-hud-close"
          onClick={onClose}
          title="Close modal"
          aria-label="Close timetable"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <ModalShell
      className={"tsm-dialog" + (isIsolated ? " is-isolated" : "")}
      titleId={titleId}
      onClose={onClose}
    >
      {/* Header */}
      <div className="tsm-head">
        <div className="tsm-head-id">
          <span className={codeClass}>{code}</span>
          <div className="tsm-head-main">
            <div className="tsm-title" id={titleId}>
              {route ?? `Train ${code} Schedule`}
            </div>
            <div className="tsm-subtitle">
              {trainVM ? `Dep ${trainVM.dep} · Arr ${trainVM.arr} (${Math.floor(trainVM.dur / 60)}h ${trainVM.dur % 60}m)` : "Full Station Timetable"}
            </div>
            {trainRow?.days ? (
              <div className="tsm-subtitle">
                Runs <RunsLabel days={trainRow.days} pattern={trainRow.pattern} calendar={calendar} />
              </div>
            ) : null}
          </div>
        </div>

        {/* Action buttons */}
        <div className="tsm-head-actions">
          <button
            type="button"
            className="tsm-icon-btn"
            onClick={() => setMinimized(true)}
            title="Minimize to floating HUD"
            aria-label="Minimize timetable"
          >
            —
          </button>
          <button
            type="button"
            className="tsm-icon-btn is-close"
            onClick={onClose}
            title="Close modal (Esc)"
            aria-label="Close timetable"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Toolbar: Isolate on map + Jump to departure */}
      <div className="tsm-toolbar">
        <div className="tsm-toolbar-left">
          {direction !== "in" && onToggleIsolate && (
            <button
              type="button"
              className={"tsm-iso-btn" + (isIsolated ? " is-on" : "")}
              onClick={() => onToggleIsolate(code)}
            >
              {isIsolated ? "✕ Show all trains" : "🎯 Isolate on Map"}
            </button>
          )}

          {direction !== "in" && trainVM && onJumpToTime && (
            <button
              type="button"
              className="tsm-jump-btn"
              onClick={() => onJumpToTime(trainVM.depMins)}
              title={`Jump simulation time to ${trainVM.dep}`}
            >
              ▶ Jump to dep ({trainVM.dep})
            </button>
          )}
          {originStop && (
            <span className="tsm-origin-chip">
              <span>📍</span>
              <span>
                {fmtStName(originStop.stZh, originStop.stEn)}: {originStop.arr !== "—" ? `Arr ${originStop.arr} · ` : ""}Dep {originStop.dep}
                {originStop.dwellMins > 0 ? ` (${originStop.dwellMins}m dwell)` : ""}
              </span>
            </span>
          )}
        </div>

        {currentStatus && <span className="tsm-status">{currentStatus.text}</span>}
      </div>

      {/* Live Journey Progress Track */}
      {direction !== "in" && alignedStops && alignedStops.length > 0 && (
        <div className="tsm-progress">
          <div className="tsm-progress-head">
            <div className="tsm-progress-state">
              <span className="tsm-progress-icon">
                {currentStatus?.state === "stopped"
                  ? "🚆"
                  : currentStatus?.state === "transit"
                    ? "🚅"
                    : currentStatus?.state === "post"
                      ? "🏁"
                      : "⏳"}
              </span>
              <span>{currentStatus?.text || "Trip Progress"}</span>
            </div>
            <span className="tsm-progress-pct">
              {Math.round(overallProgress * 100)}%
            </span>
          </div>
          <div className="tsm-track">
            <div
              className="tsm-track-fill"
              style={{ width: `${Math.round(overallProgress * 100)}%` }}
            />
            <div
              className="tsm-track-train"
              style={{ left: `${Math.round(overallProgress * 100)}%` }}
            >
              🚅
            </div>
          </div>
        </div>
      )}

      {/* Timetable Table */}
      <div className="tsm-scroll">
        {!alignedStops ? (
          <div className="tsm-empty">
            {schedulesData ? "Schedule not available for this service." : "Loading national timetable asset (~336 KB)..."}
          </div>
        ) : (
          <table className="tsm-table">
            <thead>
              <tr>
                <th className="tsm-th-idx">#</th>
                <th className="tsm-th-l">Station</th>
                <th className="tsm-th-r">Distance</th>
                <th className="tsm-th-c">Arrive</th>
                <th className="tsm-th-c">Depart</th>
                <th className="tsm-th-r">Dwell</th>
              </tr>
            </thead>
            <tbody>
              {alignedStops.flatMap((s, idx) => {
                const isOriginCity = originStop && s.stIdx === originStop.stIdx;
                const isCurrent =
                  typeof liveTime === "number" &&
                  s.simArrMins >= 0 &&
                  s.simDepMins >= 0 &&
                  liveTime >= s.simArrMins &&
                  liveTime <= s.simDepMins;
                const isPast =
                  typeof liveTime === "number" &&
                  s.simDepMins >= 0 &&
                  liveTime > s.simDepMins;
                const isNextStop =
                  currentStatus?.state === "transit" &&
                  currentStatus.toIdx === idx;

                const jumpTime = s.simArrMins >= 0 ? s.simArrMins : s.simDepMins;
                const rowClass =
                  "tsm-row" +
                  (onJumpToTime ? " is-jumpable" : "") +
                  (isCurrent ? " is-current" : "") +
                  (isOriginCity ? " is-origin" : "") +
                  (isPast && !isOriginCity ? " is-past" : "");
                const timePill = isOriginCity ? "tsm-time-pill" : undefined;

                const rows = [
                  <tr
                    key={`stop-${idx}`}
                    className={rowClass}
                    onClick={() => {
                      if (jumpTime !== undefined && onJumpToTime) {
                        onJumpToTime(Math.max(0, jumpTime));
                      }
                    }}
                    title={onJumpToTime ? `Click to jump simulation to ${fmtStName(s.stZh, s.stEn)} (${s.arr !== "—" ? s.arr : s.dep})` : undefined}
                  >
                    <td className="tsm-cell-idx">
                      {isCurrent ? (
                        <span className="tsm-mark-now">🚆</span>
                      ) : isPast ? (
                        <span className="tsm-mark-past">✓</span>
                      ) : isNextStop ? (
                        <span className="tsm-mark-next">▶</span>
                      ) : (
                        <span className="tsm-mark-num">{idx + 1}</span>
                      )}
                    </td>
                    <td>
                      <div className="tsm-st-zh">
                        {s.stZh}
                        {isOriginCity && (
                          <span className="tsm-tag is-origin">📍 SELECTED ORIGIN</span>
                        )}
                        {isCurrent && (
                          <span className="tsm-tag is-now">🚆 AT STATION (NOW)</span>
                        )}
                        {isNextStop && (
                          <span className="tsm-tag is-next">
                            NEXT STOP (ETA {currentStatus?.eta}m)
                          </span>
                        )}
                      </div>
                      {s.stEn && s.stEn !== s.stZh && (
                        <div className="tsm-st-en">{s.stEn}</div>
                      )}
                    </td>
                    <td className="tsm-cell-dist">
                      {idx === 0 ? (
                        <span className="tsm-dim">—</span>
                      ) : s.legKm && s.legKm > 0 ? (
                        legDist(s.legKm)
                      ) : (
                        <span className="tsm-dim">—</span>
                      )}
                    </td>
                    <td className="tsm-cell-time">
                      <span className={timePill}>{s.arr}</span>
                    </td>
                    <td className="tsm-cell-time is-dep">
                      <span className={timePill}>{s.dep}</span>
                    </td>
                    <td className="tsm-cell-dwell">
                      {s.dwellMins > 0 ? `${s.dwellMins}m` : "—"}
                    </td>
                  </tr>
                ];

                // In transit between idx and idx + 1: insert transit tracker row
                if (
                  currentStatus?.state === "transit" &&
                  currentStatus.fromIdx === idx &&
                  idx < alignedStops.length - 1
                ) {
                  const next = alignedStops[idx + 1];
                  rows.push(
                    <tr key={`transit-leg-${idx}`} className="tsm-transit-row">
                      <td colSpan={6}>
                        <div className="tsm-transit-body">
                          <span className="tsm-transit-icon">🚅</span>
                          <div className="tsm-transit-main">
                            <div className="tsm-transit-head">
                              <span>
                                EN ROUTE: {fmtStName(s.stZh, s.stEn)} ➔ {fmtStName(next.stZh, next.stEn)}
                                {next.legKm && next.legKm > 0 ? (
                                  <span className="tsm-transit-km">
                                    ({legDist(next.legKm)})
                                  </span>
                                ) : null}
                              </span>
                              <span>
                                {Math.round(legProgress * 100)}% · {currentStatus.eta}m to arrival
                              </span>
                            </div>
                            <div className="tsm-transit-track">
                              <div
                                className="tsm-transit-fill"
                                style={{ width: `${Math.round(legProgress * 100)}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                }

                return rows;
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="tsm-foot">
        <span>Tip: Click any station row to jump simulation time</span>
        <span>{alignedStops ? `${alignedStops.length} calling stops` : ""}</span>
      </div>
    </ModalShell>
  );
}

/* The modal frame: backdrop (click closes), a labelled aria-modal dialog,
   focus moved in on open, Tab kept inside and focus restored on close. */
function ModalShell({
  className,
  titleId,
  onClose,
  children,
}: {
  className: string;
  titleId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { onKeyDown } = useDialogFocus(ref);
  return (
    <div className="tsm-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
