import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { DepVM, ArrVM, DistUnit, RawTrain, SchedulesData, ScheduleStop } from "../types";
import { RunsLabel } from "./departures/RunsCell";
import type { MapApi } from "./MapCanvas";
import { formatScheduleStops } from "../lib";
import { TrainCard, cardBand, cardStName, type TrainCardState } from "./MapCards";
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
  /** "Play from origin": the clock at the train's departure, the animation open and running. */
  onPlayFrom?: (mins: number) => void;
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

/** "Wuchang 武昌": the English name then the Chinese one. */
function fmtShort(en: string | undefined, zh: string): string {
  return en && en !== zh ? `${en} ${zh}` : zh;
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
  onPlayFrom,
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

  // In the origin view the journey runs from the selected origin's stop (the
  // stops before it are still listed); in national mode, from the first stop.
  const startIdx =
    originStop && alignedStops ? Math.max(0, alignedStops.findIndex((s) => s.stIdx === originStop.stIdx)) : 0;
  const overallProgress = useMemo(() => {
    if (!alignedStops || alignedStops.length === 0) return 0;
    const first = alignedStops[startIdx];
    const last = alignedStops[alignedStops.length - 1];
    const totalTrip = Math.max(1, last.simArrMins - first.simDepMins);
    return Math.max(0, Math.min(1, (liveTime - first.simDepMins) / totalTrip));
  }, [alignedStops, liveTime, startIdx]);

  const legProgress = useMemo(() => {
    if (!currentStatus || currentStatus.state !== "transit" || !alignedStops) return 0;
    const curr = alignedStops[currentStatus.fromIdx];
    const next = alignedStops[currentStatus.toIdx];
    const legDur = Math.max(1, next.simArrMins - curr.simDepMins);
    return Math.max(0, Math.min(1, (liveTime - curr.simDepMins) / legDur));
  }, [currentStatus, alignedStops, liveTime]);

  // The timetable scrolls; the footer says which stops are in view, and the
  // list opens on the train's current position.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [win, setWin] = useState<[number, number]>([1, 1]);
  const rowTop = (el: HTMLElement, r: HTMLElement) =>
    r.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  const updateWindow = () => {
    const el = scrollRef.current;
    if (!el) return;
    const head = el.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    let a = 0, b = 0;
    el.querySelectorAll<HTMLElement>("tr[data-stop]").forEach((r) => {
      const mid = rowTop(el, r) + r.offsetHeight / 2;
      if (mid >= el.scrollTop + head && mid <= el.scrollTop + el.clientHeight) {
        const i = Number(r.dataset.stop) + 1;
        if (!a) a = i;
        b = i;
      }
    });
    if (a) setWin((w) => (w[0] === a && w[1] === b ? w : [a, b]));
  };
  const openedOn = useRef<string | null>(null);
  const focusIdx = !currentStatus
    ? 0
    : currentStatus.state === "stopped"
      ? currentStatus.stopIdx
      : currentStatus.state === "transit"
        ? currentStatus.fromIdx
        : currentStatus.state === "post" && alignedStops
          ? alignedStops.length - 1
          : 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !alignedStops || openedOn.current === code) {
      updateWindow();
      return;
    }
    openedOn.current = code;
    // Start the window two stops above the current one, its first row flush
    // under the sticky column header (not cut by it).
    const row = el.querySelector<HTMLElement>(`tr[data-stop="${Math.max(0, focusIdx - 2)}"]`);
    const head = el.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    if (row) el.scrollTop = Math.max(0, rowTop(el, row) - head);
    updateWindow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, alignedStops, minimized]);

  if (!code) return null;

  const cls = trainVM ? trainVM.cls : code.charAt(0);
  const isHighSpeed = cls === "G" || cls === "D" || cls === "C";
  const codeClass = "tsm-code" + (isHighSpeed ? " is-hs" : "");
  const route = trainVM ? `${originStDisplay} ➔ ${destStDisplay}` : null;
  const legDist = (km: number) =>
    unit === "mi" ? `${(km * 0.621371).toFixed(1)} mi` : `${km} km`;

  // Minimized floating train card (not modal: the map stays usable)
  if (minimized) {
    const st = alignedStops;
    const nm = (i: number) => (st ? cardStName(st[i].stZh, st[i].stEn) : "");
    let state: TrainCardState = "en-route";
    let leg = "";
    if (currentStatus && st) {
      if (currentStatus.state === "transit") {
        leg = `${nm(currentStatus.fromIdx)} → ${nm(currentStatus.toIdx)}`;
      } else if (currentStatus.state === "stopped") {
        state = "stopped";
        leg = nm(currentStatus.stopIdx);
      } else if (currentStatus.state === "pre") {
        state = "not-departed";
        leg = `departs ${st[0].dep}`;
      } else {
        state = "arrived";
        leg = nm(st.length - 1);
      }
    }
    return (
      <TrainCard
        code={code}
        route={
          trainVM
            ? `${cardStName(trainVM.fsZh || "", trainVM.fsEn)} → ${cardStName(trainVM.tsZh || "", trainVM.tsEn)}`
            : st && st.length > 1
              ? `${nm(0)} → ${nm(st.length - 1)}`
              : code
        }
        state={state}
        leg={leg}
        band={cardBand(trainVM ? trainVM.dur : 0, dark)}
        isolated={isIsolated}
        onTimetable={() => setMinimized(false)}
        onClose={onClose}
        closeLabel="Close timetable"
        ariaLabel={`Train ${code} schedule (minimized)`}
      />
    );
  }

  const n = alignedStops ? alignedStops.length : 0;
  const firstStop = alignedStops && n > 0 ? alignedStops[startIdx] : null;
  const lastStop = alignedStops && n > 0 ? alignedStops[n - 1] : null;
  const pct = Math.round(overallProgress * 100);
  const nameOf = (s: { stZh: string; stEn: string }) => (s.stEn && s.stEn !== s.stZh ? `${s.stEn} ${s.stZh}` : s.stZh);
  const durText = (m: number) => {
    const r = Math.max(0, Math.round(m));
    return r >= 60 ? `${Math.floor(r / 60)} h ${r % 60 ? (r % 60) + " min" : ""}`.trim() : `${r} min`;
  };
  // The class badge and the number: "T145" -> T + 145; a plain train has no letter.
  const badge = cls === "plain" ? "普" : cls;
  const number = code.startsWith(cls) && cls !== "plain" ? code.slice(cls.length) : code;
  // Where each stop sits along the journey (0..1), for the progress bar ticks.
  const total = firstStop && lastStop ? Math.max(1, lastStop.simArrMins - firstStop.simDepMins) : 1;
  const ticks = alignedStops
    ? alignedStops.slice(startIdx + 1, -1).map((s) => (Math.max(s.simArrMins, s.simDepMins) - (firstStop?.simDepMins ?? 0)) / total)
    : [];
  // The "now" block's state, honestly: before departure, at a station, between stops, arrived.
  const st = currentStatus;
  const now = (() => {
    if (!alignedStops || !firstStop || !lastStop) return null;
    const dest = `Arrives ${lastStop.stEn || lastStop.stZh} ${lastStop.arr}`;
    if (!st || st.state === "pre") {
      const run0 = alignedStops[0];
      const wait = Math.max(0, Math.round(run0.simDepMins - liveTime));
      return { label: "Not yet departed", title: nameOf(run0), sub: `Leaves ${run0.dep} · in ${durText(wait)}`, pct: 0 };
    }
    if (st.state === "post") return { label: "Arrived", title: nameOf(lastStop), sub: `Arrived ${lastStop.arr}`, pct: 100 };
    if (st.state === "stopped") {
      const s = alignedStops[st.stopIdx];
      return { label: "At station", title: nameOf(s), sub: `${st.text.split(" · ")[1] ?? ""} · ${dest}`, pct };
    }
    const a = alignedStops[st.fromIdx], b = alignedStops[st.toIdx];
    return { label: "En route", title: `${nameOf(a)} → ${nameOf(b)}`, sub: `${dest} · in ${st.finalEtaStr}`, pct };
  })();

  return (
    <ModalShell
      className={"tsm-dialog sg" + (isIsolated ? " is-isolated" : "")}
      titleId={titleId}
      onClose={onClose}
    >
      <header className="sg-head">
        <span className={"sg-badge" + (isHighSpeed ? " is-hs" : "")} aria-hidden="true">{badge}</span>
        <span className="sg-num">{number}</span>
        <div className="sg-title-block">
          <h2 className="sg-title" id={titleId}>
            {trainVM ? `${fmtShort(trainVM.fsEn, trainVM.fsZh)} → ${fmtShort(trainVM.tsEn, trainVM.tsZh)}` : `Train ${code}`}
          </h2>
          <p className="sg-sub">
            {trainVM ? (
              <>
                Dep <b>{trainVM.dep}</b> · Arr <b>{trainVM.arr}</b> · {durText(trainVM.dur)}
                {n > 0 ? ` · ${n} calling stops` : ""}
              </>
            ) : (
              "Full station timetable"
            )}
          </p>
          {trainRow?.days ? (
            <p className="sg-sub">
              Runs <RunsLabel days={trainRow.days} pattern={trainRow.pattern} calendar={calendar} />
            </p>
          ) : null}
        </div>
        <div className="sg-win">
          <button type="button" onClick={() => setMinimized(true)} title="Minimize to floating HUD" aria-label="Minimize timetable">
            –
          </button>
          <button type="button" onClick={onClose} title="Close (Esc)" aria-label="Close timetable">
            ✕
          </button>
        </div>
      </header>

      {(onToggleIsolate || (trainVM && (onPlayFrom || onJumpToTime))) && direction !== "in" && (
        <div className="sg-actions">
          {onToggleIsolate && (
            <button type="button" className={"sg-btn" + (isIsolated ? " is-on" : "")} onClick={() => onToggleIsolate(code)}>
              {isIsolated ? "✕ Show all trains" : "◎ Isolate on map"}
            </button>
          )}
          {trainVM && (onPlayFrom || onJumpToTime) && (
            <button
              type="button"
              className="sg-btn is-primary"
              onClick={() => {
                if (onPlayFrom) {
                  onPlayFrom(trainVM.depMins);
                  setMinimized(true); // the train card; the map stays unobscured
                } else onJumpToTime?.(trainVM.depMins);
              }}
              title={`Start the clock at ${trainVM.dep} and play`}
            >
              ▶ Play from origin · {trainVM.dep}
            </button>
          )}
        </div>
      )}

      {originStop && (
        <div className="sg-origin">
          <span className="sg-kicker">Your origin</span>
          <span>
            <b>{fmtShort(originStop.stEn, originStop.stZh)}</b>
            {originStop.arr !== "—" ? ` · arr ${originStop.arr}` : ""} · dep {originStop.dep}
            {originStop.dwellMins > 0 ? ` · ${originStop.dwellMins} min dwell` : ""}
          </span>
        </div>
      )}

      {direction !== "in" && now && firstStop && lastStop && (
        <section className={"sg-now is-" + (st?.state ?? "pre")} aria-live="polite">
          <div className="sg-now-row">
            <div className="sg-now-text">
              <div className="sg-kicker is-red">{now.label}</div>
              <div className="sg-now-title">{now.title}</div>
              <div className="sg-now-sub">{now.sub}</div>
            </div>
            <div className="sg-pct">
              <b>{now.pct}</b>
              <span>%</span>
              <small>of journey</small>
            </div>
          </div>
          <div className="sg-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={now.pct}>
            <div className="sg-bar-fill" style={{ width: `${now.pct}%` }} />
            <i className="sg-tick is-end" style={{ left: "0%" }} />
            {ticks.map((t, i) => (
              <i key={i} className="sg-tick" style={{ left: `${Math.max(0, Math.min(1, t)) * 100}%` }} />
            ))}
            <i className="sg-tick is-end" style={{ left: "100%" }} />
            <i className="sg-bar-mark" style={{ left: `${now.pct}%` }} />
          </div>
          <div className="sg-bar-labels">
            <span>{firstStop.dep} {firstStop.stEn || firstStop.stZh}</span>
            <span>{lastStop.stEn || lastStop.stZh} {lastStop.arr}</span>
          </div>
        </section>
      )}

      <div className="sg-scroll" ref={scrollRef} onScroll={updateWindow}>
        {!alignedStops ? (
          <div className="tsm-empty">
            {schedulesData ? "Schedule not available for this service." : "Loading the timetable…"}
          </div>
        ) : (
          <table className="sg-table">
            <thead>
              <tr>
                <th className="sg-c-idx">#</th>
                <th className="sg-c-st">Station</th>
                <th className="sg-c-n">Leg</th>
                <th className="sg-c-n">Arr</th>
                <th className="sg-c-n">Dep</th>
                <th className="sg-c-n">Stop</th>
              </tr>
            </thead>
            <tbody>
              {alignedStops.flatMap((s, idx) => {
                const isOriginCity = !!originStop && s.stIdx === originStop.stIdx;
                const isCurrent = st?.state === "stopped" && st.stopIdx === idx;
                const isPast = s.simDepMins >= 0 ? liveTime > s.simDepMins : liveTime >= s.simArrMins;
                const isNext = st?.state === "transit" && st.toIdx === idx;
                const jumpTime = s.simArrMins >= 0 ? s.simArrMins : s.simDepMins;
                const rows = [
                  <tr
                    key={`stop-${idx}`}
                    data-stop={idx}
                    className={
                      "sg-row" +
                      (onJumpToTime ? " is-jumpable" : "") +
                      (isOriginCity ? " is-origin" : "") +
                      (isCurrent ? " is-current" : "") +
                      (isNext ? " is-next" : "") +
                      (isPast && !isCurrent ? " is-past" : "")
                    }
                    onClick={() => {
                      if (onJumpToTime) onJumpToTime(Math.max(0, jumpTime));
                    }}
                    title={onJumpToTime ? `Jump the simulation to ${fmtStName(s.stZh, s.stEn)} (${s.arr !== "—" ? s.arr : s.dep})` : undefined}
                  >
                    <td className="sg-c-idx">
                      {isNext ? <span className="sg-next-mark">▶</span> : isPast || isCurrent ? <span className="sg-check">✓</span> : idx + 1}
                    </td>
                    <td className="sg-c-st">
                      <div className="sg-zh">
                        {s.stZh}
                        {isOriginCity && <span className="sg-chip is-solid">Your origin</span>}
                        {isCurrent && <span className="sg-chip">At station</span>}
                        {isNext && <span className="sg-chip">Next stop · {st?.state === "transit" ? st.eta : 0} min</span>}
                      </div>
                      {s.stEn && s.stEn !== s.stZh && <div className="sg-en">{s.stEn}</div>}
                    </td>
                    <td className="sg-c-n">{idx > 0 && (s.legKm ?? 0) > 0 ? legDist(s.legKm!) : "—"}</td>
                    <td className="sg-c-n">{s.arr}</td>
                    <td className="sg-c-n is-dep">{s.dep}</td>
                    <td className="sg-c-n sg-dwell">{s.dwellMins > 0 ? `${s.dwellMins} min` : "—"}</td>
                  </tr>,
                ];
                // Between the last stop passed and the next: where the train is on this leg.
                if (st?.state === "transit" && st.fromIdx === idx && idx < n - 1) {
                  const next = alignedStops[idx + 1];
                  const lp = Math.round(legProgress * 100);
                  rows.push(
                    <tr key={`now-${idx}`} className="sg-legrow">
                      <td colSpan={6}>
                        <div className="sg-leg-head">
                          <span className="sg-kicker is-red">
                            Now{(next.legKm ?? 0) > 0 ? ` · ${legDist(next.legKm!)} leg` : ""}
                          </span>
                          <span>
                            <b>{lp}%</b> · {durText(st.eta)} to {next.stEn || next.stZh}
                          </span>
                        </div>
                        <div className="sg-bar is-leg">
                          <div className="sg-bar-fill" style={{ width: `${lp}%` }} />
                          <i className="sg-bar-mark" style={{ left: `${lp}%` }} />
                        </div>
                      </td>
                    </tr>,
                  );
                }
                return rows;
              })}
            </tbody>
          </table>
        )}
      </div>

      <footer className="sg-foot">
        <span>{onJumpToTime ? "Select a station to jump the simulation to it" : ""}</span>
        <span>{n > 0 ? `Stops ${win[0]} to ${Math.min(win[1], n)} of ${n}` : ""}</span>
      </footer>
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
