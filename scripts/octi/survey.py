"""Layout survey: where the schematic disagrees with the real network.

usage: python3 -I survey.py shared.json national-trains.json atlas-v2-octi.json out.json

Every section of the asset is compared with its real track. One function per check, each
adding findings {kind, secs, pt, trains, ...}:
  check_crossings   crossing   section pairs that cross in the schematic but not in reality
                               (lines swapped or routed through each other)
  check_overlaps    overlap    pairs drawn on top of each other (>= OVERLAP_MIN_KM) whose real
                               tracks do not share a corridor
  check_sides       side       pairs that really run alongside each other (5 to 33 km apart,
                               within 30 degrees of parallel) but are drawn on the wrong side
                               of each other for half of the stretch or more; a real crossing
                               swaps the side in both, so it is not a fault
  check_shapes      flipped    sections drawn pointing the wrong way
                    stretched  sections drawn far too long
                    squashed   sections drawn far too short
  check_displaced   displaced  section midpoints far from where the rest of their area moved
                               (the median shift of the sections within 1 degree is removed)
  check_breaks      break      consecutive sections on train paths drawn apart
Pairs sharing a real end are one line and are never a crossing or an overlap.
`fidelity` gives one set of numbers for the whole map: how far the drawn track is from the
real track once the local area shift is removed (per point at the same fraction of the
section, and per section as the Hausdorff distance), weighted by real length.
`cluster` groups the findings into ~1 degree cells and ranks them by score, with train
traffic as weight. The geometry and the corridor / side tests are octi_geom's, the same
ones export_layout.py routes with.
"""
import json, math, sys, collections, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # -I leaves the script's directory out
from octi_geom import (KM_PER_DEG, REAL_SIMPLIFY, SIDE_MIN_KM, SIDE_STEP, PL, PLi, alongside, cumlen, dec, dp, drawn_side,
                       midpoint, overlap_len, pdist, plen, seg_grid, side_samples, walk, xkind)

# --- thresholds (km, real length unless said otherwise)
KM = KM_PER_DEG
CROSS_MIN_KM = 1         # crossings: both sections at least this long
OVERLAP_MIN_KM = 3       # overlaps: drawn on top of each other for at least this
SIDE_MIN_WRONG = 2       # sides: a pair needs this many wrong samples, and half of its samples
FLIP_MIN_KM, FLIP_CHORD_KM, FLIP_DEG = 30, 15, 100   # flipped: length, end-to-end distance (real and drawn), angle
LONG_KM = 20             # stretched / squashed: sections at least this long
STRETCH, STRETCH_KM = 3, 30   # stretched: drawn > STRETCH x real + STRETCH_KM
SQUASH = 1 / 4           # squashed: drawn < SQUASH x real
DISPLACED_KM = 120       # displaced: residual of the midpoint's shift
AREA_MIN_KM, AREA_MIN_N = 2, 5   # the local shift: sections longer than this, at least this many within 1 degree
BREAK_KM, BREAK_RATIO = 3, 3     # breaks: drawn gap > max(BREAK_KM, BREAK_RATIO x real gap)
WEIGHT = {'crossing': 2, 'overlap': 1, 'side': 2, 'flipped': 3, 'stretched': 2, 'squashed': 1, 'displaced': 2, 'break': 1}
TOP = 25                 # clusters printed


class Survey:
    """The real tracks G (plane), their simplification Gs, the drawing S (plane), train
    traffic per section, and the findings so far."""
    def __init__(self, pack, nat, asset):
        self.n = len(pack['sections']); self.nat = nat
        self.G = [[PL(p) for p in dec(s['g'])] for s in pack['sections']]
        self.Gs = [dp(q, REAL_SIMPLIFY) for q in self.G]
        self.S = [dec(g) for g in asset['sections']]
        self.cS = [cumlen(q) for q in self.S]
        self.km = [plen(q) * KM for q in self.G]
        self.long = [s for s in range(self.n) if plen(self.Gs[s]) * KM >= SIDE_MIN_KM]
        self.traffic = collections.Counter()           # trains per section (national paths)
        for p in nat['paths']:
            for x in set(abs(v) for v in p):
                if x < nat['n_sec']: self.traffic[x] += 1
        self.findings = []

    def add(self, kind, secs, **detail):
        """record a finding at the real midpoint of its first section"""
        self.findings.append({'kind': kind, 'secs': secs, 'pt': midpoint(self.G[secs[0]]), 'trains': max(self.traffic[s] for s in secs), **detail})

    def ends(self, Q, s):
        """the two end points of Q[s], rounded"""
        return {tuple(round(c, 5) for c in Q[s][0]), tuple(round(c, 5) for c in Q[s][-1])}


def cross_pairs(Q, n):
    """the pairs (a < b) of polylines Q[0..n) that properly cross"""
    out = set()
    for items in seg_grid(Q, range(n)).values():
        for i, (s1, k1) in enumerate(items):
            for s2, k2 in items[i + 1:]:
                pr = (min(s1, s2), max(s1, s2))
                if s1 != s2 and pr not in out and xkind(Q[s1][k1], Q[s1][k1 + 1], Q[s2][k2], Q[s2][k2 + 1]) == 1: out.add(pr)
    return out


