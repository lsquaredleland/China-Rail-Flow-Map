/** Phone-width speed control: a compact dropdown in multipliers instead of
    the 15s / 30s / 60s segmented control (which stays on desktop). One place
    to change the mapping: seconds per 24h day for each multiplier. */
export const SPEED_MULTIPLIERS: { label: string; secs: number }[] = [
  { label: "1×", secs: 60 },
  { label: "2×", secs: 30 },
  { label: "3×", secs: 20 },
];

export default function SpeedSelect({ speed, onSetSpeed }: { speed: number; onSetSpeed: (secs: number) => void }) {
  const known = SPEED_MULTIPLIERS.some((o) => o.secs === speed);
  return (
    <select
      className="tb-speed-select"
      aria-label="Animation speed"
      value={String(speed)}
      onChange={(e) => onSetSpeed(Number(e.target.value))}
    >
      {!known && <option value={String(speed)}>{speed}s</option>}
      {SPEED_MULTIPLIERS.map((o) => (
        <option key={o.secs} value={String(o.secs)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
