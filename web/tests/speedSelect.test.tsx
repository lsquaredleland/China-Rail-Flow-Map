import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpeedSelect, { SPEED_MULTIPLIERS, nextSpeed } from "../src/components/SpeedSelect";

describe("SpeedSelect (the speed button, phone and desktop)", () => {
  test("0.5x, 1x, 2x, 4x map to 120, 60, 30, 15 seconds per day", () => {
    expect(SPEED_MULTIPLIERS.map((o) => [o.label, o.secs])).toEqual([["0.5×", 120], ["1×", 60], ["2×", 30], ["4×", 15]]);
  });

  test("shows the current multiplier (2x on the default 30 s)", () => {
    const h = renderToStaticMarkup(<SpeedSelect speed={30} onSetSpeed={() => {}} />);
    expect(h).toContain("<b>2×</b>");
    expect(h).toContain("SPEED");
  });

  test("tapping cycles 1x -> 2x -> 4x -> 0.5x -> 1x via setSpeed", () => {
    const calls: number[] = [];
    let speed = 60;
    for (let i = 0; i < 5; i++) {
      const el = SpeedSelect({ speed, onSetSpeed: (s) => calls.push(s) }) as React.ReactElement<any>;
      el.props.onClick();
      speed = calls[calls.length - 1];
    }
    expect(calls).toEqual([30, 15, 120, 60, 30]);
  });

  test("an unknown speed restarts the cycle at 0.5x", () => {
    expect(nextSpeed(45)).toBe(120);
  });
});
