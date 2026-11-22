// lib/geomOcti: the schematic geometry twin is checked against the shared pack,
// swaps only geometry (ids, lines, speeds kept), and the shipped asset matches
// the shipped shared pack and national trains.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import type { NationalTrainsPack, SharedData } from "../src/types";
import { applyOcti, applyOctiTrains, geomFromUrl, mercDeg, requireOcti, urlWithGeom, type OctiPack } from "../src/lib/geomOcti";
import { decodeFlat } from "../src/lib/decode";

const load = <T>(f: string): T => JSON.parse(brotliDecompressSync(readFileSync(`public/assets/${f}.json.br`)).toString());

function tiny(): { shared: SharedData; octi: OctiPack } {
  const shared = {
    fmt: 6,
    build: { a: 1 },
    city_table: [{ zh: "甲", en: "A", pt: [100, 30] }],
    station_table: [
      { zh: "甲站", en: "A", pt: [100, 30], city: 0 },
      { zh: "乙站", en: "B", pt: [101, 30], city: 0 },
    ],
    train_table: [],
    sections: [{ g: "_seK_gsR", l: [0], v: 300, h: 1 }],
    in_sections: [{ g: "_seK_gsR", l: [0], v: 300 }],
    lines: [["L", "L"]],
    network: ["_seK_gsR"],
    throats: ["_seK_gsR"],
  } as unknown as SharedData;
  const octi: OctiPack = {
    fmt: 6,
    build: { a: 1 },
    layout: "octi-stitched",
    plane: "lon-mercdeg",
    n_sec: 1,
    n_in: 1,
    n_thr: 1,
    n_extra: 1,
    n_station: 2,
    n_city: 1,
    sections: ["S"],
    in_sections: ["I"],
    network: ["N1", "N2"],
    throats: ["T"],
    extra: ["X"],
    station_pt: [[100.5, 30.5], null],
    city_pt: [[100.4, 30.4]],
  };
  return { shared, octi };
}

describe("geomOcti", () => {
  test("geomFromUrl and urlWithGeom", () => {
    expect(geomFromUrl("?geom=octi&skin=terminal")).toBe("octi");
    expect(geomFromUrl("?geom=snap")).toBe("real");
    expect(geomFromUrl("")).toBe("real");
    expect(urlWithGeom("https://x.test/?skin=terminal&city=SZ#a", "octi")).toBe("/?skin=terminal&city=SZ&geom=octi#a");
    expect(urlWithGeom("https://x.test/?geom=octi&skin=terminal", "real")).toBe("/?skin=terminal");
  });

  test("applyOcti swaps geometry and points only", () => {
    const { shared, octi } = tiny();
    requireOcti(octi, shared);
    const s = applyOcti(shared, octi);
    expect(s.sections[0]).toEqual({ ...shared.sections[0], g: "S" });
    expect(s.in_sections[0].g).toBe("I");
    expect(s.network).toEqual(["N1", "N2"]);
    expect(s.throats).toEqual(["T"]);
    expect(s.station_table[0].pt).toEqual([100.5, 30.5]);
    expect(s.station_table[1]).toBe(shared.station_table[1]); // null: kept
    expect(s.city_table[0]).toEqual({ ...shared.city_table[0], pt: [100.4, 30.4] });
    expect(shared.sections[0].g).toBe("_seK_gsR"); // input untouched
    const t = applyOctiTrains({ extra: ["x"] } as NationalTrainsPack, octi);
    expect(t.extra).toEqual(["X"]);
  });

  test("mercDeg", () => {
    expect(mercDeg(0)).toBeCloseTo(0, 9);
    expect(mercDeg(45)).toBeCloseTo(50.498, 2);
  });

  test("a layout from another pack is refused", () => {
    const { shared, octi } = tiny();
    expect(() => requireOcti({ ...octi, build: { a: 2 } }, shared)).toThrow(/does not match/);
    expect(() => requireOcti({ ...octi, n_sec: 2 }, shared)).toThrow(/does not match/);
    expect(() => applyOctiTrains({ extra: [] } as unknown as NationalTrainsPack, octi)).toThrow(/national trains/);
  });

  test("the shipped asset matches the shipped packs", () => {
    const shared = load<SharedData>("atlas-v2-shared");
    const octi = load<OctiPack>("atlas-v2-octi");
    const nat = load<NationalTrainsPack>("atlas-v2-national-trains");
    requireOcti(octi, shared);
    expect(applyOctiTrains(nat, octi).extra.length).toBe(nat.extra.length);
    // every section decodes to >= 2 points; most lie on octilinear legs
    let legs = 0,
      oct = 0;
    for (const g of octi.sections) {
      const f = decodeFlat(g);
      expect(f.length).toBeGreaterThanOrEqual(4);
      for (let i = 2; i < f.length; i += 2) {
        const dx = Math.abs(f[i] - f[i - 2]),
          dy = Math.abs(f[i + 1] - f[i - 1]);
        if (dx + dy < 0.05) continue; // short pieces: corner rounding
        legs++;
        if (Math.min(dx, dy, Math.abs(dx - dy)) < 0.02 * Math.max(dx, dy) + 2e-4) oct++;
      }
    }
    expect(oct / legs).toBeGreaterThan(0.9);
  });
});
