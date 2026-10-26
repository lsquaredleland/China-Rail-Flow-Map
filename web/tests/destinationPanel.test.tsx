// Unit tests for DestinationPanel:
// rendering destination and source rows, and minimise/close actions.
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DestinationPanel from "../src/components/DestinationPanel";
import { origin } from "./fixture";

describe("DestinationPanel", () => {
  const o = origin("广州");
  const dest = o.dests[0];
  const src = {
    idx: 1,
    zh: "深圳",
    en: "Shenzhen",
    trains: 50,
    minDur: 30,
    maxDur: 60,
    minDistKm: 140,
    maxDistKm: 140,
    inCalls: [],
    pt: [114.05, 22.54],
  } as any;
  const noop = () => {};

  test("renders nothing when point is null", () => {
    const h = renderToStaticMarkup(
      <DestinationPanel
        point={null}
        direction="out"
        cityEn="Guangzhou"
        cityZh="广州"
        unit="km"
        onClose={noop}
      />
    );
    expect(h).toBe("");
  });

  test("outbound destination panel: renders header, rows, minimize and close buttons", () => {
    const h = renderToStaticMarkup(
      <DestinationPanel
        point={dest}
        direction="out"
        cityEn="Guangzhou"
        cityZh="广州"
        unit="km"
        onClose={noop}
      />
    );
    expect(h).toContain('id="destPanel"');
    expect(h).toContain('id="destMin"');
    expect(h).toContain('id="destClose"');
    expect(h).toContain("SELECTED");
    expect(h).toContain(dest.en);
    expect(h).toContain(dest.zh);
    expect(h).toContain("from Guangzhou");
    expect(h).toContain("<table>");
    expect(h).toContain("See all " + dest.trains + " trains");
  });

  test("inbound source panel: renders source rows and 'to' origin line", () => {
    const h = renderToStaticMarkup(
      <DestinationPanel
        point={src}
        direction="in"
        cityEn="Guangzhou"
        cityZh="广州"
        unit="km"
        onClose={noop}
      />
    );
    expect(h).toContain('id="destPanel"');
    expect(h).toContain(src.en);
    expect(h).toContain(src.zh);
    expect(h).toContain("to Guangzhou");
    expect(h).toContain("<table>");
  });

  test("minimised state: collapses to CityCard with Details and Close buttons", () => {
    // In DestinationPanel, minimized is the 1st useState call:
    // const [minimized, setMinimized] = useState(false);
    const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

    function MinimizedHarness() {
      const orig = internals.H.useState;
      internals.H.useState = () => [true, noop];
      try {
        return DestinationPanel({
          point: dest,
          direction: "out",
          cityEn: "Guangzhou",
          cityZh: "广州",
          unit: "km",
          onClose: noop,
        });
      } finally {
        internals.H.useState = orig;
      }
    }

    const h = renderToStaticMarkup(<MinimizedHarness />);
    expect(h).not.toContain('id="destPanel"');
    // Renders CityCard
    expect(h).toContain(dest.en);
    expect(h).toContain("<b>" + dest.trains + "</b> trains");
    expect(h).toContain("Details");
    expect(h).toContain('aria-label="Close city details"');
  });
});
