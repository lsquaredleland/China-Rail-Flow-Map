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

  // Column widths are measured once from the first window (auto layout) and
  // then locked with table-layout: fixed. Otherwise the auto layout re-sizes
  // the columns to whichever rows happen to be in view, and they jump while
  // scrolling. They unlock (and are re-measured) when the list, the columns
  // or the window width change.
  const table = useRef<HTMLTableElement>(null);
  const [colW, setColW] = useState<{ cols: number[]; total: number } | null>(null);
  const [vw, setVw] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useLayoutEffect(() => {
    setColW(null);
  }, [n, cols, className, resetKey, vw]);
  useLayoutEffect(() => {
    if (colW || n === 0) return;
    const head = table.current?.tHead?.rows[0];
    if (!head || !table.current) return;
    const ws = Array.from(head.cells, (c) => c.getBoundingClientRect().width);
    if (ws.some((x) => x <= 0)) return;
    setColW({ cols: ws, total: table.current.getBoundingClientRect().width });
  }, [colW, n]);

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
      <table
        id="depTable"
        ref={table}
        className={"win-table" + (className ? " " + className : "")}
        style={colW ? { tableLayout: "fixed", width: colW.total } : undefined}
      >
        {colW && (
          <colgroup>
            {colW.cols.map((x, i) => (
              <col key={i} style={{ width: x }} />
            ))}
          </colgroup>
        )}
        {children(w)}
      </table>
    </div>
  );
}
