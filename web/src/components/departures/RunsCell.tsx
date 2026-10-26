import type { DecodedAtlas } from "../../types";
import { runDays } from "../../lib";

/** The run days of a train: the "9/15" count and the short label; the
    tooltip lists the dates. */
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
  if (!r) return <>—</>;
  return (
    <span className="runs" title={r.title ? "Runs " + r.title : "Does not run in the window"}>
      <b className="runs-n">
        {r.count}/{r.total}
      </b>{" "}
      <span className="runs-label">{r.label}</span>
    </span>
  );
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
