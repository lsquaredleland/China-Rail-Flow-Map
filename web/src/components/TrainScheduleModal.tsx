import { useEffect, useMemo, useState, type RefObject } from "react";
import type { DepVM, ArrVM, DistUnit, SchedulesData, ScheduleStop } from "../types";
import type { MapApi } from "./MapCanvas";
import { formatScheduleStops } from "../lib";

interface Props {
  code: string | null;
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
  onClose,
  schedulesData,
  stationTable,
  dark,
  unit = "km",
  trainVM,
  currentTime,
  isIsolated = false,
  onToggleIsolate,
  onJumpToTime,
  mapRef,
  originCityZh,
  originCityEn,
}: Props) {
  const [minimized, setMinimized] = useState(false);
  const [liveTime, setLiveTime] = useState<number>(() => currentTime ?? 360);

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
    if (!code || !schedulesData) return null;
    return formatScheduleStops(schedulesData, stationTable, code);
  }, [code, schedulesData, stationTable]);

  // Identify the station corresponding to the currently selected city (e.g. Guangzhou, Wuhan, Beijing)
  const originStationZh = trainVM
    ? ((trainVM as any).fsZh || (trainVM as any).tsZh || "")
    : "";

  const originStDisplay = trainVM
    ? fmtStName((trainVM as any).fsZh || "", (trainVM as any).fsEn)
    : "";
  const destStDisplay = trainVM
    ? fmtStName((trainVM as any).tsZh || "", (trainVM as any).tsEn)
    : "";

  const originStop = useMemo(() => {
    if (!stops) return null;
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
  }, [stops, originStationZh, originCityZh, originCityEn]);

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
      const isArrVM =
        (trainVM as any).depMins === undefined && (trainVM as any).arrMins !== undefined;
      if (isArrVM && anchor.unrolledArr >= 0) {
        timeShift = (trainVM as any).arrMins - anchor.unrolledArr;
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
  const badgeColor = isHighSpeed ? "#F59E0B" : "#0284C7";

  // Minimized floating dock pill
  if (minimized) {
    return (
      <div
        style={{
          position: "fixed",
          bottom: "90px",
          right: "24px",
          zIndex: 200,
          background: dark ? "rgba(17, 24, 39, 0.94)" : "rgba(255, 255, 255, 0.96)",
          color: dark ? "#F3F4F6" : "#111827",
          borderRadius: "14px",
          boxShadow: "0 10px 30px rgba(0, 0, 0, 0.35)",
          border: `1px solid ${isIsolated ? "#F59E0B" : dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.12)"}`,
          backdropFilter: "blur(12px)",
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          maxWidth: "460px",
        }}
      >
        <span
          style={{
            background: badgeColor,
            color: "#FFFFFF",
            fontWeight: 800,
            fontSize: "12px",
            padding: "3px 7px",
            borderRadius: "5px",
            fontFamily: "monospace",
          }}
        >
          {code}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: "12px", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {trainVM ? `${originStDisplay} ➔ ${destStDisplay}` : code}
          </div>
          {currentStatus && (
            <div style={{ fontSize: "11px", color: isIsolated ? "#F59E0B" : dark ? "#9CA3AF" : "#64748B", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {currentStatus.text}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setMinimized(false)}
          title="Expand timetable"
          style={{
            background: dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.06)",
            border: "none",
            borderRadius: "6px",
            padding: "4px 8px",
            cursor: "pointer",
            color: "inherit",
            fontSize: "12px",
            fontWeight: 600,
          }}
        >
          ⤢ Timetable
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close modal"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: dark ? "#9CA3AF" : "#64748B",
            fontSize: "14px",
            padding: "2px 4px",
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(4px)",
        padding: "16px",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "540px",
          maxHeight: "86vh",
          background: dark ? "#111827" : "#FFFFFF",
          color: dark ? "#F3F4F6" : "#111827",
          borderRadius: "16px",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.45)",
          border: `1px solid ${isIsolated ? "#F59E0B" : dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)"}`,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)"}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0, flex: 1 }}>
            <span
              style={{
                background: badgeColor,
                color: "#FFFFFF",
                fontWeight: 800,
                fontSize: "15px",
                padding: "4px 9px",
                borderRadius: "6px",
                fontFamily: "monospace",
                flexShrink: 0,
              }}
            >
              {code}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: "16px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {trainVM ? `${originStDisplay} ➔ ${destStDisplay}` : `Train ${code} Schedule`}
              </div>
              <div
                style={{
                  fontSize: "12px",
                  color: dark ? "#9CA3AF" : "#64748B",
                  marginTop: "2px",
                }}
              >
                {trainVM ? `Dep ${trainVM.dep} · Arr ${trainVM.arr} (${Math.floor(trainVM.dur / 60)}h ${trainVM.dur % 60}m)` : "Full Station Timetable"}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setMinimized(true)}
              title="Minimize to floating HUD"
              style={{
                background: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)",
                border: "none",
                color: dark ? "#E5E7EB" : "#374151",
                fontSize: "14px",
                width: "32px",
                height: "32px",
                borderRadius: "8px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              —
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close modal (Esc)"
              style={{
                background: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)",
                border: "none",
                color: dark ? "#E5E7EB" : "#374151",
                fontSize: "16px",
                width: "32px",
                height: "32px",
                borderRadius: "8px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Toolbar: Isolate on map + Jump to departure */}
        <div
          style={{
            padding: "8px 20px",
            background: dark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)",
            borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)"}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {onToggleIsolate && (
              <button
                type="button"
                onClick={() => onToggleIsolate(code)}
                style={{
                  background: isIsolated ? "#F59E0B" : dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.06)",
                  color: isIsolated ? "#000000" : "inherit",
                  border: isIsolated ? "1px solid #D97706" : "none",
                  fontWeight: 700,
                  fontSize: "12px",
                  padding: "5px 12px",
                  borderRadius: "6px",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                {isIsolated ? "✕ Show all trains" : "🎯 Isolate on Map"}
              </button>
            )}

            {trainVM && onJumpToTime && (
              <button
                type="button"
                onClick={() => onJumpToTime(trainVM.depMins)}
                title={`Jump simulation time to ${trainVM.dep}`}
                style={{
                  background: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)",
                  color: "inherit",
                  border: "none",
                  fontSize: "12px",
                  fontWeight: 600,
                  padding: "5px 10px",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                ▶ Jump to dep ({trainVM.dep})
              </button>
            )}
            {originStop && (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  padding: "4px 9px",
                  borderRadius: "6px",
                  background: dark
                    ? "rgba(59, 130, 246, 0.25)"
                    : "rgba(59, 130, 246, 0.15)",
                  color: dark ? "#93C5FD" : "#1D4ED8",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  border: `1px solid ${dark ? "rgba(59, 130, 246, 0.4)" : "rgba(59, 130, 246, 0.3)"}`,
                }}
              >
                <span>📍</span>
                <span>
                  {fmtStName(originStop.stZh, originStop.stEn)}: {originStop.arr !== "—" ? `Arr ${originStop.arr} · ` : ""}Dep {originStop.dep}
                  {originStop.dwellMins > 0 ? ` (${originStop.dwellMins}m dwell)` : ""}
                </span>
              </span>
            )}
          </div>

          {currentStatus && (
            <span
              style={{
                fontSize: "11px",
                fontWeight: 600,
                color: isIsolated ? "#F59E0B" : dark ? "#9CA3AF" : "#64748B",
              }}
            >
              {currentStatus.text}
            </span>
          )}
        </div>

        {/* Live Journey Progress Track */}
        {alignedStops && alignedStops.length > 0 && (
          <div
            style={{
              padding: "10px 20px 12px 20px",
              background: dark ? "rgba(0,0,0,0.24)" : "rgba(0,0,0,0.02)",
              borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)"}`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: "12px",
                fontWeight: 700,
                marginBottom: "6px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "15px" }}>
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
              <span
                style={{
                  fontFamily: "monospace",
                  fontWeight: 800,
                  fontSize: "13px",
                  color: "#F59E0B",
                }}
              >
                {Math.round(overallProgress * 100)}%
              </span>
            </div>
            <div
              style={{
                position: "relative",
                width: "100%",
                height: "6px",
                background: dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)",
                borderRadius: "3px",
              }}
            >
              <div
                style={{
                  width: `${Math.round(overallProgress * 100)}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, #3B82F6 0%, #F59E0B 100%)",
                  borderRadius: "3px",
                  transition: "width 0.25s ease",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: `${Math.round(overallProgress * 100)}%`,
                  top: "-8px",
                  transform: "translateX(-50%)",
                  fontSize: "14px",
                  transition: "left 0.25s ease",
                  pointerEvents: "none",
                  filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.5))",
                }}
              >
                🚅
              </div>
            </div>
          </div>
        )}

        {/* Timetable Table */}
        <div style={{ overflowY: "auto", flex: 1, padding: "4px 0" }}>
          {!alignedStops ? (
            <div style={{ padding: "36px", textAlign: "center", color: dark ? "#9CA3AF" : "#64748B" }}>
              {schedulesData ? "Schedule not available for this service." : "Loading national timetable asset (~336 KB)..."}
            </div>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "13px",
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)"}`,
                    color: dark ? "#9CA3AF" : "#64748B",
                    fontSize: "11px",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  <th style={{ padding: "8px 16px", textAlign: "center", width: "40px" }}>#</th>
                  <th style={{ padding: "8px 16px", textAlign: "left" }}>Station</th>
                  <th style={{ padding: "8px 16px", textAlign: "right" }}>Distance</th>
                  <th style={{ padding: "8px 16px", textAlign: "center" }}>Arrive</th>
                  <th style={{ padding: "8px 16px", textAlign: "center" }}>Depart</th>
                  <th style={{ padding: "8px 16px", textAlign: "right" }}>Dwell</th>
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

                  const rows = [
                    <tr
                      key={`stop-${idx}`}
                      onClick={() => {
                        if (jumpTime !== undefined && onJumpToTime) {
                          onJumpToTime(Math.max(0, jumpTime));
                        }
                      }}
                      title={onJumpToTime ? `Click to jump simulation to ${fmtStName(s.stZh, s.stEn)} (${s.arr !== "—" ? s.arr : s.dep})` : undefined}
                      style={{
                        borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)"}`,
                        borderLeft: isOriginCity
                          ? "4px solid #3B82F6"
                          : isCurrent
                            ? "4px solid #F59E0B"
                            : "4px solid transparent",
                        background: isCurrent
                          ? dark
                            ? "rgba(245, 158, 11, 0.26)"
                            : "rgba(245, 158, 11, 0.18)"
                          : isOriginCity
                            ? dark
                              ? "rgba(59, 130, 246, 0.18)"
                              : "rgba(59, 130, 246, 0.12)"
                            : "transparent",
                        cursor: onJumpToTime ? "pointer" : "default",
                        transition: "background 0.15s ease",
                      }}
                      onMouseEnter={(e) => {
                        if (!isCurrent && !isOriginCity) {
                          e.currentTarget.style.background = dark
                            ? "rgba(255,255,255,0.04)"
                            : "rgba(0,0,0,0.03)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isCurrent && !isOriginCity) {
                          e.currentTarget.style.background = "transparent";
                        }
                      }}
                    >
                      <td
                        style={{
                          padding: "9px 16px",
                          textAlign: "center",
                          color: dark ? "#6B7280" : "#94A3B8",
                          fontFamily: "monospace",
                          fontSize: "12px",
                        }}
                      >
                        {isCurrent ? (
                          <span style={{ fontSize: "16px" }}>🚆</span>
                        ) : isPast ? (
                          <span style={{ color: "#10B981", fontWeight: 800 }}>✓</span>
                        ) : isNextStop ? (
                          <span style={{ color: "#F59E0B", fontWeight: 800 }}>▶</span>
                        ) : (
                          <span style={{ opacity: 0.6 }}>{idx + 1}</span>
                        )}
                      </td>
                      <td style={{ padding: "9px 16px" }}>
                        <div style={{ fontWeight: 600, color: isPast && !isOriginCity ? (dark ? "#6B7280" : "#94A3B8") : "inherit" }}>
                          {s.stZh}
                          {isOriginCity && (
                            <span
                              style={{
                                marginLeft: "8px",
                                fontSize: "10px",
                                fontWeight: 800,
                                padding: "2px 6px",
                                borderRadius: "4px",
                                background: "#3B82F6",
                                color: "#FFFFFF",
                                letterSpacing: "0.5px",
                                display: "inline-block",
                              }}
                            >
                              📍 SELECTED ORIGIN
                            </span>
                          )}
                          {isCurrent && (
                            <span
                              style={{
                                marginLeft: "8px",
                                fontSize: "10px",
                                background: "#F59E0B",
                                color: "#000",
                                fontWeight: 800,
                                padding: "2px 6px",
                                borderRadius: "4px",
                                display: "inline-block",
                              }}
                            >
                              🚆 AT STATION (NOW)
                            </span>
                          )}
                          {isNextStop && (
                            <span
                              style={{
                                marginLeft: "8px",
                                fontSize: "10px",
                                background: "rgba(245, 158, 11, 0.2)",
                                color: "#F59E0B",
                                fontWeight: 700,
                                padding: "2px 6px",
                                borderRadius: "4px",
                                display: "inline-block",
                                border: "1px solid rgba(245, 158, 11, 0.4)",
                              }}
                            >
                              NEXT STOP (ETA {currentStatus?.eta}m)
                            </span>
                          )}
                        </div>
                        {s.stEn && s.stEn !== s.stZh && (
                          <div style={{ fontSize: "11px", color: dark ? "#6B7280" : "#94A3B8" }}>
                            {s.stEn}
                          </div>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "9px 16px",
                          textAlign: "right",
                          fontFamily: "monospace",
                          fontSize: "12px",
                          color:
                            isPast && !isOriginCity
                              ? dark
                                ? "#6B7280"
                                : "#94A3B8"
                              : "inherit",
                        }}
                      >
                        {idx === 0 ? (
                          <span style={{ opacity: 0.4 }}>—</span>
                        ) : s.legKm && s.legKm > 0 ? (
                          unit === "mi" ? (
                            `${(s.legKm * 0.621371).toFixed(1)} mi`
                          ) : (
                            `${s.legKm} km`
                          )
                        ) : (
                          <span style={{ opacity: 0.4 }}>—</span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "9px 16px",
                          textAlign: "center",
                          fontFamily: "monospace",
                          color: isPast && !isOriginCity ? (dark ? "#6B7280" : "#94A3B8") : "inherit",
                        }}
                      >
                        <span
                          style={
                            isOriginCity
                              ? {
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  background: dark
                                    ? "rgba(59, 130, 246, 0.28)"
                                    : "rgba(59, 130, 246, 0.18)",
                                  fontWeight: 800,
                                  color: dark ? "#93C5FD" : "#1D4ED8",
                                }
                              : undefined
                          }
                        >
                          {s.arr}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: "9px 16px",
                          textAlign: "center",
                          fontFamily: "monospace",
                          fontWeight: 600,
                          color: isPast && !isOriginCity ? (dark ? "#6B7280" : "#94A3B8") : "inherit",
                        }}
                      >
                        <span
                          style={
                            isOriginCity
                              ? {
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  background: dark
                                    ? "rgba(59, 130, 246, 0.28)"
                                    : "rgba(59, 130, 246, 0.18)",
                                  fontWeight: 800,
                                  color: dark ? "#93C5FD" : "#1D4ED8",
                                }
                              : undefined
                          }
                        >
                          {s.dep}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: "9px 16px",
                          textAlign: "right",
                          fontSize: "12px",
                          color: dark ? "#9CA3AF" : "#64748B",
                        }}
                      >
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
                    rows.push(
                      <tr
                        key={`transit-leg-${idx}`}
                        style={{
                          background: dark
                            ? "rgba(245, 158, 11, 0.12)"
                            : "rgba(245, 158, 11, 0.08)",
                          borderLeft: "4px solid #F59E0B",
                        }}
                      >
                        <td colSpan={6} style={{ padding: "8px 16px 8px 18px" }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "10px",
                            }}
                          >
                            <span style={{ fontSize: "16px" }}>🚅</span>
                            <div style={{ flex: 1 }}>
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  color: "#F59E0B",
                                }}
                              >
                                <span>
                                  EN ROUTE: {fmtStName(s.stZh, s.stEn)} ➔ {fmtStName(alignedStops[idx + 1].stZh, alignedStops[idx + 1].stEn)}
                                  {alignedStops[idx + 1]?.legKm && alignedStops[idx + 1].legKm! > 0 ? (
                                    <span style={{ opacity: 0.85, fontWeight: 500, marginLeft: 6 }}>
                                      ({unit === "mi" ? `${(alignedStops[idx + 1].legKm! * 0.621371).toFixed(1)} mi` : `${alignedStops[idx + 1].legKm} km`})
                                    </span>
                                  ) : null}
                                </span>
                                <span>
                                  {Math.round(legProgress * 100)}% · {currentStatus.eta}m to arrival
                                </span>
                              </div>
                              <div
                                style={{
                                  width: "100%",
                                  height: "5px",
                                  background: "rgba(245, 158, 11, 0.25)",
                                  borderRadius: "3px",
                                  marginTop: "4px",
                                  overflow: "hidden",
                                }}
                              >
                                <div
                                  style={{
                                    width: `${Math.round(legProgress * 100)}%`,
                                    height: "100%",
                                    background: "#F59E0B",
                                    borderRadius: "3px",
                                    transition: "width 0.2s ease",
                                  }}
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
        <div
          style={{
            padding: "10px 20px",
            borderTop: `1px solid ${dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)"}`,
            fontSize: "11px",
            color: dark ? "#9CA3AF" : "#64748B",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>Tip: Click any station row to jump simulation time</span>
          <span>{alignedStops ? `${alignedStops.length} calling stops` : ""}</span>
        </div>
      </div>
    </div>
  );
}
