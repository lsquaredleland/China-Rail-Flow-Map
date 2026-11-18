// Unit tests for DestinationPanel:
// rendering destination and source rows, and minimise/close actions.
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DestinationPanel, { EndBar, PanelHead } from "../src/components/DestinationPanel";
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
    expect(h).toContain('<table class="dp-has-head">');
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
    expect(h).toContain('<table class="dp-has-head">');
  });

  test("skin headline (hidden in paper): padded count, fast / conventional split and its tick bar", () => {
    const h = renderToStaticMarkup(<PanelHead trains={86} fast={72} />);
    expect(h).toContain('class="dp-term dp-head"');
    expect(h).toContain(">086<");
    expect(h).toContain("Fast G/D/C/S</span> 72");
    expect(h).toContain("Conventional</span> 14");
    expect(h).toContain('flex-grow:72');
    expect(h).toContain('flex-grow:14');
    // more fast trains than trains (inconsistent input) never goes negative
    expect(renderToStaticMarkup(<PanelHead trains={3} fast={5} />)).toContain("Conventional</span> 0");
    expect(renderToStaticMarkup(<PanelHead trains={1234} fast={0} />)).toContain(">1234<");
  });

  test("skin end bar: n / of and the share, 0 % without trains", () => {
    const h = renderToStaticMarkup(<EndBar label="Trains ending here" n={61} of={86} />);
    expect(h).toContain("61 / 86 · 70.9 %");
    expect(h).toContain("width:70.9%");
    expect(renderToStaticMarkup(<EndBar label="x" n={0} of={0} />)).toContain("0 / 0 · 0.0 %");
  });

  test("the headline reads the origin view's point; national rows have none", () => {
    const out = renderToStaticMarkup(
      <DestinationPanel point={dest} direction="out" cityEn="Guangzhou" cityZh="广州" unit="km" onClose={noop} />,
    );
    expect(out).toContain("Fast G/D/C/S</span> " + dest.fast);
    expect(out).toContain("Conventional</span> " + (dest.trains - dest.fast));
    expect(out).toContain(dest.terminating + " / " + dest.trains);
    const nat = renderToStaticMarkup(
      <DestinationPanel point={dest} rows={[["Departures", "3"], ["Arrivals", "4"]]} direction="out" unit="km" onClose={noop} />,
    );
    expect(nat).not.toContain("dp-term");
    expect(nat).toContain("<table>");
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
