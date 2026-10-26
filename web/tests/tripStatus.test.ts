import { describe, expect, test } from "bun:test";
import { tripStatus, unrollStops } from "../src/lib";
import type { AlignedStop } from "../src/lib";
import type { ScheduleStop } from "../src/types";

const hm = (m: number) => (m < 0 ? "—" : `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
const stop = (i: number, arrMins: number, depMins: number): ScheduleStop => ({
  stIdx: i, stZh: `站${i}`, stEn: `St${i}`, arr: hm(arrMins), dep: hm(depMins),
  arrMins, depMins, dayOff: 0, dwellMins: 0,
});

describe("unrollStops", () => {
  test("counts midnight rollovers on one monotonic clock", () => {
    const u = unrollStops([stop(0, -1, 22 * 60), stop(1, 23 * 60 + 30, 23 * 60 + 40), stop(2, 1 * 60, 1 * 60 + 10), stop(3, 5 * 60, -1)]);
    expect(u.stops.map((s) => [s.unrolledArr, s.unrolledDep])).toEqual([
      [-1, 1320],
      [1410, 1420],
      [1500, 1510],
      [1740, -1],
    ]);
    expect(u.day).toBe(1);
    expect(u.prev).toBe(300);
  });
  test("no stops", () => {
    expect(unrollStops([]).stops).toEqual([]);
  });
});

describe("tripStatus", () => {
  const al = (i: number, arr: number, dep: number): AlignedStop => ({ ...stop(i, arr, dep), simArrMins: arr, simDepMins: dep });
  const stops = [al(0, -1, 100), al(1, 160, 170), al(2, 230, -1)];
  test("before departure", () => {
    const s = tripStatus(stops, 40)!;
    expect(s.state).toBe("pre");
    expect(s.text).toBe("Departs 站0 (St0) in 60m (at 01:40)");
  });
  test("at a station", () => {
    const s = tripStatus(stops, 165)!;
    expect(s).toMatchObject({ state: "stopped", stopIdx: 1 });
    expect(s.text).toBe("Stopped at 站1 (St1) · Departs in 5m (02:50)");
  });
  test("between stops", () => {
    const s = tripStatus(stops, 130)!;
    expect(s).toMatchObject({ state: "transit", fromIdx: 0, toIdx: 1, eta: 30, finalEta: 100, finalEtaStr: "1h 40m" });
    expect(s.text).toBe("En route: 站0 (St0) ➔ 站1 (St1) · ETA in 1h 40m (03:50)");
  });
  test("arrived", () => {
    expect(tripStatus(stops, 230)).toEqual({ state: "post", text: "Completed journey to 站2 (St2) at 03:50" });
  });
  test("no stops", () => {
    expect(tripStatus(null, 0)).toBeNull();
    expect(tripStatus([], 0)).toBeNull();
  });
});
