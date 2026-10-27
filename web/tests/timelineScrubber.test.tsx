// Unit tests for TimelineScrubber:
// labels in origin vs national mode, and Finish present in both.
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineScrubber } from "../src/components/TimelineScrubber";

const noop = () => {};

describe("TimelineScrubber", () => {
  test("collapsed state when onCollapse is not provided", () => {
    const h = renderToStaticMarkup(
      <TimelineScrubber mapRef={{ current: null }} dark={false} direction="out" />
    );
    expect(h).toContain("timeline-collapsed-bar");
    expect(h).toContain("24h Flow Animation · Expand ▴");
    expect(h).not.toContain("timeline-bar-dock");
  });

  test("origin outbound mode: DEPARTED, ARRIVED, TOTAL labels, and Finish present", () => {
    const h = renderToStaticMarkup(
      <TimelineScrubber
        mapRef={{ current: null }}
        dark={false}
        direction="out"
        onCollapse={noop}
      />
    );
    expect(h).toContain("timeline-bar-dock");
    expect(h).toContain("DEPARTED");
    expect(h).toContain("ARRIVED");
    expect(h).toContain("TOTAL");
    expect(h).not.toContain("RUNNING");
    expect(h).not.toContain("TRAINS");
    expect(h).toContain("Finish");
    expect(h).toContain("tb-speed-btn");
    expect(h).toContain('<button type="button" class="tb-tick-item at-0"');
    expect(h).toContain('<button type="button" class="tb-tick-item at-end"');
  });

  test("origin inbound mode: BOARDED, ARRIVED, TOTAL labels, and Finish present", () => {
    const h = renderToStaticMarkup(
      <TimelineScrubber
        mapRef={{ current: null }}
        dark={false}
        direction="in"
        onCollapse={noop}
      />
    );
    expect(h).toContain("BOARDED");
    expect(h).toContain("ARRIVED");
    expect(h).toContain("TOTAL");
    expect(h).not.toContain("DEPARTED");
    expect(h).toContain("Finish");
  });

  test("national mode: RUNNING and TRAINS labels, no ARRIVED, and Finish present in both", () => {
    // In TimelineScrubber, isNational is the 4th useState call (isPlaying, speed, isCollapsed, isNational).
    // Intercept the server dispatcher's useState to render the national mode branch.
    const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

    function NationalHarness() {
      const orig = internals.H.useState;
      let count = 0;
      internals.H.useState = (init: any) => {
        count++;
        if (count === 4) return [true, noop];
        return orig(init);
      };
      try {
        return TimelineScrubber({
          mapRef: { current: null },
          dark: false,
          direction: "out",
          onCollapse: noop,
        });
      } finally {
        internals.H.useState = orig;
      }
    }

    const h = renderToStaticMarkup(<NationalHarness />);

    // National labels
    expect(h).toContain("RUNNING");
    expect(h).toContain("TRAINS");
    expect(h).not.toContain("ARRIVED");
    expect(h).not.toContain("TOTAL");

    // Finish button is present in both origin and national
    expect(h).toContain("Finish");
  });
});
