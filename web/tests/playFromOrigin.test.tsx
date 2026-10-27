// "Play from origin" and the stop effect of an isolated train.
import { describe, expect, test } from "bun:test";
import { startPlayback } from "../src/hooks/useAnimationClock";
import { buildTrainBuffers } from "../src/components/map/deck/layers/trains";
import { nationalRings } from "../src/components/map/deck/layers/national";
import type { ActiveTrainVM } from "../src/types";

describe("play from origin", () => {
  test("enables the animation, sets the clock to the departure, then plays", () => {
    const calls: string[] = [];
    startPlayback(
      {
        setAnimEnabled: (on) => calls.push("enabled:" + on),
        setTime: (m) => calls.push("time:" + m),
        setPlaying: (on) => calls.push("playing:" + on),
      },
      1261,
    );
    expect(calls).toEqual(["enabled:true", "time:1261", "playing:true"]);
  });
  test("a missing map is a no-op", () => {
    expect(() => startPlayback(null, 5)).not.toThrow();
  });
});

describe("isolated train dwelling at a station", () => {
  const train = (dwell: boolean): ActiveTrainVM =>
    ({
      lon: 113, lat: 23, heading: 0, cls: "G", code: "G1", fromStation: "a", toStation: "b",
      depTime: "00:00", arrTime: "01:00", durMins: 60, progressPct: 50, isDwelling: dwell,
    }) as ActiveTrainVM;

  test("the stop rings are above the faded isolation ring and larger than it", () => {
    const rings = buildTrainBuffers([train(true)], 100, "G1", null, null).rings;
    expect(rings).toHaveLength(3);
    const [iso, inner, outer] = rings;
    expect(iso.col[3]).toBeLessThan(255); // the isolation ring steps back
    expect(inner.r).toBeGreaterThan(iso.r);
    expect(outer.r).toBeGreaterThan(inner.r);
    expect(inner.col[3]).toBe(255);
  });
  test("moving, the isolation ring is as before", () => {
    const rings = buildTrainBuffers([train(false)], 100, "G1", null, null).rings;
    expect(rings).toHaveLength(1);
    expect(rings[0].r).toBe(9);
    expect(rings[0].col[3]).toBe(255);
  });
  test("national dots use the same rings", () => {
    const f = {
      count: 1,
      qOf: Int32Array.of(0),
      pos: Float32Array.of(113, 23, 1, 0, 0, 16), // flags: class 0, dwell bit
    } as never;
    const tl = { tIdx: Int32Array.of(0), cls: Uint8Array.of(0) } as never;
    const atlas = { data: { train_table: [{ code: "G1" }] } } as never;
    const [layer] = nationalRings(f, tl, atlas, { hover: null, selected: null, isolated: "G1" });
    expect((layer.props.data as unknown[]).length).toBe(3);
  });
});
