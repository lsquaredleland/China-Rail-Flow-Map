import { useEffect, useMemo, useState, type RefObject } from "react";
import type { DepVM, ArrVM, SchedulesData } from "../types";
import type { MapApi } from "./MapCanvas";
import { formatScheduleStops } from "../lib";

interface Props {
  code: string | null;
  onClose: () => void;
  schedulesData: SchedulesData | null;
  stationTable: { zh: string; en: string }[];
  dark: boolean;
  trainVM?: DepVM | ArrVM | null;
  currentTime?: number;
  isIsolated?: boolean;
  onToggleIsolate?: (code: string) => void;
  onJumpToTime?: (mins: number) => void;
  mapRef?: RefObject<MapApi | null>;
}

export default function TrainScheduleModal({
  code,
  onClose,
  schedulesData,
  stationTable,
  dark,
  trainVM,
  currentTime,
  isIsolated = false,
  onToggleIsolate,
  onJumpToTime,
  mapRef,
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

  // Determine current active trip status
  const currentStatus = useMemo(() => {
    if (!stops || stops.length === 0) return null;
    const first = stops[0];
    const last = stops[stops.length - 1];

    if (liveTime < first.depMins) {
      const wait = Math.round(first.depMins - liveTime);
      return {
        state: "pre",
        text: `Departs ${first.stZh} in ${wait > 60 ? `${Math.floor(wait / 60)}h ${wait % 60}m` : `${wait}m`} (at ${first.dep})`,
      };
    }
    if (liveTime >= last.arrMins) {
      return {
        state: "post",
        text: `Completed journey to ${last.stZh} at ${last.arr}`,
      };
    }

    // Check if currently stopped at a station
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if (s.arrMins >= 0 && s.depMins >= 0 && liveTime >= s.arrMins && liveTime <= s.depMins) {
        const rem = Math.max(0, Math.round(s.depMins - liveTime));
        return {
          state: "stopped",
          text: `Stopped at ${s.stZh} · Departs in ${rem}m (${s.dep})`,
          stopIdx: i,
        };
      }
    }

    // In transit between stops
    for (let i = 0; i < stops.length - 1; i++) {
      const curr = stops[i];
      const next = stops[i + 1];
      if (liveTime >= curr.depMins && liveTime < next.arrMins) {
        const eta = Math.max(0, Math.round(next.arrMins - liveTime));
        return {
          state: "transit",
          text: `En route: ${curr.stZh} ➔ ${next.stZh} · ETA in ${eta}m (${next.arr})`,
          fromIdx: i,
          toIdx: i + 1,
        };
      }
    }

    return null;
  }, [stops, liveTime]);

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
            {trainVM ? `${(trainVM as any).fsZh || ""} ➔ ${(trainVM as any).tsZh || ""}` : code}
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
                {trainVM ? `${(trainVM as any).fsZh || ""} ➔ ${(trainVM as any).tsZh || ""}` : `Train ${code} Schedule`}
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

        {/* Timetable Table */}
        <div style={{ overflowY: "auto", flex: 1, padding: "4px 0" }}>
          {!stops ? (
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
                  <th style={{ padding: "8px 16px", textAlign: "center" }}>Arrive</th>
                  <th style={{ padding: "8px 16px", textAlign: "center" }}>Depart</th>
                  <th style={{ padding: "8px 16px", textAlign: "right" }}>Dwell</th>
                </tr>
              </thead>
              <tbody>
                {stops.map((s, idx) => {
                  const isCurrent =
                    typeof liveTime === "number" &&
                    s.arrMins >= 0 &&
                    s.depMins >= 0 &&
                    liveTime >= s.arrMins &&
                    liveTime <= s.depMins;
                  const isPast =
                    typeof liveTime === "number" &&
                    s.depMins >= 0 &&
                    liveTime > s.depMins;

                  const jumpTime = s.arrMins >= 0 ? s.arrMins : s.depMins;

                  return (
                    <tr
                      key={idx}
                      onClick={() => {
                        if (jumpTime >= 0 && onJumpToTime) {
                          onJumpToTime(jumpTime % 1440);
                        }
                      }}
                      title={onJumpToTime ? `Click to jump simulation to ${s.stZh} (${s.arr !== "—" ? s.arr : s.dep})` : undefined}
                      style={{
                        borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)"}`,
                        background: isCurrent
                          ? dark
                            ? "rgba(245, 158, 11, 0.22)"
                            : "rgba(245, 158, 11, 0.15)"
                          : "transparent",
                        cursor: onJumpToTime ? "pointer" : "default",
                        transition: "background 0.15s ease",
                      }}
                      onMouseEnter={(e) => {
                        if (!isCurrent) {
                          e.currentTarget.style.background = dark
                            ? "rgba(255,255,255,0.04)"
                            : "rgba(0,0,0,0.03)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isCurrent) {
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
                          fontSize: "11px",
                        }}
                      >
                        {isCurrent ? "●" : idx + 1}
                      </td>
                      <td style={{ padding: "9px 16px" }}>
                        <div style={{ fontWeight: 600, color: isPast ? (dark ? "#6B7280" : "#94A3B8") : "inherit" }}>
                          {s.stZh}
                          {isCurrent && (
                            <span
                              style={{
                                marginLeft: "8px",
                                fontSize: "10px",
                                background: "#F59E0B",
                                color: "#000",
                                fontWeight: 800,
                                padding: "1px 5px",
                                borderRadius: "3px",
                              }}
                            >
                              NOW
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
                          textAlign: "center",
                          fontFamily: "monospace",
                          color: isPast ? (dark ? "#6B7280" : "#94A3B8") : "inherit",
                        }}
                      >
                        {s.arr}
                      </td>
                      <td
                        style={{
                          padding: "9px 16px",
                          textAlign: "center",
                          fontFamily: "monospace",
                          fontWeight: 600,
                          color: isPast ? (dark ? "#6B7280" : "#94A3B8") : "inherit",
                        }}
                      >
                        {s.dep}
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
                  );
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
          <span>{stops ? `${stops.length} calling stops` : ""}</span>
        </div>
      </div>
    </div>
  );
}
