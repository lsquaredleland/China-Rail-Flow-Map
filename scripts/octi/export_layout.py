# usage: python3 -I export_layout.py shared.json national-trains.json graph.json map.json out.json side.json...
# Turns a stitched octi layout (stitch.py: graph + per-section mapping) into the client's
# schematic geometry asset (atlas-v2-octi.json; docs/OCTI.md). Every geometry field the client
# draws gets a schematic twin with the SAME ids and lengths, so flows, paths, trains and
# tables are untouched; the client swaps the arrays before decoding (dumb client):
#   sections[s], in_sections[s]  encoded polylines (precision 1e4, lat/lon, like `g`)
#   network                      the drawn sections (backdrop only, own count)
#   throats[t], extra[t]         station throats (shared pack, national trains `extra`)
#   station_pt[i], city_pt[i]    [lon, y]
# All schematic points are on the plane (lon, mercator y in degrees); see PL below.
#
# octi gives the starting layout. Four general rules then compare it with the real track
# and redraw what disagrees (docs/OCTI.md, "Export"); there are no per-place cases:
#   1. stations: section ends that real track joins inside a station are one point;
#   2. junctions: offsets between neighbouring junctions are pulled towards the real ones
#      (short runs firmly, long runs loosely), then every junction sits on a lattice;
#   3. free ends: a dead-end branch keeps its real offset from the junction it hangs on;
#   4. runs: every run between two junctions is the simplest octilinear route that stays
#      near its real shape and meets only the lines it really meets.
# Points that are not on the mapping (throat ends, stations, in_sections that differ from
# sections) go through one transform T: nearest section segment within SNAP_DEG, by fraction
# along that section's schematic polyline; else the offset of the nearest mapped vertex.
import json, sys, math, collections

PACK, NAT, GRAPH, MAP, OUT = sys.argv[1:6]
SIDES = sys.argv[6:]
SNAP_DEG = 0.05       # max distance from a section for the projection transform
SIMPLIFY_DEG = 0.004  # Douglas-Peucker tolerance for octi's rendered corner points (~0.4 km)
CELL = 21660 / 111319.49   # octi's grid cell (-g 21660, web-mercator metres) in plane degrees
JOIN_KM = 12.0        # widest station: >= the longest throat (11.7 km)
LOOP_KM = 5.0         # a section longer than this is never collapsed into a station
STEP = round(CELL / 4, 4)  # the lattice junctions and bends sit on (a multiple of the asset's 1e-4 precision)
SMOOTH = 1.0          # how firmly a junction holds octi's point against its runs' real offsets (per plane degree)
STIFF = CELL / 2      # runs shorter than this pull no harder (junctions of one station complex stay apart)
RELAX_ITERS = 200
FIT = 1.5 * CELL      # a run is drawn within this distance of its real shape
SHAPES = (CELL, CELL / 2, CELL / 4)   # Douglas-Peucker tolerances of the real-shape routes, simplest first
CORRIDOR = 0.05       # real tracks this close (plane degrees, ~5 km) share a corridor
SWEEPS = 4            # passes over all runs (each run is routed against the others' routes)


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


def enc(pts):
    out = []; plat = plon = 0
    for lon, lat in pts:
        ilat = int(round(lat * 1e4)); ilon = int(round(lon * 1e4))
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63)); v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return ''.join(out)


# --- geometry helpers. Output plane: octi is octilinear in web mercator, but the client draws
# lon/lat on an equirectangular plane. So every schematic point is (lon, mercator y in
# degrees): 0/45/90 degrees stay exact on screen. The client projects the coastline the same way.
PL = lambda p: (p[0], math.degrees(math.log(math.tan(math.pi / 4 + math.radians(p[1]) / 2))))
PLi = lambda p: (p[0], math.degrees(2 * math.atan(math.exp(math.radians(p[1]))) - math.pi / 2))
key = lambda p: (round(p[0], 7), round(p[1], 7))
def gkm(a, b): return math.hypot((a[0] - b[0]) * 111.32 * math.cos(math.radians((a[1] + b[1]) / 2)), (a[1] - b[1]) * 110.57)
def glen(q): return sum(gkm(q[i], q[i + 1]) for i in range(len(q) - 1))
def plen(q): return sum(math.dist(q[i], q[i + 1]) for i in range(len(q) - 1))


def cumlen(q):
    c = [0.0]
    for i in range(len(q) - 1): c.append(c[-1] + math.dist(q[i], q[i + 1]))
    return c


def walk(q, cum, t):
    """the point at arc length t along q"""
    for i in range(len(q) - 1):
        if cum[i + 1] >= t - 1e-12:
            d = cum[i + 1] - cum[i]; r = 0 if d == 0 else (t - cum[i]) / d
            return (q[i][0] + (q[i + 1][0] - q[i][0]) * r, q[i][1] + (q[i + 1][1] - q[i][1]) * r)
    return q[-1]


def cut(q, cum, t0, t1):
    """q between arc lengths t0 <= t1, interior vertices included"""
    return [walk(q, cum, t0)] + [q[i] for i in range(len(q)) if t0 < cum[i] < t1] + [walk(q, cum, t1)]


def pseg(p, a, b):
    """distance from p to segment ab"""
    dx, dy = b[0] - a[0], b[1] - a[1]; l2 = dx * dx + dy * dy
    t = 0 if l2 == 0 else max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1])


def pdist(p, q): return min(pseg(p, q[i], q[i + 1]) for i in range(len(q) - 1))


