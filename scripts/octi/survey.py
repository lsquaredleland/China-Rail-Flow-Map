# usage: python3 -I survey.py shared.json national-trains.json atlas-v2-octi.json out.json
# Layout survey: where the schematic disagrees with the real network.
#   crossings   section pairs that cross in the schematic but not in reality (lines swapped
#               or routed through each other; pairs sharing an end are ignored)
#   flipped     sections >= 30 km whose drawn direction differs from the real one by > 100 deg
#   stretched   sections >= 20 km drawn > 3x (+30 km) their real length
#   squashed    sections >= 20 km drawn < 1/4 of their real length
#   displaced   section midpoints > 120 km from where the rest of their area moved
#               (local residual: the median shift of sections within 1 deg is removed)
#   breaks      consecutive sections on train paths drawn apart (> max(3 km, 3x real gap))
# Findings are clustered into ~1 deg cells and ranked by score, with train traffic weight.
import json, math, sys, collections
PACK, NAT, OCTI, OUT = sys.argv[1:5]

def dec(s):
    pts = []; lat = lon = 0; i = 0; n = len(s)
    while i < n:
        for k in (0, 1):
            sh = r = 0
            while True:
                b = ord(s[i]) - 63; i += 1; r |= (b & 0x1f) << sh; sh += 5
                if b < 0x20: break
            v = ~(r >> 1) if r & 1 else r >> 1
            if k == 0: lat += v
            else: lon += v
        pts.append((lon / 1e4, lat / 1e4))
    return pts

M = lambda p: (p[0], math.degrees(math.log(math.tan(math.pi / 4 + math.radians(p[1]) / 2))))
pack = json.load(open(PACK)); nat = json.load(open(NAT)); o = json.load(open(OCTI))
n = len(pack['sections'])
G = [[M(p) for p in dec(s['g'])] for s in pack['sections']]   # real, plane
S = [dec(g) for g in o['sections']]                            # schematic, plane already
KM = 111.0
L = lambda q: sum(math.dist(q[i], q[i + 1]) for i in range(len(q) - 1))

def dp(q, tol):
    if len(q) < 3: return list(q)
    keep = [False] * len(q); keep[0] = keep[-1] = True; st = [(0, len(q) - 1)]
    while st:
        i, j = st.pop(); best, bd = -1, tol
        (ax, ay), (bx, by) = q[i], q[j]; dx, dy = bx - ax, by - ay; l2 = dx * dx + dy * dy
        for k in range(i + 1, j):
            px, py = q[k]
            t = 0 if l2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
            d = math.hypot(ax + t * dx - px, ay + t * dy - py)
            if d > bd: bd, best = d, k
        if best > 0: keep[best] = True; st += [(i, best), (best, j)]
    return [p for p, k in zip(q, keep) if k]

def mid(q):
    T = L(q) / 2; acc = 0
    for i in range(len(q) - 1):
        d = math.dist(q[i], q[i + 1])
        if acc + d >= T:
            r = 0 if d == 0 else (T - acc) / d
            return (q[i][0] + (q[i + 1][0] - q[i][0]) * r, q[i][1] + (q[i + 1][1] - q[i][1]) * r)
        acc += d
    return q[-1]

# traffic weight: trains per section (national paths)
ns, nt = nat['n_sec'], nat['n_thr']
traffic = collections.Counter()
for p in nat['paths']:
    for x in set(abs(v) for v in p):
        if x < ns: traffic[x] += 1

findings = []   # (kind, section(s), point(plane, real), detail)
def add(kind, secs, detail):
    s0 = secs[0]
    findings.append({'kind': kind, 'secs': secs, 'pt': mid(G[s0]), 'trains': max(traffic[s] for s in secs), **detail})

# --- crossings
def segs(q):
    return [(q[i], q[i + 1]) for i in range(len(q) - 1) if math.dist(q[i], q[i + 1]) > 1e-9]
def inter(a, b, c, d):
    def o(p, q, r): return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2, d3, d4 = o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d)
    e = 1e-12
    return ((d1 > e and d2 < -e) or (d1 < -e and d2 > e)) and ((d3 > e and d4 < -e) or (d3 < -e and d4 > e))
def cross_pairs(Q, cell):
    grid = collections.defaultdict(list); SG = []
    for s in range(n):
        sg = segs(Q[s]); SG.append(sg)
        for k, (a, b) in enumerate(sg):
            for cx in range(int(math.floor(min(a[0], b[0]) / cell)), int(math.floor(max(a[0], b[0]) / cell)) + 1):
                for cy in range(int(math.floor(min(a[1], b[1]) / cell)), int(math.floor(max(a[1], b[1]) / cell)) + 1):
                    grid[(cx, cy)].append((s, k))
    out = set()
    for items in grid.values():
        if len(items) < 2: continue
        for i in range(len(items)):
            s1, k1 = items[i]
            for j in range(i + 1, len(items)):
                s2, k2 = items[j]
                if s1 == s2: continue
                pr = (min(s1, s2), max(s1, s2))
                if pr in out: continue
                if inter(*SG[s1][k1], *SG[s2][k2]): out.add(pr)
    return out
