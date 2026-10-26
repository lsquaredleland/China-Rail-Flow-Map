// National train parity with the origin view: the timetable modal without an
// origin (full content, isolate and jump buttons, the clock folded into the
// run so a run past midnight is still "En route"), and isolating one train
// (its keep mask, its dots only, its run as a corridor).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import TrainScheduleModal from "../src/components/TrainScheduleModal";
import { formatScheduleStops } from "../src/lib";
import type { NationalTrainsData, SchedulesData } from "../src/types";
import { nationalCorridor, nationalFrame, nationalIsolated, nationalTimeline } from "../src/components/map/deck/layers/national";
import { loadJson, nationalTrains, pack } from "./fixture";

const { atlas } = pack();
const sched = loadJson<SchedulesData>("atlas-v2-schedules.json");
const stationTable = atlas.data.station_table;

/** A train whose timetable crosses midnight: some stop's time is earlier than the one before. */
function overnight(): number {
  for (let t = 0; t < atlas.data.train_table.length; t++) {
    const s = formatScheduleStops(sched, stationTable, t);
    if (!s || s.length < 3 || s[0].depMins < 0) continue;
    let prev = s[0].depMins;
    for (const x of s) {
      for (const m of [x.arrMins, x.depMins]) {
        if (m < 0) continue;
        if (m < prev - 60) return t;
        prev = m;
      }
    }
  }
  throw new Error("no overnight train in the pack");
}

const modal = (t: number, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <TrainScheduleModal
      code={atlas.data.train_table[t].code}
      trainT={t}
      trainRow={atlas.data.train_table[t]}
      onClose={() => {}}
      schedulesData={sched}
      stationTable={stationTable}
      dark={false}
      national
      direction="out"
      onToggleIsolate={() => {}}
      onJumpToTime={() => {}}
      {...over}
    />,
  );

describe("national train modal", () => {
  const t = overnight();
  const stops = formatScheduleStops(sched, stationTable, t)!;
  const first = stops[0], last = stops[stops.length - 1];

  test("full content without an origin: route line, times, isolate and jump buttons", () => {
    const h = modal(t, { currentTime: 0 });
    expect(h).toContain(first.stZh);
    expect(h).toContain(last.stZh);
    expect(h).toContain("→");
    expect(h).toContain(`<b>${first.dep}</b>`);
    expect(h).toContain("Isolate on map");
    expect(h).toContain("Play from origin");
    expect(h).toContain('class="sg-jump-btn"');
    expect(h).toContain('aria-live="polite"');
  });
  test("the isolated train offers to show all again", () => {
    expect(modal(t, { isIsolated: true })).toContain("Show all trains");
  });
  test("a run past midnight is still en route just after 00:00 (no off-by-a-day)", () => {
    // after midnight, before the run's end: the clock reads small minutes while the run's times are > 1440
    const h = modal(t, { currentTime: 5 });
    expect(h).toMatch(/En route|At station/);
    expect(h).not.toContain("Not yet departed");
  });
  test("outside its run the train waits for the next departure (not 'completed')", () => {
    // one minute before the first departure, wrapped: a day before
    const h = modal(t, { currentTime: first.depMins - 1 });
    expect(h).toContain("Not yet departed");
  });
});

describe("isolating a national train", () => {
  const data: NationalTrainsData = { trains: nationalTrains().data, schedules: atlas.schedules! };
  const { tl } = nationalTimeline(atlas, data)!;
  const code = atlas.data.train_table[tl.tIdx[7]].code;

  test("the isolated row and a keep mask holding only it", () => {
    const iso = nationalIsolated(atlas, tl, code)!;
    expect(atlas.data.train_table[tl.tIdx[iso.q]].code).toBe(code);
    expect(Array.from(iso.keep).reduce((a, b) => a + b, 0)).toBe(1);
    expect(iso.keep[iso.q]).toBe(1);
    expect(nationalIsolated(atlas, tl, "NO-SUCH-TRAIN")).toBeNull();
  });
  test("frames hold only that train's dots", () => {
    const iso = nationalIsolated(atlas, tl, code)!;
    for (const m of [0, 400, 900, 1300]) {
      const f = nationalFrame(tl, atlas, m, 100, iso.keep);
      for (let i = 0; i < f.count; i++) expect(f.qOf[i]).toBe(iso.q);
    }
  });
  test("its run is one corridor line from its first to its last position", () => {
    const iso = nationalIsolated(atlas, tl, code)!;
    const [layer] = nationalCorridor(tl, atlas, iso.q);
    expect(layer.id).toBe("nat-corridor");
    const path = (layer.props.data as number[][])[0];
    expect(path.length).toBeGreaterThanOrEqual(4);
    expect(path.every((v) => Number.isFinite(v))).toBe(true);
    // inside China's box
    expect(path[0]).toBeGreaterThan(70);
    expect(path[0]).toBeLessThan(140);
  });
});