def check_crossings(sv):
    """crossing: drawn crossing, no real crossing. Returns (real, drawn) crossing-pair counts."""
    real = cross_pairs(sv.Gs, sv.n); drawn = cross_pairs(sv.S, sv.n)
    for a, b in sorted(drawn - real):
        if sv.ends(sv.G, a) & sv.ends(sv.G, b): continue
        if sv.km[a] < CROSS_MIN_KM or sv.km[b] < CROSS_MIN_KM: continue
        sv.add('crossing', [a, b], km=round(min(sv.km[a], sv.km[b]), 1))
    return len(real), len(drawn)


def check_overlaps(sv):
    """overlap: drawn on top of each other, but not one corridor in reality (pairs drawn
    between the same two points are a bundle). Returns the total km."""
    drawn = [s for s in range(sv.n) if plen(sv.S[s]) > 1e-6]; near = set()
    for items in seg_grid(sv.S, drawn).values():
        ids = sorted({s for s, _ in items})
        near.update((a, b) for i, a in enumerate(ids) for b in ids[i + 1:])
    total = 0.0
    for a, b in sorted(near):
        if sv.ends(sv.G, a) & sv.ends(sv.G, b) or sv.ends(sv.S, a) == sv.ends(sv.S, b): continue
        ol = overlap_len(sv.S[a], sv.S[b]) * KM
        if ol >= OVERLAP_MIN_KM and alongside(sv.Gs[a], sv.Gs[b]) < 0.5: sv.add('overlap', [a, b], km=round(ol, 1)); total += ol
    return total


def check_sides(sv):
    """side: really alongside, drawn on the wrong side. Returns the sample statistics."""
    n = bad = merged = unclear = 0
    for a, rows in sorted(side_samples(sv.Gs, sv.long).items()):
        per = collections.defaultdict(lambda: [0, 0])      # other section -> [samples, wrong]
        for u, b, f, sg in rows:
            d = drawn_side(sv.S[a], sv.cS[a], u, sv.S[b], sv.cS[b], f); per[b][0] += 1; n += 1
            if d is None: unclear += 1
            elif d == 0: merged += 1
            elif d != sg: per[b][1] += 1; bad += 1
        for b, (tot, wrong) in sorted(per.items()):
            if a < b and wrong >= SIDE_MIN_WRONG and wrong * 2 >= tot: sv.add('side', [a, b], samples=tot, wrong=wrong)
    pct = lambda x, d: round(100 * x / max(1, n), d)
    return {'samples': n, 'wrong': bad, 'wrong_pct': pct(bad, 2), 'on_one_line_pct': pct(merged, 2), 'unclear_pct': pct(unclear, 1)}


def check_shapes(sv):
    """flipped, stretched, squashed: one section's drawing against its own real track"""
    G, S = sv.G, sv.S
    for s in range(sv.n):
        rl, sl = sv.km[s], plen(S[s]) * KM
        if rl >= FLIP_MIN_KM:
            r = (G[s][-1][0] - G[s][0][0], G[s][-1][1] - G[s][0][1]); q = (S[s][-1][0] - S[s][0][0], S[s][-1][1] - S[s][0][1])
            if math.hypot(*r) * KM > FLIP_CHORD_KM and math.hypot(*q) * KM > FLIP_CHORD_KM:
                ang = abs((math.degrees(math.atan2(r[1], r[0]) - math.atan2(q[1], q[0])) + 180) % 360 - 180)
                if ang > FLIP_DEG: sv.add('flipped', [s], deg=round(ang), km=round(rl))
        if rl >= LONG_KM and sl > STRETCH * rl + STRETCH_KM: sv.add('stretched', [s], real_km=round(rl), drawn_km=round(sl))
        if rl >= LONG_KM and sl < rl * SQUASH: sv.add('squashed', [s], real_km=round(rl), drawn_km=round(sl))


