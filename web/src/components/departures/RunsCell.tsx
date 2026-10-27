import type { DecodedAtlas } from "../../types";
import { runDays } from "../../lib";

/** The run days of a train, as one label ("Daily", "Weekends", "Fri–Sun", ...). */
export function RunsLabel({
  days,
  pattern,
  calendar,
}: {
  days?: string;
  pattern?: string;
  calendar?: readonly string[];
}) {
  const r = runDays(days, pattern, calendar);
  return <span className="runs-label">{r ? r.label : "—"}</span>;
}

/** The "Runs" table cell of an origin-view row, looked up by train_table index. */
export default function RunsCell({ atlas, t }: { atlas?: DecodedAtlas | null; t: number }) {
  const row = atlas?.data.train_table[t];
  return (
    <td className="c-runs">
      <RunsLabel days={row?.days} pattern={row?.pattern} calendar={atlas?.data.calendar} />
    </td>
  );
}