Gs = [dp(q, 0.003) for q in G]
real_x = cross_pairs(Gs, 0.25)
sch_x = cross_pairs(S, 0.25)
ends = lambda Q, s: {tuple(round(c, 5) for c in Q[s][0]), tuple(round(c, 5) for c in Q[s][-1])}
for a, b in sorted(sch_x - real_x):
    if ends(G, a) & ends(G, b): continue
    if L(G[a]) * KM < 1 or L(G[b]) * KM < 1: continue
    add('crossing', [a, b], {'km': round(min(L(G[a]), L(G[b])) * KM, 1)})

# --- per-section shape
for s in range(n):
    rl, sl = L(G[s]) * KM, L(S[s]) * KM
    if rl >= 30:
        r = (G[s][-1][0] - G[s][0][0], G[s][-1][1] - G[s][0][1]); q = (S[s][-1][0] - S[s][0][0], S[s][-1][1] - S[s][0][1])
        if math.hypot(*r) * KM > 15 and math.hypot(*q) * KM > 15:
            ang = abs((math.degrees(math.atan2(r[1], r[0]) - math.atan2(q[1], q[0])) + 180) % 360 - 180)
            if ang > 100: add('flipped', [s], {'deg': round(ang), 'km': round(rl)})
    if rl >= 20 and sl > 3 * rl + 30: add('stretched', [s], {'real_km': round(rl), 'drawn_km': round(sl)})
    if rl >= 20 and sl < rl / 4: add('squashed', [s], {'real_km': round(rl), 'drawn_km': round(sl)})

# --- displacement, local residual
mids_r = [mid(G[s]) for s in range(n)]; mids_s = [mid(S[s]) for s in range(n)]
shift = [(mids_s[s][0] - mids_r[s][0], mids_s[s][1] - mids_r[s][1]) for s in range(n)]
cells = collections.defaultdict(list)
for s in range(n): cells[(int(mids_r[s][0]), int(mids_r[s][1]))].append(s)
for s in range(n):
    cx, cy = int(mids_r[s][0]), int(mids_r[s][1])
    nb = [t for dx in (-1, 0, 1) for dy in (-1, 0, 1) for t in cells.get((cx + dx, cy + dy), ()) if L(G[t]) * KM > 2]
    if len(nb) < 5: continue
    mx = sorted(shift[t][0] for t in nb)[len(nb) // 2]; my = sorted(shift[t][1] for t in nb)[len(nb) // 2]
    res = math.hypot(shift[s][0] - mx, shift[s][1] - my) * KM
    if res > 120 and L(G[s]) * KM > 2: add('displaced', [s], {'residual_km': round(res)})

# --- train-path breaks
pairs = collections.Counter()
for p in nat['paths']:
    sec = [abs(x) for x in p if abs(x) < ns]
    for a, b in zip(sec, sec[1:]):
        if a != b: pairs[(a, b)] += 1
gap = lambda Q, a, b: min(math.dist(x, y) for x in (Q[a][0], Q[a][-1]) for y in (Q[b][0], Q[b][-1])) * KM
for (a, b), c in pairs.items():
    gs, gr = gap(S, a, b), gap(G, a, b)
    if gs > max(3, 3 * gr): add('break', [a, b], {'drawn_gap_km': round(gs, 1), 'real_gap_km': round(gr, 1), 'trains': c})

# --- cluster
W = {'crossing': 2, 'flipped': 3, 'stretched': 2, 'squashed': 1, 'displaced': 2, 'break': 1}
cl = collections.defaultdict(lambda: {'n': collections.Counter(), 'score': 0.0, 'pts': [], 'trains': 0})
for f in findings:
    k = (round(f['pt'][0]), round(f['pt'][1]))
    c = cl[k]; c['n'][f['kind']] += 1; c['score'] += W[f['kind']] * (1 + math.log1p(f['trains'])); c['pts'].append(f['pt']); c['trains'] = max(c['trains'], f['trains'])
lat = lambda y: math.degrees(2 * math.atan(math.exp(math.radians(y))) - math.pi / 2)
ranked = []
for k, c in cl.items():
    x = sum(p[0] for p in c['pts']) / len(c['pts']); y = sum(p[1] for p in c['pts']) / len(c['pts'])
    ranked.append({'lon': round(x, 2), 'lat': round(lat(y), 2), 'plane_y': round(y, 2), 'score': round(c['score'], 1), 'kinds': dict(c['n']), 'max_trains': c['trains']})
ranked.sort(key=lambda r: -r['score'])
tot = collections.Counter(f['kind'] for f in findings)
json.dump({'totals': tot, 'clusters': ranked, 'findings': findings}, open(OUT, 'w'))
print(json.dumps({'totals': tot, 'crossings_real': len(real_x), 'crossings_schematic': len(sch_x)}))
for r in ranked[:25]: print(json.dumps(r))