def check_displaced(sv):
    """displaced: a section's shift (drawn midpoint - real midpoint) against the median shift
    of the sections around it. Returns that local shift per section, {s: (dx, dy)}."""
    mid_r = [midpoint(q) for q in sv.G]; mid_s = [midpoint(q) for q in sv.S]
    shift = [(mid_s[s][0] - mid_r[s][0], mid_s[s][1] - mid_r[s][1]) for s in range(sv.n)]
    area = collections.defaultdict(list)
    for s in range(sv.n): area[(int(mid_r[s][0]), int(mid_r[s][1]))].append(s)
    local = {}
    for s in range(sv.n):
        cx, cy = int(mid_r[s][0]), int(mid_r[s][1])
        nb = [t for dx in (-1, 0, 1) for dy in (-1, 0, 1) for t in area.get((cx + dx, cy + dy), ()) if sv.km[t] > AREA_MIN_KM]
        if len(nb) < AREA_MIN_N: continue
        mx = sorted(shift[t][0] for t in nb)[len(nb) // 2]; my = sorted(shift[t][1] for t in nb)[len(nb) // 2]
        res = math.hypot(shift[s][0] - mx, shift[s][1] - my) * KM
        if res > DISPLACED_KM and sv.km[s] > AREA_MIN_KM: sv.add('displaced', [s], residual_km=round(res))
        local[s] = (mx, my)
    return local


def weighted_quantile(v, q):
    """the value below which the share q of the weight of [(value, weight)] lies"""
    v = sorted(v); tot = sum(w for _, w in v); acc = 0
    for x, w in v:
        acc += w
        if acc >= q * tot: return round(x, 1)


def fidelity(sv, local):
    """Distance (km) between the drawn track and the real track + its local shift: per point
    at the same fraction of the section (mean, 90%), and per section as the Hausdorff
    distance (median, 90%, max), weighted by real length."""
    pts = []; haus = []
    for s in sv.long:
        if s not in local or plen(sv.S[s]) == 0: continue
        R = [(p[0] + local[s][0], p[1] + local[s][1]) for p in sv.Gs[s]]; cR = cumlen(R); k = max(2, int(cR[-1] / SIDE_STEP))
        D = sv.S[s]; cD = sv.cS[s]; w = cR[-1] / (k + 1)
        on_real = [walk(R, cR, cR[-1] * i / k) for i in range(k + 1)]; on_drawn = [walk(D, cD, cD[-1] * i / k) for i in range(k + 1)]
        pts += [(math.dist(a, b) * KM, w) for a, b in zip(on_real, on_drawn)]
        haus.append((max(max(pdist(p, D) for p in on_real), max(pdist(p, R) for p in on_drawn)) * KM, cR[-1]))
    return {'point_km_mean': round(sum(d * w for d, w in pts) / sum(w for _, w in pts), 1), 'point_km_p90': weighted_quantile(pts, .9),
            'hausdorff_km_p50': weighted_quantile(haus, .5), 'hausdorff_km_p90': weighted_quantile(haus, .9), 'hausdorff_km_max': round(max(h for h, _ in haus), 1)}


def check_breaks(sv):
    """break: consecutive sections of a train path whose nearest ends are drawn much further
    apart than they really are"""
    pairs = collections.Counter(); ns = sv.nat['n_sec']
    for p in sv.nat['paths']:
        sec = [abs(x) for x in p if abs(x) < ns]
        for a, b in zip(sec, sec[1:]):
            if a != b: pairs[(a, b)] += 1
    gap = lambda Q, a, b: min(math.dist(x, y) for x in (Q[a][0], Q[a][-1]) for y in (Q[b][0], Q[b][-1])) * KM
    for (a, b), c in pairs.items():
        drawn, real = gap(sv.S, a, b), gap(sv.G, a, b)
        if drawn > max(BREAK_KM, BREAK_RATIO * real): sv.add('break', [a, b], drawn_gap_km=round(drawn, 1), real_gap_km=round(real, 1), trains=c)


def cluster(findings):
    """findings grouped into ~1 degree cells, worst first: score = sum of WEIGHT x (1 + log(1 + trains))"""
    cl = collections.defaultdict(lambda: {'n': collections.Counter(), 'score': 0.0, 'pts': [], 'trains': 0})
    for f in findings:
        c = cl[(round(f['pt'][0]), round(f['pt'][1]))]
        c['n'][f['kind']] += 1; c['score'] += WEIGHT[f['kind']] * (1 + math.log1p(f['trains'])); c['pts'].append(f['pt']); c['trains'] = max(c['trains'], f['trains'])
    ranked = []
    for c in cl.values():
        x = sum(p[0] for p in c['pts']) / len(c['pts']); y = sum(p[1] for p in c['pts']) / len(c['pts'])
        ranked.append({'lon': round(x, 2), 'lat': round(PLi((x, y))[1], 2), 'plane_y': round(y, 2), 'score': round(c['score'], 1), 'kinds': dict(c['n']), 'max_trains': c['trains']})
    ranked.sort(key=lambda r: -r['score'])
    return ranked


def main(argv):
    """Run every check, write all findings and clusters to out.json, print the totals and
    the TOP clusters."""
    pack_path, nat_path, asset_path, out_path = argv[:4]
    sv = Survey(json.load(open(pack_path)), json.load(open(nat_path)), json.load(open(asset_path)))
    crossings_real, crossings_drawn = check_crossings(sv)
    overlap_km = check_overlaps(sv)
    sides = check_sides(sv)
    check_shapes(sv)
    local = check_displaced(sv)
    fid = fidelity(sv, local)
    check_breaks(sv)
    ranked = cluster(sv.findings)
    summary = {'totals': collections.Counter(f['kind'] for f in sv.findings), 'fidelity': fid, 'side': sides, 'overlap_km': round(overlap_km)}
    json.dump({**summary, 'clusters': ranked, 'findings': sv.findings}, open(out_path, 'w'))
    print(json.dumps({**summary, 'crossings_real': crossings_real, 'crossings_schematic': crossings_drawn}))
    for r in ranked[:TOP]: print(json.dumps(r))


if __name__ == '__main__':
    main(sys.argv[1:])