def dpi(q, tol):
    """Douglas-Peucker: indices of the kept vertices"""
    if len(q) < 3: return list(range(len(q)))
    keep = [False] * len(q); keep[0] = keep[-1] = True; st = [(0, len(q) - 1)]
    while st:
        i, j = st.pop(); best, bd = -1, tol
        for k in range(i + 1, j):
            d = pseg(q[k], q[i], q[j])
            if d > bd: bd, best = d, k
        if best > 0: keep[best] = True; st += [(i, best), (best, j)]
    return [i for i, k in enumerate(keep) if k]


def dp(q, tol): return [q[i] for i in dpi(q, tol)]


def dedup(q):
    o = []
    for p in q:
        if not o or math.dist(o[-1], p) > 1e-9: o.append(p)
    return o


def octi2pl(a, b):
    """<=2-leg octilinear path a->b: the diagonal leg first"""
    dx, dy = b[0] - a[0], b[1] - a[1]; d = min(abs(dx), abs(dy))
    m = (a[0] + math.copysign(d, dx), a[1] + math.copysign(d, dy))
    return [a] + ([m] if 1e-9 < d and (abs(dx) - d > 1e-9 or abs(dy) - d > 1e-9) else []) + [b]


def octi3pl(a, b):
    """3-leg octilinear paths a->b on the lattice: the 2-leg path's first leg split around the second"""
    out = []
    for q in (octi2pl(a, b), octi2pl(b, a)[::-1]):
        if len(q) < 3: continue
        n_ = round(max(abs(q[1][0] - q[0][0]), abs(q[1][1] - q[0][1])) / STEP)
        if n_ < 2: continue
        h = (n_ // 2) / n_; m = (q[0][0] + (q[1][0] - q[0][0]) * h, q[0][1] + (q[1][1] - q[0][1]) * h)
        out.append([a, m, (m[0] + q[2][0] - q[1][0], m[1] + q[2][1] - q[1][1]), b])
    return out


def tidy(q, ring=False):
    """q without loops (it returns to a point it visited), reversals and straight-through
    vertices; the ends stay. A ring (q ends where it starts) keeps its one loop."""
    out = []
    for i, p in enumerate(q):
        for j in range(len(out)):
            if math.dist(out[j], p) < 1e-7 and not (ring and j == 0 and i == len(q) - 1): out = out[:j]; break
        out.append(p)
    changed = True
    while changed and len(out) > 2:
        changed = False
        for i in range(1, len(out) - 1):
            a, b, c = out[i - 1], out[i], out[i + 1]
            ab, bc = math.dist(a, b), math.dist(b, c)
            if ab < 1e-9 or bc < 1e-9 or abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) < 1e-6 * ab * bc:
                del out[i]; changed = True; break
    return out if len(out) >= 2 else [out[0], out[0]]


def lattice(p): return (round(p[0] / STEP) * STEP, round(p[1] / STEP) * STEP)


def carry(P, A, B):
    """P moved so that it starts at A and ends at B: every point shifts by the offset of the
    two ends, blended along P"""
    c = cumlen(P); L = c[-1] or 1.0
    dA = (A[0] - P[0][0], A[1] - P[0][1]); dB = (B[0] - P[-1][0], B[1] - P[-1][1])
    return [(p[0] + dA[0] + (dB[0] - dA[0]) * t / L, p[1] + dA[1] + (dB[1] - dA[1]) * t / L) for p, t in zip(P, c)]


def octi_along(P, tol):
    """octilinear polyline along P: P's Douglas-Peucker vertices, moved onto the lattice,
    joined by <=2-leg routes, each bent to the side P runs on; the ends are exact"""
    idx = dpi(P, tol); out = [P[0]]; V = [P[0]] + [lattice(P[i]) for i in idx[1:-1]] + [P[-1]]
    for (i, j), a, b in zip(zip(idx, idx[1:]), V, V[1:]):
        c1, c2 = octi2pl(a, b), octi2pl(b, a)[::-1]
        if len(c1) == 3 and max(pdist(p, c2) for p in P[i:j + 1]) < max(pdist(p, c1) for p in P[i:j + 1]): c1 = c2
        out += c1[1:]
    return tidy(out, ring=True)


def xkind(a, b, c, d):
    """segments ab and cd: 0 apart or touching, 1 proper crossing, 2 collinear overlap"""
    o = lambda p, q, r: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2, d3, d4 = o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d); e = 1e-12
    if abs(d1) < e and abs(d2) < e:
        ax = 0 if abs(b[0] - a[0]) >= abs(b[1] - a[1]) else 1
        lo, hi = sorted((a[ax], b[ax])); lo2, hi2 = sorted((c[ax], d[ax]))
        return 2 if min(hi, hi2) - max(lo, lo2) > 1e-7 else 0
    return 1 if ((d1 > e and d2 < -e) or (d1 < -e and d2 > e)) and ((d3 > e and d4 < -e) or (d3 < -e and d4 > e)) else 0


def meet(P, Q):
    """how polylines P and Q meet: (they cross, they overlap)"""
    x = o = False
    for i in range(len(P) - 1):
        for j in range(len(Q) - 1):
            k = xkind(P[i], P[i + 1], Q[j], Q[j + 1])
            if k == 1: x = True
            elif k == 2: o = True
    return x, o


GS = 0.25
def cells(P):
    out = set()
    for i in range(len(P) - 1):
        (x0, y0), (x1, y1) = P[i], P[i + 1]
        for cx in range(int(math.floor(min(x0, x1) / GS)), int(math.floor(max(x0, x1) / GS)) + 1):
            for cy in range(int(math.floor(min(y0, y1) / GS)), int(math.floor(max(y0, y1) / GS)) + 1): out.add((cx, cy))
    return out


