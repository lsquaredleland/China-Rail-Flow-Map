import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpeedSelect, { SPEED_MULTIPLIERS } from "../src/components/SpeedSelect";

describe("SpeedSelect (phone speed dropdown)", () => {
  test("1x, 2x, 3x map to 60, 30, 20 seconds per day", () => {
    expect(SPEED_MULTIPLIERS.map((o) => [o.label, o.secs])).toEqual([["1×", 60], ["2×", 30], ["3×", 20]]);
  });

  test("the current speed is the selected option", () => {
    const h = renderToStaticMarkup(<SpeedSelect speed={30} onSetSpeed={() => {}} />);
    expect(h).toMatch(/<option value="30" selected="">2×<\/option>/);
  });

  test("choosing each option calls setSpeed with its seconds", () => {
    const calls: number[] = [];
    const el = SpeedSelect({ speed: 30, onSetSpeed: (s) => calls.push(s) }) as React.ReactElement<any>;
    for (const o of SPEED_MULTIPLIERS) el.props.onChange({ target: { value: String(o.secs) } });
    expect(calls).toEqual([60, 30, 20]);
  });
});
