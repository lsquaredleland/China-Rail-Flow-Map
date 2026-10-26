/* Run days of a train, as words: the pack gives each train a `days` bitmask
   over `shared.calendar` and a `pattern` name; this only words them. The only
   facts used besides those two are the calendar's own dates (weekday names). */

export interface RunDays {
  /** Days the train runs in the window ("9" of "9/15"). */
  count: number;
  total: number;
  /** Short words: "Daily", "Every other day", "Fri–Sun", "Until 31 Oct", ... */
  label: string;
  /** Every date the train runs, as a tooltip ("Fri 23 Oct, Sat 24 Oct, ..."). */
  title: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ISO date -> [weekday 0=Mon..6=Sun, day of month, month 0..11]. */
function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return [wd, d, m - 1];
}

/** Number of run days in a `days` mask (the sortable "Days" figure). */
export function runCount(days: string | undefined): number {
  let n = 0;
  if (days) for (let i = 0; i < days.length; i++) if (days.charCodeAt(i) === 49) n++;
  return n;
}

/** "Fri, Sun" / "Fri–Sun" / "Mon–Wed, Fri" from weekday numbers; runs wrap the week ("Fri–Mon"). */
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

/** "23, 25 Oct" / "30 Oct, 2 Nov" from calendar positions. */
function listDates(cal: readonly string[], idx: number[]): string {
  const p = idx.map((i) => parts(cal[i]));
  return p.every((x) => x[2] === p[0][2])
    ? p.map((x) => x[1]).join(", ") + " " + MONTHS[p[0][2]]
    : p.map((x) => x[1] + " " + MONTHS[x[2]]).join(", ");
}

/** Irregular trains: the weekdays that dominate them, or null.
    A weekday counts when the train runs on more than half of its dates in the
    window; they dominate when there are at most four of them and their dates
    hold at least 60% of the train's run days. */
function dominantWeekdays(cal: readonly string[], on: boolean[]): Set<number> | null {
  const ran = new Array(7).fill(0);
  const all = new Array(7).fill(0);
  let total = 0;
  cal.forEach((d, i) => {
    const wd = parts(d)[0];
    all[wd]++;
    if (on[i]) {
      ran[wd]++;
      total++;
    }
  });
  const set = new Set<number>();
  let inSet = 0;
  for (let w = 0; w < 7; w++) {
    if (ran[w] * 2 > all[w]) {
      set.add(w);
      inSet += ran[w];
    }
  }
  return set.size > 0 && set.size <= 4 && total > 0 && inSet >= 0.6 * total ? set : null;
}

/** Words for a train's run days; null when the pack has no run-day data. */
export function runDays(
  days: string | undefined,
  pattern: string | undefined,
  calendar: readonly string[] | undefined,
): RunDays | null {
  if (!days || !pattern || !calendar || calendar.length === 0) return null;
  const n = calendar.length;
  const cells = Array.from(calendar, (_, i) => days[i] === "1");
  const idx = cells.flatMap((c, i) => (c ? [i] : []));
  const dayNums = calendar.map((d) => parts(d)[1]);
  const title = idx
    .map((i) => {
      const [wd, d, m] = parts(calendar[i]);
      return WEEKDAYS[wd] + " " + d + " " + MONTHS[m];
    })
    .join(", ");
  const one = (i: number) => dayNums[i] + " " + MONTHS[parts(calendar[i])[2]];
  let label: string;
  if (pattern === "daily") label = "Daily";
  else if (pattern === "alternate-day") label = "Every other day";
  else if (pattern === "weekday-set") label = weekdayLabel(new Set(idx.map((i) => parts(calendar[i])[0])));
  else if (pattern === "irregular") {
    const dom = dominantWeekdays(calendar, cells);
    label = dom ? "Mostly " + weekdayLabel(dom) : idx.length + " of " + n + " days";
  } else if (idx.length === 0) label = "—";
  else {
    const block = idx[idx.length - 1] - idx[0] === idx.length - 1;
    if (block && idx[0] === 0) label = "Until " + one(idx[idx.length - 1]);
    else if (block && idx[idx.length - 1] === n - 1) label = "From " + one(idx[0]);
    else label = idx.length <= 3 ? listDates(calendar, idx) : idx.length + " dates";
  }
  return { count: idx.length, total: n, label, title };
}