pack = json.load(open(PACK)); nat = json.load(open(NAT))
feats = json.load(open(GRAPH))['features']; mp = json.load(open(MAP))
assert nat['n_sec'] == len(pack['sections']) and nat['n_thr'] == len(pack['throats']), 'national trains do not match the pack'

# --- octi edges and nodes (global indices from the mapping), on the plane
E = []
for fi, _ in mp['edges']:
    c = [PL(x) for x in feats[fi]['geometry']['coordinates']]; E.append((c, cumlen(c)))
N = [PL(feats[fi]['geometry']['coordinates']) for fi, _ in mp['nodes']]


def sub(k, u0, u1):
    """edge k from fraction u0 to u1 (either direction)"""
    c, cum = E[k]; a, b = sorted((u0, u1)); q = cut(c, cum, a * cum[-1], b * cum[-1])
    return q if u1 >= u0 else q[::-1]


# --- schematic polyline per pack section (plane); geo = the real track (lon/lat), geoP on the plane
nsec = len(pack['sections']); geo = [dec(s['g']) for s in pack['sections']]
geoP = [[PL(p) for p in g] for g in geo]
sch = [None] * nsec; stat = collections.Counter()
for s in range(nsec):
    r = mp['sections'].get(str(s))
    if r and r.get('p'):
        q = []
        for k, u0, u1, _ in r['p']: q += sub(k, u0, u1)
        q = dedup(q)
        if len(q) < 2: q = [q[0], q[0]]
        ends = (q[0], q[-1]); q = dp(q, SIMPLIFY_DEG); q[0], q[-1] = ends
        sch[s] = q; stat['line'] += 1
    elif r and 'n' in r:
        sch[s] = [N[r['n']], N[r['n']]]; stat['node'] += 1
    else:
        stat['unmapped'] += 1
# unmapped (degenerate, 0 km): at the schematic image of a touching section's end, else later by T
vimg = {}
for s in range(nsec):
    if sch[s] is None: continue
    for gp, sp in ((geo[s][0], sch[s][0]), (geo[s][-1], sch[s][-1])): vimg.setdefault(gp, sp)
for s in range(nsec):
    if sch[s] is None and geo[s][0] in vimg: sch[s] = [vimg[geo[s][0]], vimg[geo[s][0]]]; stat['unmapped->end'] += 1

# --- rule 1, stations. octi can leave the two sides of a station or junction on different
# nodes (ends snapped to neighbouring stations, collapsed throat pieces, tile seams), so a
# line jumps there. Section ends are grouped (union-find): ends at the same real point; ends
# that real track joins inside a station, i.e. a train path goes between them with only
# throats in between, or throats link them (real gap <= JOIN_KM); dangling ends that snap to
# the same station. A join never makes a group wider than JOIN_KM (no chaining across a
# city) or puts both ends of a section longer than LOOP_KM into one group (octi itself
# collapses chains under half a grid cell, 10.8 km). Each group gets one schematic point:
# where most of its ends already are (then an octi station node, then the smallest
# coordinates); the other ends move there with a short octilinear leg, after trimming any
# stub that points away from the target.
real = [len(set(g)) >= 2 and glen(g) > LOOP_KM for g in geo]
par = {}; gsec = {}; gbox = {}
def endpt(e): return geo[e[0]][-1 if e[1] else 0]
def find(x):
    if x not in par:
        par[x] = x; gsec[x] = {x[0]} if real[x[0]] else set(); p = endpt(x); gbox[x] = (p[0], p[1], p[0], p[1])
    while par[x] != x: par[x] = par[par[x]]; x = par[x]
    return x
def union(a, b, check=True):
    """merge unless it would loop a real section or make the group wider than JOIN_KM"""
    ra, rb = find(a), find(b)
    if ra == rb: return True
    A_, B_ = gbox[ra], gbox[rb]; bx = (min(A_[0], B_[0]), min(A_[1], B_[1]), max(A_[2], B_[2]), max(A_[3], B_[3]))
    if check and (gsec[ra] & gsec[rb] or gkm(bx[:2], bx[2:]) > JOIN_KM): return False
    if ra > rb: ra, rb = rb, ra
    par[rb] = ra; gsec[ra] |= gsec.pop(rb); gbox[ra] = bx; gbox.pop(rb); return True
ends_at = collections.defaultdict(list)            # real end point -> section ends
for s_ in range(nsec):
    if sch[s_] is None: continue
    ends_at[geo[s_][0]].append((s_, 0)); ends_at[geo[s_][-1]].append((s_, 1))
for pt, es in ends_at.items():
    for e in es[1:]: union(es[0], e, check=False)
cand = set()
def join(g_, ea, eb): cand.add((round(g_, 6), min(ea, eb), max(ea, eb)))
for path in nat['paths']:
    prev = None
    for x in path:
        if abs(x) >= nsec: continue
        if prev is not None and abs(prev) != abs(x) and sch[abs(prev)] is not None and sch[abs(x)] is not None:
            # the closest pair of ends (the path's signs do not reliably give the ends)
            g_, ea, eb = min((gkm(geo[abs(prev)][-1 if i else 0], geo[abs(x)][-1 if j else 0]), (abs(prev), i), (abs(x), j))
                             for i in (0, 1) for j in (0, 1))
            if g_ <= JOIN_KM: join(g_, ea, eb)
        prev = x
