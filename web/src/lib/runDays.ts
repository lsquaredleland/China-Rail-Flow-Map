/* Run days of a train, as one label: the pack gives each train a `days`
   bitmask over `shared.calendar` and a `pattern` name; this only words them.
   The only facts used besides those two are the calendar's own dates (to name
   the weekdays of a weekday-set). */

interface RunDays {
  /** "Daily", "Weekends", "Fri–Sun", "Every other day" or "Irregular". */
  label: string;
  /** Sort order of the categories: Daily, Weekends, weekday sets, Every other day, Irregular. */
  rank: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Weekday of an ISO date: 0 = Mon .. 6 = Sun. */
function weekday(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** "Fri, Sun" / "Fri–Sun" / "Mon–Wed, Fri" from weekday numbers; runs wrap the week ("Sat–Mon"). */
function weekdayLabel(set: Set<number>): string {
  // Start at a present day whose predecessor is absent, so a run never splits.
  let start = 0;
  for (let i = 0; i < 7; i++) {
    if (set.has(i) && !set.has((i + 6) % 7)) {
      start = i;
      break;
    }
  }
  const out: string[] = [];
  for (let k = 0; k < 7; ) {
    const i = (start + k) % 7;
    if (!set.has(i)) {
      k++;
      continue;
    }
    let n = 1;
    while (k + n < 7 && set.has((start + k + n) % 7)) n++;
    out.push(
      n >= 3
        ? WEEKDAYS[i] + "–" + WEEKDAYS[(i + n - 1) % 7]
        : n === 2
          ? WEEKDAYS[i] + ", " + WEEKDAYS[(i + 1) % 7]
          : WEEKDAYS[i],
    );
    k += n;
  }
  return out.join(", ");
}

/** The run-days label of a train; null when the pack has no run-day data. */
export function runDays(
  days: string | undefined,
  pattern: string | undefined,
  calendar: readonly string[] | undefined,
): RunDays | null {
  if (!days || !pattern || !calendar || calendar.length === 0) return null;
  if (pattern === "daily") return { label: "Daily", rank: 0 };
  if (pattern === "alternate-day") return { label: "Every other day", rank: 3 };
  if (pattern === "weekday-set") {
    const set = new Set<number>();
    calendar.forEach((d, i) => {
      if (days[i] === "1") set.add(weekday(d));
    });
    if (set.size === 2 && set.has(5) && set.has(6)) return { label: "Weekends", rank: 1 };
    return { label: weekdayLabel(set), rank: 2 };
  }
  return { label: "Irregular", rank: 4 };
}

/** Sort rank of a train's run days (rows without run-day data last). */
export function runRank(
  row: { days?: string; pattern?: string } | undefined,
  calendar: readonly string[] | undefined,
): number {
  return runDays(row?.days, row?.pattern, calendar)?.rank ?? 5;
}
