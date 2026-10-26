import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/* The scrolling box and window maths shared by all five departures tables.
   Rows have one fixed height (cells do not wrap, see `.win-table` in
   departures.css); only the rows in view plus an overscan margin are in the
   DOM, and two spacer rows stand in for the rest, so the scroller keeps its
   full height and scrollbar. The mode builds the rows (already filtered and
   sorted) for the window it is given. */

const WIN_OVERSCAN = 8;
/** Row heights: the origin tables' two-line rows, and the national table's
    tighter ones. */
export const ORIGIN_ROW_H = 54;
export const NAT_ROW_H = 46;

export function rowWindow(scrollTop: number, viewH: number, n: number, rowH: number): [number, number] {
  const first = Math.min(n, Math.max(0, Math.floor(scrollTop / rowH) - WIN_OVERSCAN));
  const last = Math.min(n, Math.ceil((scrollTop + viewH) / rowH) + WIN_OVERSCAN);
  return [first, Math.max(first, last)];
}

interface TableWindow {
  /** The rows to render are `first` to `last` (exclusive) of the list. */
  first: number;
  last: number;
  /** The spacer rows before and after them (null when empty). */
  top: ReactNode;
  bottom: ReactNode;
  /** Props for the row at list index `i`: fixed height, striping, and an extra class. */
  tr: (i: number, extra?: string) => { className: string | undefined; style: CSSProperties };
}

export default function WindowedTable({
  n,
  rowH,
  cols,
  className,
  resetKey,
  children,
}: {
  /** Row count of the (filtered, sorted) list. */
  n: number;
  rowH: number;
  /** Columns, for the spacer rows. */
  cols: number;
  className?: string;
  /** The scroller returns to the top when this changes. */
  resetKey?: unknown;
  /** The table's `thead` and `tbody`, for the window. */
  children: (w: TableWindow) => ReactNode;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (resetKey === undefined) return;
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight || 400);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const [first, last] = rowWindow(scrollTop, viewH, n, rowH);
  const spacer = (rows: number) =>
    rows > 0 ? (
      <tr className="win-spacer" aria-hidden="true" style={{ height: rows * rowH }}>
        <td colSpan={cols} />
      </tr>
    ) : null;
  const w: TableWindow = {
    first,
    last,
    top: spacer(first),
    bottom: spacer(n - last),
    tr: (i, extra) => ({
      className: [i % 2 ? "alt" : "", extra ?? ""].filter(Boolean).join(" ") || undefined,
      style: { height: rowH },
    }),
  };

  return (
    <div className="dep-scroll" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <table id="depTable" className={"win-table" + (className ? " " + className : "")}>
        {children(w)}
      </table>
    </div>
  );
}