# ends linked by throats (through the station's own points, which are no section's end)
tadj = collections.defaultdict(list)
for g in pack['throats']:
    q = dec(g)
    if q[0] != q[-1]: l = glen(q); tadj[q[0]].append((q[-1], l)); tadj[q[-1]].append((q[0], l))
for pt in sorted(ends_at):
    seen_ = {pt}; todo = [(pt, 0.0)]
    while todo:
        x, d = todo.pop()
        for y, l in tadj.get(x, ()):
            if y in seen_ or d + l > JOIN_KM: continue
            seen_.add(y)
            if y not in ends_at: todo.append((y, d + l))
            elif pt < y and gkm(pt, y) <= JOIN_KM: join(gkm(pt, y), ends_at[pt][0], ends_at[y][0])
# dangling ends snapped to one station (same rule as convert2: degree 1, <= 0.03 deg)
gdeg = collections.Counter()
for g in geo:
    if len(set(g)) >= 2: gdeg[g[0]] += 1; gdeg[g[-1]] += 1
sgrid = collections.defaultdict(list)
for i, t in enumerate(pack['station_table']):
    if 'pt' in t: sgrid[(int(t['pt'][0] * 20), int(t['pt'][1] * 20))].append((i, t['pt']))
by_st = collections.defaultdict(list)
for pt, es in ends_at.items():
    if gdeg[pt] != 1: continue
    best = None
    for gx in (-1, 0, 1):
        for gy in (-1, 0, 1):
            for i, sp in sgrid.get((int(pt[0] * 20) + gx, int(pt[1] * 20) + gy), []):
                dd = math.hypot(sp[0] - pt[0], sp[1] - pt[1])
                if dd <= 0.03 and (best is None or dd < best[0]): best = (dd, i)
    if best: by_st[best[1]].append(es[0])
for i, es in by_st.items():
    for e in es[1:]: join(0.0, es[0], e)
cskip = 0
for _, a, b in sorted(cand):
    if not union(a, b): cskip += 1
groups = collections.defaultdict(list)
for s_ in range(nsec):
    if sch[s_] is None: continue
    for e in ((s_, 0), (s_, 1)): groups[find(e)].append(e)
stnode_pts = set()
for f in feats:
    if f['geometry']['type'] == 'Point' and f['properties'].get('station_id') and f['properties'].get('station_label') != 'cut':
        stnode_pts.add(key(PL(f['geometry']['coordinates'])))
at_count = collections.Counter()
for s_ in range(nsec):
    if sch[s_] is not None: at_count[key(sch[s_][0])] += 1; at_count[key(sch[s_][-1])] += 1
def extend(q, target):
    """q ends at q[-1]; drop trailing vertices that lead away from target (at most half the
    length), then add an octilinear leg to target"""
    L = plen(q); acc = 0; k = len(q) - 1
    while k > 0 and math.dist(q[k - 1], target) < math.dist(q[k], target) and acc + math.dist(q[k - 1], q[k]) <= L / 2:
        acc += math.dist(q[k - 1], q[k]); k -= 1
    return q[:k] + octi2pl(q[k], target)
moved = {}; moved_from = collections.Counter(); cstat = collections.Counter(); maxmove = []
for r_, es in groups.items():
    pos_ = collections.Counter(key(sch[s_][-1 if e else 0]) for s_, e in es)
    if len(pos_) < 2: continue
    tgt = min(pos_, key=lambda p: (-pos_[p], p not in stnode_pts, p))
    tp = next(sch[s_][-1 if e else 0] for s_, e in es if key(sch[s_][-1 if e else 0]) == tgt)
    cstat['groups_moved'] += 1
    for s_, e in sorted(es):
        q = sch[s_]; cur = q[-1 if e else 0]
        if key(cur) == tgt: continue
        maxmove.append(gkm(PLi(cur), PLi(tp))); moved_from[key(cur)] += 1
        if len(q) == 2 and key(q[0]) == key(q[1]) and all(find((s_, x)) == r_ for x in (0, 1)):
            sch[s_] = [tp, tp]; moved_from[key(cur)] += 1; cstat['node_moved'] += 1; continue
        sch[s_] = extend(q, tp) if e else extend(q[::-1], tp)[::-1]; cstat['ends_moved'] += 1
    for p in pos_:
        if p != tgt: moved[p] = tp
