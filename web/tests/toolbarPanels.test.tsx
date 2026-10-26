// Narrow-screen toolbar: the Filters and Map options buttons, the active-count
// badge, and both panels in the DOM (CSS shows / hides them; wide screens show
// them inline).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Toolbar from "../src/components/Toolbar";

const props = (n: number, national = false) =>
  ({
    origins: [],
    originIdx: -1,
    onSelectOrigin: () => {},
    direction: "out",
    onSetDirection: () => {},
    selectedClasses: [],
    onClearClasses: () => {},
    onToggleClass: () => {},
    availableClasses: new Set<string>(),
    panelCity: null,
    cur: null,
    mapRef: { current: null },
    showNetwork: true,
    onToggleNetwork: () => {},
    showLabels: false,
    onToggleLabels: () => {},
    showInfra: false,
    onToggleInfra: () => {},
    distUnit: "km",
    onSetDistUnit: () => {},
    dark: false,
    onSetDark: () => {},
    national,
    onToggleNational: () => {},
    activeFilterCount: n,
  }) as never;

describe("toolbar panels", () => {
  test("no active filter: no badge; panels closed", () => {
    const h = renderToStaticMarkup(<Toolbar {...props(0)} />);
    expect(h).toContain('id="filtersBtn"');
    expect(h).toContain('id="moreBtn"');
    expect(h).not.toContain("tb-badge");
    expect(h).not.toContain("tb-panel open");
    expect(h).toContain('id="tbFilters"');
    expect(h).toContain('id="tbMore"');
  });
  test("the badge shows the active filter count", () => {
    const h = renderToStaticMarkup(<Toolbar {...props(3)} />);
    expect(h).toContain('<span class="tb-badge">3</span>');
  });
  test("national mode drops the origin controls but keeps the filters", () => {
    const h = renderToStaticMarkup(<Toolbar {...props(0, true)} />);
    expect(h).not.toContain('id="originSearch"');
    expect(h).not.toContain('id="dirOut"');
    expect(h).toContain("cls-filter");
  });
});
