/** Phone-width speed control: one button showing the multiplier, tapping it
    cycles 1x -> 2x -> 3x -> 1x (the 15s / 30s / 60s segmented control stays on
    desktop). One place to change the mapping: seconds per 24h day for each
    multiplier. */
export const SPEED_MULTIPLIERS: { label: string; secs: number }[] = [
  { label: "1×", secs: 60 },
  { label: "2×", secs: 30 },
  { label: "3×", secs: 15 },
];

/** The seconds-per-day the next tap selects. A speed that is not a
    multiplier (set elsewhere, e.g. 15) restarts the cycle at 1x. */
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
      onClick={() => onSetSpeed(nextSpeed(speed))}
    >
      <b>{cur ? cur.label : speed + "s"}</b>
      <small>SPEED</small>
    </button>
  );
}