# station nodes whose every section end moved follow it
node_move = {p: t for p, t in moved.items() if moved_from[p] >= at_count[p]}
maxmove.sort()
cstat.update({'join_pairs': len(cand), 'joins_skipped': cskip, 'station_nodes_followed': len(node_move)})
if maxmove: cstat['move_km_p50_p90_max'] = [round(maxmove[len(maxmove) // 2], 1), round(maxmove[int(len(maxmove) * .9)], 1), round(maxmove[-1], 1)]
# moving an end can make a section double back over its own piece (an out-and-back spike, a loop)
for s_ in range(nsec):
    if sch[s_] is not None: sch[s_] = tidy(sch[s_])

# --- the skeleton: nodes (schematic points where sections end), bundles and runs.
# Sections between the same two nodes whose real tracks share a corridor (two lines sharing
# every station, a "ladder") form one bundle and are drawn as one line. A run is a chain of
# bundles through nodes where exactly two bundles meet (stations along a line); it ends at
# junctions and free ends. Node ids are the points octi (and rule 1) gave them; `pos` is
# where they are drawn.
drawn = [s_ for s_ in range(nsec) if sch[s_] is not None]
ends_k = {s_: (key(sch[s_][0]), key(sch[s_][-1])) for s_ in drawn}
nonzero = [s_ for s_ in drawn if ends_k[s_][0] != ends_k[s_][1]]
realS = {s_: dp(geoP[s_], 0.003) for s_ in nonzero}   # real track, simplified (~0.3 km)
bbox = {s_: (min(p[0] for p in q), min(p[1] for p in q), max(p[0] for p in q), max(p[1] for p in q)) for s_, q in realS.items()}
def lazy(f):
    memo = {}
    def g(a, b):
        k = (a, b) if a <= b else (b, a)
        if k not in memo: memo[k] = f(*k)
        return memo[k]
    return g
def apart(a, b, pad):
    A_, B_ = bbox[a], bbox[b]
    return A_[0] > B_[2] + pad or B_[0] > A_[2] + pad or A_[1] > B_[3] + pad or B_[1] > A_[3] + pad
@lazy
def really_cross(a, b):
    """the real tracks of sections a and b cross"""
    return not apart(a, b, 0) and meet(realS[a], realS[b])[0]
@lazy
def corridor(a, b):
    """the real tracks of sections a and b run within CORRIDOR of each other for half of the shorter one"""
    if apart(a, b, CORRIDOR): return False
    def near(P, Q):
        c = cumlen(P); n_ = max(2, int(c[-1] / (CORRIDOR / 2)) + 1)
        return sum(pdist(walk(P, c, c[-1] * i / n_), Q) <= CORRIDOR for i in range(n_ + 1)) / (n_ + 1)
    P, Q = (realS[a], realS[b]) if plen(realS[a]) <= plen(realS[b]) else (realS[b], realS[a])
    return near(P, Q) >= 0.5
bund = {}
by_pair = collections.defaultdict(list)
for s_ in nonzero: by_pair[tuple(sorted(ends_k[s_]))].append(s_)
for pr in sorted(by_pair):
    subs = []
    for s_ in by_pair[pr]:
        for sb in subs:
            if corridor(sb[0], s_): sb.append(s_); break
        else: subs.append([s_])
    for i, sb in enumerate(subs): bund[pr + (i,)] = sb
bkeys = sorted(bund)
binc = collections.defaultdict(list)
for bk in bkeys: binc[bk[0]].append(bk); binc[bk[1]].append(bk)
deg2 = {k for k, L in binc.items() if len(L) == 2}
other = lambda bk, k: bk[1] if k == bk[0] else bk[0]
pos = {}
for s_ in nonzero:
    pos.setdefault(ends_k[s_][0], sch[s_][0]); pos.setdefault(ends_k[s_][1], sch[s_][-1])


def chase(bk0, at):
    """the bundles after bk0 beyond node `at`, through degree-2 nodes:
    ([bundles], [nodes reached], it came back to bk0: a ring without a junction)"""
    bs = []; ns = []; bk = bk0
    while at in deg2:
        bk = [x for x in binc[at] if x != bk][0]
        if bk == bk0: return bs, ns, True
        at = other(bk, at); bs.append(bk); ns.append(at)
    return bs, ns, False


class Run:
    """bundles b[i] between nodes n[i] and n[i+1]; `real` is its real track on the plane and
    frac[i] the fraction of the real length at node n[i]"""
    def __init__(self, b, n):
        self.b = b; self.n = n; self.secs = [s_ for bk in b for s_ in bund[bk]]; self.skip = set(self.secs)
        real_ = []; km = []
        for bk, frm in zip(b, n):
            s_ = bund[bk][0]; real_ += geoP[s_] if ends_k[s_][0] == frm else geoP[s_][::-1]
            km.append(max(sum(plen(geoP[t]) for t in bund[bk]) / len(bund[bk]), 1e-9))
        self.real = dedup(real_); self.frac = [0.0]
        for k_ in km: self.frac.append(self.frac[-1] + k_ / sum(km))
        self.frac[-1] = 1.0
        self.cand = None; self.route = None; self.octi = self.drawing()

    def flipped(self):
        r = Run(self.b[::-1], self.n[::-1]); r.octi = self.octi[::-1]; return r

    def drawing(self):
        """the run as its sections are drawn now"""
        q = []
        for bk, frm in zip(self.b, self.n):
            s_ = bund[bk][0]; q += sch[s_] if ends_k[s_][0] == frm else sch[s_][::-1]
        return dedup(q)

    def pieces(self, R):
        """route R cut at the run's nodes, by real distance: one piece per bundle"""
        c = cumlen(R)
        return [cut(R, c, u0 * c[-1], u1 * c[-1]) for u0, u1 in zip(self.frac, self.frac[1:])]


runs = []; seen = set()
for bk0 in bkeys:
    if bk0 in seen: continue
    bb, nb, ring = chase(bk0, bk0[0])
    if ring: b_ = bb + [bk0]; n_ = [bk0[0]] + nb + [bk0[0]]
    else:
        bf, nf, _ = chase(bk0, bk0[1]); b_ = bb[::-1] + [bk0] + bf; n_ = nb[::-1] + [bk0[0], bk0[1]] + nf
    seen.update(b_); runs.append(Run(b_, n_))
run_of = {s_: i for i, r in enumerate(runs) for s_ in r.secs}
sgrid2 = collections.defaultdict(set)
for s_ in nonzero:
    for c in cells(sch[s_]): sgrid2[c].add(s_)
@lazy
def runs_cross(i, j):
    """some real track of run i crosses some real track of run j"""
    return any(really_cross(a, b) for a in runs[i].secs for b in runs[j].secs)


def false_meets(run, R):
    """what route R would wrongly meet: (lines crossed that the run never crosses, crossings
    drawn on another section of a line it does cross, lines overlapped outside a shared corridor)"""
    wrong = moved_x = lap = 0; me = run_of[run.secs[0]]
    for bk, piece in zip(run.b, run.pieces(R)):
        mem = bund[bk]; seen_ = set()
        for c in sorted(cells(piece)):
            for t in sorted(sgrid2.get(c, ())):
                if t in run.skip or t in seen_: continue
                seen_.add(t); x, o = meet(piece, sch[t])
                if x and not any(really_cross(s_, t) for s_ in mem):
                    if runs_cross(me, run_of[t]): moved_x += 1
                    else: wrong += 1
                if o and not any(corridor(s_, t) for s_ in mem): lap += 1
    return wrong, moved_x, lap


def deviation(R, I):
    """how far route R and the real-shape image I are apart (both ways)"""
    c = cumlen(R); n_ = max(2, int(c[-1] / (CELL / 2)) + 1)
    return max(max(pdist(p, R) for p in I), max(pdist(walk(R, c, c[-1] * i / n_), I) for i in range(n_ + 1)))


def candidates(run, A, B):
    """routes for the run from A to B, simplest first, each with its distance from the real
    shape: one to three legs, octilinear routes along the real shape (coarse to fine), and
    the route octi gave it (carried along if its ends moved). A run too short for the
    lattice is a point."""
    I = carry(run.real, A, B); Is = dp(I, CELL / 8); out = []; have = set()
    def add(R, kind):
        k = tuple(key(p) for p in R)
        if k not in have and plen(R) > 1e-9: have.add(k); out.append((R, deviation(R, Is), kind))
    if math.dist(A, B) > 1e-9:
        add(octi2pl(A, B), 'legs'); add(octi2pl(B, A)[::-1], 'legs')
        for R in octi3pl(A, B): add(R, 'legs')
    for tol in SHAPES: add(octi_along(I, tol), 'shape')
    O = run.octi
    add(O if key(O[0]) == key(A) and key(O[-1]) == key(B) else octi_along(carry(O, A, B), CELL / 4), 'octi')
    return out or [([A, B], 0.0, 'point')]


def best_route(run, cand):
    """the route to draw: never one far off the real shape (2 x FIT) when a nearer one exists;
    then the fewest wrong meetings; then the simplest that fits (FIT), else the nearest"""
    def cost(i):
        R, dev, _ = cand[i]; w = false_meets(run, R)
        return (dev > 2 * FIT, w, dev > FIT, i if dev <= FIT else dev, i)
    c, i = min((cost(i), i) for i in range(len(cand)))
    return c, cand[i]


def draw(run, choice):
    """give every section of the run its piece of the chosen route; nodes along the run follow"""
    R, run.dev, run.kind = choice; run.route = R
    for bk, frm, q in zip(run.b, run.n, run.pieces(R)):
        pos[frm] = q[0]
        for s_ in bund[bk]:
            sch[s_] = q if ends_k[s_][0] == frm else q[::-1]
            for c in cells(q): sgrid2[c].add(s_)
    pos[run.n[-1]] = R[-1]


# --- rule 2, junctions. octi places junctions on its grid one by one, so neighbours can end
# up on the wrong side of each other (a branch joining a line far from where it does, a ring
# folded flat). The schematic should be a smooth deformation of the real map: the offset
# between two junctions should be the real one, the more so the shorter the run between them.
# Junction positions X minimise  sum over runs |X_j - X_i - real offset|^2 / run length
# + SMOOTH * sum over junctions |X_i - octi's point|^2  (Gauss-Seidel; short runs are stiff,
# long runs give, and every junction stays near where octi put it).
jn = sorted({k for r in runs for k in (r.n[0], r.n[-1])})
link = {}                                       # junction pair -> (real offset a->b, real length) of the run between them
for r in runs:
    a, b = r.n[0], r.n[-1]; v = (r.real[-1][0] - r.real[0][0], r.real[-1][1] - r.real[0][1])
    if a > b: a, b, v = b, a, (-v[0], -v[1])
    # of several runs between two junctions (their ends lie apart inside a station complex), the widest counts
    if a != b and ((a, b) not in link or math.hypot(*v) > math.hypot(*link[(a, b)][0])): link[(a, b)] = (v, plen(r.real))
pull = collections.defaultdict(list)            # junction -> (other junction, weight, real offset to here)
for (a, b), (v, l) in sorted(link.items()):
    w = 1 / max(l, STIFF); pull[b].append((a, w, v)); pull[a].append((b, w, (-v[0], -v[1])))
X0 = {k: pos[k] for k in jn}; X = dict(X0)
for it in range(RELAX_ITERS):
    for k in jn:
        sw = SMOOTH; sx = SMOOTH * X0[k][0]; sy = SMOOTH * X0[k][1]
        for j, w, v in pull[k]: sw += w; sx += w * (X[j][0] + v[0]); sy += w * (X[j][1] + v[1])
        X[k] = (sx / sw, sy / sw)
# every junction then takes the nearest free point of the lattice (STEP): routes between
# lattice points bend on lattice points, so lines coincide, touch or cross cleanly
taken = set()
for k in sorted(jn, key=lambda k: (-len(pull[k]), k)):
    c = lattice(X[k])
    spots = sorted((math.dist(X[k], q), q) for q in ((c[0] + i * STEP, c[1] + j * STEP) for i in range(-2, 3) for j in range(-2, 3)))
    X[k] = next(q for _, q in spots if key(q) not in taken); taken.add(key(X[k]))
jmove = sorted(math.dist(X[k], X0[k]) * 111 for k in jn)
for k in jn: pos[k] = X[k]
for run in runs:                                # a first drawing at the new positions: octi's routes
    draw(run, candidates(run, pos[run.n[0]], pos[run.n[-1]])[-1])

# --- rule 3, free ends. octi gives every station a grid cell, which stretches branches
# (Zhuhai's line ran ~110 km too far south). A dead-end run hangs on one junction, so its
# free end is free to be right: it takes the real offset from that junction (on the
# lattice). Branches of branches follow from the trunk outwards. A move that would add
# wrong meetings is not made.
rstat = collections.Counter()
rdeg = collections.Counter(); rinc = collections.defaultdict(list)
for i, r in enumerate(runs):
    rdeg[r.n[0]] += 1; rdeg[r.n[-1]] += 1
    if r.n[0] != r.n[-1]: rinc[r.n[0]].append(i); rinc[r.n[-1]].append(i)
hang = []; gone = set(); leaves = sorted(k for k in rinc if rdeg[k] == 1)
while leaves:
    nxt = []
    for k in leaves:
        left = [i for i in rinc[k] if i not in gone]
        if rdeg[k] != 1 or len(left) != 1: continue
        i = left[0]; gone.add(i); up = runs[i].n[0] if runs[i].n[-1] == k else runs[i].n[-1]
        hang.append((i, up, k)); rdeg[up] -= 1; rdeg[k] -= 1
        if rdeg[up] == 1: nxt.append(up)
    leaves = sorted(set(nxt))
for i, up, k in reversed(hang):
    if runs[i].n[0] != up: runs[i] = runs[i].flipped()
    run = runs[i]; A = pos[up]; B0 = pos[k]
    B1 = lattice((A[0] + run.real[-1][0] - run.real[0][0], A[1] + run.real[-1][1] - run.real[0][1]))
    c0, R0 = best_route(run, candidates(run, A, B0)); c1, R1 = best_route(run, candidates(run, A, B1))
    if c1[1] <= c0[1]: draw(run, R1); rstat['free_ends_to_real'] += 1
    else: draw(run, R0); rstat['free_ends_kept'] += 1

# --- rule 4, runs. Every run is drawn as the simplest octilinear route between its two
# nodes that stays within FIT of its real shape and meets only the lines it really meets:
# up to three legs when the real track is that straight, else a route along the real shape,
# as coarse as fits (so a line far from its real corridor, or a ring folded flat, is
# redrawn from the real track). Parallel sections (a bundle) share the route; stations
# along it are spaced by real distance. Runs are routed against each other's current
# routes, in a few sweeps.
for sweep in range(SWEEPS):
    changed = 0
    for run in runs:
        A, B = pos[run.n[0]], pos[run.n[-1]]
        if run.cand is None: run.cand = candidates(run, A, B)
        c, ch = best_route(run, run.cand)
        if run.route is None or [key(p) for p in ch[0]] != [key(p) for p in run.route]: draw(run, ch); changed += 1
    rstat['sweep%d_changed' % (sweep + 1)] = changed
    if not changed: break
for s_ in drawn:                               # collapsed sections ride with their node
    k = ends_k[s_][0]
    if k == ends_k[s_][1] and k in pos:
        d = (pos[k][0] - sch[s_][0][0], pos[k][1] - sch[s_][0][1]); sch[s_] = [(p[0] + d[0], p[1] + d[1]) for p in sch[s_]]
rstat = dict(rstat); rstat.update({'junction_move_km_p50_p90_max': [round(jmove[len(jmove) // 2], 1), round(jmove[int(len(jmove) * .9)], 1), round(jmove[-1], 1)], 'runs': len(runs), 'bundles': len(bund), 'bundled_sections': sum(len(v) for v in bund.values() if len(v) > 1),
              'drawn_as': dict(sorted(collections.Counter(r.kind for r in runs).items())), 'off_real_shape': sum(r.dev > FIT for r in runs)})
fm = [false_meets(r, r.route) for r in runs]
rstat.update({'wrong_crossings': sum(f[0] for f in fm) // 2, 'moved_crossings': sum(f[1] for f in fm) // 2, 'overlaps': sum(f[2] for f in fm) // 2})
cstat = dict(cstat); cstat.update(rstat)

vimg = {}
for s_ in range(nsec):
    if sch[s_] is None: continue
    for gp, sp in ((geo[s_][0], sch[s_][0]), (geo[s_][-1], sch[s_][-1])): vimg.setdefault(gp, sp)

# --- transform T for off-mapping points (real lon/lat -> plane)
G = 0.1
grid = collections.defaultdict(list)          # cell -> (s, i) segments of mapped sections
cumg = [None] * nsec; cums = [None] * nsec
for s in range(nsec):
    if sch[s] is None: continue
    g = geo[s]; cumg[s], cums[s] = cumlen(g), cumlen(sch[s])
    for i in range(len(g) - 1):
        x0, x1 = sorted((g[i][0], g[i + 1][0])); y0, y1 = sorted((g[i][1], g[i + 1][1]))
        for cx in range(int(math.floor(x0 / G)), int(math.floor(x1 / G)) + 1):
            for cy in range(int(math.floor(y0 / G)), int(math.floor(y1 / G)) + 1):
                grid[(cx, cy)].append((s, i))


tstat = collections.Counter()
def T(p):
    p = tuple(p)
    if p in vimg: tstat['vertex'] += 1; return vimg[p]
    cx, cy = int(math.floor(p[0] / G)), int(math.floor(p[1] / G)); best = None
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for s, i in grid.get((cx + dx, cy + dy), ()):
                a, b = geo[s][i], geo[s][i + 1]; vx, vy = b[0] - a[0], b[1] - a[1]; l2 = vx * vx + vy * vy
                t = 0 if l2 == 0 else max(0, min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2))
                d = math.hypot(a[0] + t * vx - p[0], a[1] + t * vy - p[1])
                if best is None or d < best[0]: best = (d, s, i, t)
    if best and best[0] <= SNAP_DEG:
        d, s, i, t = best; L = cumg[s][-1]
        f = 0 if L == 0 else (cumg[s][i] + t * (cumg[s][i + 1] - cumg[s][i])) / L
        tstat['project'] += 1; return walk(sch[s], cums[s], f * cums[s][-1])
    # far from every section: shift by the nearest mapped vertex's offset
    gp = min(vimg, key=lambda v: (v[0] - p[0]) ** 2 + (v[1] - p[1]) ** 2); sp = vimg[gp]; q = PL(p); gq = PL(gp)
    tstat['offset'] += 1; return (q[0] + sp[0] - gq[0], q[1] + sp[1] - gq[1])


for s in range(nsec):
    if sch[s] is None:
        q = [T(geo[s][0])]; sch[s] = [q[0], q[0]]; stat['unmapped->T'] += 1

# --- stations: an octi station node that is a node of the skeleton is drawn where that node
# is; every other station goes through T (onto the drawn line)
stn = {}
sides = {}
for p in SIDES:
    sd = json.load(open(p)); sides[sd['tile']] = sd['nodes']
for f in feats:
    pr = f['properties']
    if f['geometry']['type'] != 'Point' or 'station_id' not in pr: continue
    tile, nid = pr['tile'], pr['station_id'][3:]
    st = sides.get(tile, {}).get(nid, {}).get('st')
    if st is not None:
        c = PL(f['geometry']['coordinates']); k = key(node_move.get(key(c), c))
        if k in pos: stn.setdefault(int(st), pos[k])
station_pt = []
for i, t in enumerate(pack['station_table']):
    if i in stn: station_pt.append(stn[i])
    elif 'pt' in t: station_pt.append(T(t['pt']))
    else: station_pt.append(None)
# cities sit on one of their stations: the station at the city's own point (the pack puts a
# city where its main station is), else the most central of its placed stations (medoid).
# A mean offset could land between lines when octi spreads a city's stations apart.
by_city = collections.defaultdict(list)
for i, t in enumerate(pack['station_table']):
    if 'pt' in t and station_pt[i] is not None and t.get('city') is not None:
        by_city[t['city']].append((i, t['pt'], station_pt[i]))
city_pt = []; cpstat = collections.Counter()
for i, c in enumerate(pack['city_table']):
    sts_ = by_city.get(i)
    if not sts_: city_pt.append(T(c['pt'])); cpstat['transform'] += 1; continue
    main = [sp for _, rp, sp in sts_ if abs(rp[0] - c['pt'][0]) < 1e-6 and abs(rp[1] - c['pt'][1]) < 1e-6]
    if main: city_pt.append(main[0]); cpstat['main_station'] += 1; continue
    city_pt.append(min((sp for _, _, sp in sts_), key=lambda a: (sum(math.dist(a, b) for _, _, b in sts_), a)))
    cpstat['medoid'] += 1

# --- in_sections: same geometry as a section -> its schematic; else T per vertex
by_g = {}
for s, x in enumerate(pack['sections']): by_g.setdefault(x['g'], s)
in_sch = []; istat = collections.Counter()
for x in pack['in_sections']:
    s = by_g.get(x['g'])
    if s is not None: in_sch.append(sch[s]); istat['same'] += 1
    else:
        q = dedup([T(p) for p in dec(x['g'])]) or [T(dec(x['g'])[0])]
        if len(q) < 2: q = [q[0], q[0]]
        in_sch.append(dp(q, SIMPLIFY_DEG)); istat['T'] += 1

# --- throats: from the image of one end to the other, octilinear
def throat(g):
    q = dec(g); return octi2pl(T(q[0]), T(q[-1]))
thr = [throat(g) for g in pack['throats']]
extra = [throat(g) for g in nat['extra']]
# the backdrop is the drawn sections themselves, so it never shows a line that trains are
# not drawn on
network = [dedup(sch[s_]) for s_ in range(nsec) if len(dedup(sch[s_])) >= 2]

r5 = lambda p: [round(p[0], 6), round(p[1], 6)]
out = {
    'fmt': pack['fmt'], 'build': pack['build'], 'layout': 'octi-stitched', 'plane': 'lon-mercdeg',
    'n_sec': nsec, 'n_in': len(pack['in_sections']), 'n_thr': len(pack['throats']), 'n_extra': len(nat['extra']),
    'n_station': len(pack['station_table']), 'n_city': len(pack['city_table']),
    'sections': [enc(q) for q in sch], 'in_sections': [enc(q) for q in in_sch],
    'network': [enc(q) for q in network], 'throats': [enc(q) for q in thr], 'extra': [enc(q) for q in extra],
    'station_pt': [r5(p) if p else None for p in station_pt], 'city_pt': [r5(p) for p in city_pt],
}
json.dump(out, open(OUT, 'w'), separators=(',', ':'))
print(json.dumps({'cities_on': cpstat, 'layout': cstat, 'sections': stat, 'in_sections': istat, 'T': tstat, 'stations_octi': len(stn),
                  'stations': len(station_pt), 'cities': len(city_pt), 'network': len(network)}), file=sys.stderr)
