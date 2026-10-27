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
    showFlows: true,
    onToggleFlows: () => {},
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
  test("the Flows toggle sits with the other map toggles in national mode only, pressed by default", () => {
    const nat = renderToStaticMarkup(<Toolbar {...props(0, true)} />);
    expect(nat).toMatch(/id="tglFlows"[^>]*aria-pressed="true"/);
    // inside the Map options panel, so it is in the mobile dropdown too
    expect(nat.indexOf('id="tbMore"')).toBeLessThan(nat.indexOf('id="tglFlows"'));
    expect(renderToStaticMarkup(<Toolbar {...props(0, false)} />)).not.toContain("tglFlows");
  });
  test("the layers popover groups the controls under headings and keeps their ids", () => {
    const h = renderToStaticMarkup(<Toolbar {...props(0)} />);
    for (const t of ["View", "Map layers", "Units &amp; theme"]) expect(h).toContain(t);
    for (const id of ["btnCountry", "btnHome", "btnOut", "btnIn", "tglNetwork", "tglLabels", "tglInfra", "unitKm", "unitMi", "themeDay", "themeNight"])
      expect(h).toContain(`id="${id}"`);
    // the class filter stays inline, outside the popover (it follows the popover's closing tag)
    expect(h).toContain("cls-filter");
    expect(h.indexOf('id="tbMore"')).toBeLessThan(h.indexOf('id="tbFilters"'));
  });
  test("a dot shows on the layers button only while a layer option is off its default", () => {
    expect(renderToStaticMarkup(<Toolbar {...props(0)} />)).not.toContain("tb-dot");
    const changed = { ...(props(0) as object), showInfra: true } as never;
    expect(renderToStaticMarkup(<Toolbar {...changed} />)).toContain("tb-dot");
  });
});
