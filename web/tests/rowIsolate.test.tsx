// A plain click on a train row isolates the train (the timetable's "Isolate on
// map" path); the train-number link still opens the timetable.
import { describe, expect, test } from "bun:test";
import React, { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DeparturesTable from "../src/components/DeparturesTable";
import WindowedTable from "../src/components/departures/WindowedTable";
import TrainCell from "../src/components/departures/TrainCell";
import { origin, pack } from "./fixture";

/** Render DeparturesTable once (hooks need a render) and return its element tree. */
function treeOf(props: Record<string, unknown>): ReactNode {
  let tree: ReactNode = null;
  function Harness() {
    tree = (DeparturesTable as unknown as (p: unknown) => ReactNode)(props);
    return null;
  }
  renderToStaticMarkup(<Harness />);
  return tree;
}

/** Every element in the tree, expanding the WindowedTable render-prop. */
function walk(n: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(n)) n.forEach((c) => walk(c, out));
  else if (n && typeof n === "object" && "props" in n) {
    const el = n as ReactElement<any>;
    out.push(el);
    if (el.type === WindowedTable) {
      const win = { first: 0, last: 5, top: null, bottom: null, tr: () => ({ className: undefined, style: {} }) };
      walk(el.props.children(win), out);
    } else walk(el.props.children, out);
  }
  return out;
}

describe("train row click", () => {
  const { atlas } = pack();
  const cur = origin("广州");
  const run = () => {
    const isolated: string[] = [];
    const opened: string[] = [];
    const els = walk(
      treeOf({
        unit: "km",
        panelCity: null,
        selectedClasses: [],
        onSelectClasses: () => {},
        outTablesReady: true,
        inTablesReady: true,
        onClearFilter: () => {},
        atlas,
        cur,
        direction: "out",
        onToggleIsolate: (c: string) => isolated.push(c),
        onSelectTrain: (c: string) => opened.push(c),
      }),
    );
    const rows = els.filter((e) => e.type === "tr" && typeof (e.props as any).onClick === "function");
    const link = els.find((e) => e.type === TrainCell)!;
    return { rows, link, isolated, opened };
  };
  const click = { shiftKey: false, metaKey: false, ctrlKey: false, stopPropagation() {} };

  test("a plain row click isolates the train", () => {
    const { rows, isolated, opened } = run();
    expect(rows.length).toBeGreaterThan(0);
    (rows[0].props as any).onClick(click);
    expect(isolated.length).toBe(1);
    expect(opened).toEqual([]);
  });

  test("the train link opens the timetable and does not isolate", () => {
    const { link, isolated, opened } = run();
    (link.props as any).onClick();
    expect(opened.length).toBe(1);
    expect(isolated).toEqual([]);
  });
});
