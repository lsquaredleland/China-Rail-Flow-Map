// Fixture inputs for the tooltip tests: one hit per tooltip branch on the
// committed pack, built deterministically.
import type { ActiveTrainVM, DecodedSet, Direction, DistUnit, Hit, OriginVM } from "../src/types";
import { isFerrySection } from "../src/lib";
import { origin, pack } from "./fixture";

export interface Case {
  name: string;
  hit: Hit;
  cur: OriginVM;
  set: DecodedSet | null;
  P: { direction: Direction; distUnit: DistUnit; panelDest: any; dark: boolean };
}

const train = (over: Partial<ActiveTrainVM>): ActiveTrainVM => ({
  lon: 113.2,
  lat: 23.1,
  heading: 0,
  cls: "G",
  code: "G1001",
  fromStation: "广州南",
  fromStationEn: "Guangzhounan",
  toStation: "北京西",
  toStationEn: "Beijingxi",
  depTime: "08:00",
  arrTime: "16:30",
  durMins: 510,
  progressPct: 42,
  ...over,
});

export function cases(): Case[] {
  const cur = origin("广州");
  const atlas = pack().atlas;
  const base = { direction: "out" as Direction, distUnit: "km" as DistUnit, panelDest: null, dark: false };
  const sec = atlas.sec;
  let ferry = -1;
  for (let s = 0; s < sec.len.length; s++) if (isFerrySection(sec.bb, s)) { ferry = s; break; }
  const dest = cur.dests[0];
  const src = cur.dests[1] as any; // the out-only fixture has no inbound sources; same CityPointVM shape
  const oc = cur.dests.find((d) => atlas.data.origins.some((o: any) => o.zh === d.zh)) ?? dest;
  const inCase = { ...base, direction: "in" as Direction, distUnit: "mi" as DistUnit };
  return [
    { name: "origin out", hit: { kind: "origin" }, cur, set: sec, P: base },
    { name: "origin in", hit: { kind: "origin" }, cur, set: atlas.inSec, P: inCase },
    { name: "station out km", hit: { kind: "station", station: dest }, cur, set: sec, P: base },
    { name: "station in mi", hit: { kind: "station", station: src }, cur, set: atlas.inSec, P: inCase },
    { name: "station selected non-origin", hit: { kind: "station", station: dest }, cur, set: sec, P: { ...base, panelDest: dest } },
    { name: "station selected origin city", hit: { kind: "station", station: oc }, cur, set: sec, P: { ...base, panelDest: oc } },
    { name: "chord", hit: { kind: "chord", chord: { a: 0, b: 1, n: 3 } as any }, cur, set: sec, P: base },
    { name: "seg 1", hit: { kind: "seg", s: 0, n: 1 }, cur, set: sec, P: base },
    { name: "seg many", hit: { kind: "seg", s: 0, n: 57 }, cur, set: sec, P: base },
    { name: "seg sub out", hit: { kind: "seg", s: 0, n: 57, subN: 12 }, cur, set: sec, P: { ...base, panelDest: dest } },
    { name: "seg sub in", hit: { kind: "seg", s: 0, n: 9, subN: 1 }, cur, set: sec, P: { ...inCase, panelDest: src } },
    { name: "seg ferry light", hit: { kind: "seg", s: ferry, n: 20 }, cur, set: sec, P: base },
    { name: "seg ferry dark", hit: { kind: "seg", s: ferry, n: 20 }, cur, set: sec, P: { ...base, dark: true } },
    { name: "train G", hit: { kind: "train", train: train({}) }, cur, set: sec, P: base },
    { name: "train K same names on chord", hit: { kind: "train", train: train({ cls: "K", fromStationEn: "广州", fromStation: "广州", onChord: true }) }, cur, set: sec, P: base },
    { name: "train boarding origin", hit: { kind: "train", train: train({ isDwelling: true, dwellStatus: "origin", dwellStation: "广州南", dwellStationEn: "Guangzhounan", dwellDetail: "departs 08:00" }) }, cur, set: sec, P: base },
    { name: "train arrived dest", hit: { kind: "train", train: train({ isDwelling: true, dwellStatus: "dest", dwellStation: "北京西", dwellStationEn: "Beijingxi" }) }, cur, set: sec, P: base },
    { name: "train boarding stop", hit: { kind: "train", train: train({ cls: "T", isDwelling: true, dwellStatus: "stop", dwellStation: "武汉", dwellDetail: "2 min" }) }, cur, set: sec, P: base },
  ];
}
