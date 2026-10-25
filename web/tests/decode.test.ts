// Pack-level invariants on the committed pack (O13): decode contract,
// path ids in range, class columns, geometric continuity of paths.
import { describe, expect, test } from "bun:test";
import { DATA_FMT, decodeSecs, requireFmt } from "../src/lib";
import { pack } from "./fixture";

describe("pack decode", () => {
  test("every file carries the supported fmt", () => {
    const p = pack();
    expect(DATA_FMT).toBe(6);
    for (const f of [p.shared.fmt, p.map.fmt, p.tablesRaw.fmt]) expect(() => requireFmt(f, "x")).not.toThrow();
    expect(() => requireFmt(5, "x")).toThrow(/unsupported data format 5/);
  });

  test("origins line up across map and tables", () => {
    const p = pack();
    expect(p.map.origins.length).toBe(p.tables.origins.length);
    expect(p.map.origins.length).toBe(102);
    for (let i = 0; i < p.map.origins.length; i++) {
      const o = p.atlas.data.origins[i];
      expect(o.dep_secs.length).toBe(o.deps.length);
      expect(o.dep_chord_legs.length).toBe(o.deps.length);
      expect(o.dep_stop_pos.length).toBe(o.deps.length);
    }
  });

  test("path ids < sections.len() + throats.len()", () => {
    const p = pack();
    const limit = p.shared.sections.length + p.shared.throats.length;
    let max = -1;
    for (const path of p.tablesRaw.paths as number[][])
      for (const v of path) max = Math.max(max, v < 0 ? ~v : v);
    expect(max).toBeLessThan(limit);
    // after decodeSecs only real flow sections remain
    const nSec = p.shared.sections.length;
    for (const path of (p.tablesRaw.paths as number[][]).slice(0, 500))
      for (const s of decodeSecs(path, nSec).secs) expect(s).toBeLessThan(nSec);
  });

  test("flow section ids are in range, strictly increasing after decodeFlows", () => {
    const p = pack();
    const nSec = p.shared.sections.length;
    for (const o of p.map.origins) {
      let prev = -1;
      for (const f of o.flows) {
        expect(f[0]).toBeGreaterThan(prev);
        expect(f[0]).toBeLessThan(nSec);
        prev = f[0];
      }
    }
  });

  test("sum(class cols) == total per flow row", () => {
    const p = pack();
    let bad = 0;
    let rows = 0;
    for (const o of p.map.origins)
      for (const f of o.flows) {
        rows++;
        let s = 0;
        for (let k = 2; k < f.length; k++) s += f[k] || 0;
        if (s !== f[1]) bad++;
      }
    expect(rows).toBeGreaterThan(250000);
    // Totals and class columns agree on the committed pack. (A-5 in the
    // fable review is a different defect: the split between classes can be
    // wrong where trains swap mid-chain, with sums still equal; O18/A-5 fix
    // has no effect on this invariant.)
    expect(bad).toBe(0);
  });

  test("stop positions and chord legs index inside their path", () => {
    const p = pack();
    for (const o of p.tables.origins)
      for (let i = 0; i < o.deps.length; i++) {
        const n = o.dep_secs[i].length;
        for (const sp of o.dep_stop_pos[i]) {
          expect(sp).toBeGreaterThanOrEqual(0);
          expect(sp).toBeLessThanOrEqual(n);
        }
        for (const [, s0, s1] of o.dep_chord_legs[i]) {
          expect(s0).toBeGreaterThanOrEqual(0);
          expect(s1).toBeLessThan(n);
        }
      }
  });
});

describe("path continuity", () => {
  // Endpoint gap between consecutive path elements (sections and throats,
  // honouring the reverse bit), outside chord legs. Chord legs are the only
  // places a train is meant to jump. Mirrors check_client_decode.mjs, which
  // used a 96/111 km-per-degree flat approximation.
  const JUMP_KM = 10;
  function gaps() {
    const p = pack();
    const { sec, thr } = p.atlas;
    const nSec = p.shared.sections.length;
    const ends = (v: number) => {
      const id = v < 0 ? ~v : v;
      const set = id < nSec ? sec : thr;
      const i = id < nSec ? id : id - nSec;
      const o = set.off[i];
      const n = set.len[i];
      const a = [set.pts[o], set.pts[o + 1]];
      const b = [set.pts[o + 2 * (n - 1)], set.pts[o + 2 * (n - 1) + 1]];
      return v < 0 ? [b, a] : [a, b];
    };
    const km = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * 96, (a[1] - b[1]) * 111);
    const chords = new Map<number, [number, number, number][]>(p.tablesRaw.chords);
    const out: { train: string; pos: number; km: number }[] = [];
    let nChordTrains = 0;
    (p.tablesRaw.paths as number[][]).forEach((path, t) => {
      const legs = chords.get(t) || [];
      if (legs.length) nChordTrains++;
      const skip = new Set<number>();
      for (const [, s0, s1] of legs) for (let k = s0; k <= s1; k++) skip.add(k);
      for (let k = 1; k < path.length; k++) {
        if (skip.has(k)) continue;
        const g = km(ends(path[k - 1])[1], ends(path[k])[0]);
        if (g >= JUMP_KM) out.push({ train: p.shared.train_table[t].code, pos: k, km: g });
      }
    });
    return { out, nChordTrains };
  }

  test(`jumps >= ${JUMP_KM} km outside chord legs`, () => {
    const { out, nChordTrains } = gaps();
    expect(nChordTrains).toBe(3);
    // KNOWN: the committed pack has 7 unflagged jumps of 23-27 km on 7
    // trains (K1160 K1132 C780 K903 K1068 K904 K876), i.e. spots where the
    // router left a hole without marking a chord leg. The target is 0; when
    // a rebuild fixes them this count must drop, so update it then.
    expect(out.map((g) => g.train).sort()).toEqual(
      ["C780", "K1068", "K1132", "K1160", "K876", "K903", "K904"].sort(),
    );
    expect(out.length).toBe(7);
    // and nothing may be worse than the known worst case
    expect(Math.max(...out.map((g) => g.km))).toBeLessThan(30);
  });
});
