/** The animation speed control (phone and desktop): one button showing the
    multiplier, each tap cycles 0.5x -> 1x -> 2x -> 4x -> 0.5x. One place to
    change the mapping: seconds per 24h day for each multiplier. */
export const SPEED_MULTIPLIERS: { label: string; secs: number }[] = [
  { label: "0.5×", secs: 120 },
  { label: "1×", secs: 60 },
  { label: "2×", secs: 30 },
  { label: "4×", secs: 15 },
];

/** The seconds-per-day the next tap selects. A speed that is not a
    multiplier (set elsewhere) restarts the cycle at 0.5x. */
export function nextSpeed(secs: number): number {
  const i = SPEED_MULTIPLIERS.findIndex((o) => o.secs === secs);
  return SPEED_MULTIPLIERS[(i + 1) % SPEED_MULTIPLIERS.length].secs;
}

export default function SpeedSelect({ speed, onSetSpeed }: { speed: number; onSetSpeed: (secs: number) => void }) {
  const cur = SPEED_MULTIPLIERS.find((o) => o.secs === speed);
  return (
    <button
      type="button"
      className="tb-speed-select"
      aria-label={`Animation speed ${cur ? cur.label : speed + "s"}, tap to change`}
      title={`A day in ${speed} seconds`}
      onClick={() => onSetSpeed(nextSpeed(speed))}
    >
      <b>{cur ? cur.label : speed + "s"}</b>
      <small>SPEED</small>
    </button>
  );
}
