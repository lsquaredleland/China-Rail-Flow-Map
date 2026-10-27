import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpeedSelect, { SPEED_MULTIPLIERS, nextSpeed } from "../src/components/SpeedSelect";

describe("SpeedSelect (phone speed button)", () => {
  test("1x, 2x, 3x map to 60, 30, 20 seconds per day", () => {
    expect(SPEED_MULTIPLIERS.map((o) => [o.label, o.secs])).toEqual([["1×", 60], ["2×", 30], ["3×", 20]]);
  });

  test("shows the current multiplier (2x on the default 30 s)", () => {
    const h = renderToStaticMarkup(<SpeedSelect speed={30} onSetSpeed={() => {}} />);
    expect(h).toContain("<b>2×</b>");
    expect(h).toContain("SPEED");
  });

  test("tapping cycles 1x -> 2x -> 3x -> 1x via setSpeed", () => {
    const calls: number[] = [];
    let speed = 60;
    for (let i = 0; i < 4; i++) {
      const el = SpeedSelect({ speed, onSetSpeed: (s) => calls.push(s) }) as React.ReactElement<any>;
      el.props.onClick();
      speed = calls[calls.length - 1];
    }
    expect(calls).toEqual([30, 20, 60, 30]);
  });

  test("an unknown speed restarts the cycle at 1x", () => {
    expect(nextSpeed(15)).toBe(60);
  });
});
