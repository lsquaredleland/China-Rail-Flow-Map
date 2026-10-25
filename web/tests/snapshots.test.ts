// Snapshot tests on the committed pack: per-hour departed/arrived counts and
// per-section flow at fixed times for three origins. They pin the output of
// the whole decode + timeline chain, so any pack swap (or timeline change)
// shows up as a reviewable diff of tests/__snapshots__. Update deliberately
// with `bun test --update-snapshots` after a pack rebuild; section ids
// renumber with the pack (O18), so expect the per-section snapshot to churn
// then, and only that one.
import { describe, expect, test } from "bun:test";
import { origin } from "./fixture";

const SNAP_ORIGINS = ["成都", "北京", "上海"];

describe("snapshots", () => {
  for (const zh of SNAP_ORIGINS) {
    test(`${zh}: departed/arrived per hour`, () => {
      const tl = origin(zh).timeline;
      const rows: [number, number, number][] = [];
      for (let h = 0; h * 60 <= tl.totalMins; h++) rows.push([h, tl.getDepartedCount(h * 60), tl.getArrivedCount(h * 60)]);
      expect({ totalMins: tl.totalMins, totalTrains: tl.totalTrains, rows }).toMatchSnapshot();
    });

    test(`${zh}: per-section flow at 06:00 / 12:00 / 18:00 / 24:00`, () => {
      const o = origin(zh);
      const tl = o.timeline;
      const at = [6, 12, 18, 24].map((h) => (h * 60) / tl.stepMins);
      // the 15 busiest sections (static n desc, then id) at those times
      const top = [...o.flows].sort((a, b) => b.n - a.n || a.s - b.s).slice(0, 15);
      const rows = top.map((f) => [f.s, f.n, ...at.map((i) => tl.secFlowSteps.get(f.s)?.[i] ?? 0)]);
      expect({ stepMins: tl.stepMins, columns: "[section, final n, @06, @12, @18, @24]", rows }).toMatchSnapshot();
    });
  }
});
