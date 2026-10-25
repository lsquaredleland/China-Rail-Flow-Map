/* Floating controls drawn over the map canvas. */

/** "Isolated: K9217 [Timetable] [x]" pill while one train is isolated. */
export function IsolationChip({
  dark,
  code,
  onTimetable,
  onExit,
}: {
  dark: boolean;
  code: string;
  onTimetable: () => void;
  onExit: () => void;
}) {
  return (
  <div
    style={{
      position: "absolute",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 100,
      background: dark
        ? "rgba(17, 24, 39, 0.94)"
        : "rgba(255, 255, 255, 0.95)",
      backdropFilter: "blur(10px)",
      border: "1px solid #F59E0B",
      borderRadius: "30px",
      padding: "6px 16px",
      boxShadow: "0 10px 25px -5px rgba(0,0,0,0.35)",
      display: "flex",
      alignItems: "center",
      gap: "10px",
      fontSize: "13px",
      color: dark ? "#F3F4F6" : "#111827",
    }}
  >
    <span
      style={{
        display: "inline-block",
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        background: "#F59E0B",
        boxShadow: "0 0 8px #F59E0B",
      }}
    />
    <span>
      Isolated:{" "}
      <strong style={{ fontFamily: "monospace", fontWeight: 800 }}>
        {code}
      </strong>
    </span>
    <button
      type="button"
      onClick={() => onTimetable()}
      style={{
        border: "none",
        background: dark
          ? "rgba(255,255,255,0.12)"
          : "rgba(0,0,0,0.08)",
        color: "inherit",
        cursor: "pointer",
        padding: "3px 8px",
        borderRadius: "12px",
        fontSize: "11px",
        fontWeight: 600,
      }}
    >
      Timetable
    </button>
    <button
      type="button"
      onClick={() => onExit()}
      style={{
        border: "none",
        background: "none",
        cursor: "pointer",
        color: dark ? "#9CA3AF" : "#64748B",
        fontWeight: 700,
        fontSize: "14px",
        padding: "0 4px",
      }}
      title="Exit single train isolation"
    >
      ✕
    </button>
  </div>
  );
}

/** The collapsed 24h-animation entry button. */
export function TimelineExpandButton({
  dark,
  onExpand,
}: {
  dark: boolean;
  onExpand: () => void;
}) {
  return (
  <div
    style={{
      position: "absolute",
      bottom: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 30,
      pointerEvents: "auto",
    }}
  >
    <button
      type="button"
      onClick={onExpand}
      style={{
        background: dark ? "#27272A" : "#FFFFFF",
        color: dark ? "#EDEDEA" : "#111111",
        border: dark
          ? "1.5px solid rgba(255, 255, 255, 0.25)"
          : "1.5px solid #111111",
        borderRadius: "20px",
        padding: "6px 20px",
        fontSize: "12px",
        fontWeight: 700,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        boxShadow: "0 4px 14px rgba(0, 0, 0, 0.25)",
        transition: "transform 0.12s ease, background 0.15s ease",
      }}
      title="Expand 24h train flow animation controls"
    >
      <span
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: "#C8302A",
          boxShadow: "0 0 8px #C8302A",
        }}
      />
      <span>24h Flow Animation · Expand ▴</span>
    </button>
  </div>
  );
}
