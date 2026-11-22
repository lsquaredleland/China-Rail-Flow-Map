# usage: python3 -I export_layout.py shared.json national-trains.json graph.json map.json out.json side.json...
# Turns a stitched octi layout (stitch.py: graph + per-section mapping) into the client's
# schematic geometry asset (atlas-v2-octi.json; docs/OCTI.md). Every geometry field the client
# draws gets a schematic twin with the SAME ids and lengths, so flows, paths, trains and
# tables are untouched; the client swaps the arrays before decoding (dumb client):
#   sections[s], in_sections[s]  encoded polylines (precision 1e4, lat/lon, like `g`)
#   network                      the octi edges (backdrop only, own count)
#   throats[t], extra[t]         station throats (shared pack, national trains `extra`)
#   station_pt[i], city_pt[i]    [lon, y]
# All points are on the plane (lon, mercator y in degrees); see PL below.
# Before anything else is derived, a continuity pass makes section ends that trains run
# between meet at one schematic point (short octilinear legs; the legs are appended to
# `network`). Points that are not on the mapping (throat ends, stations, in_sections that
# differ from sections) then go through one transform T: nearest section segment within SNAP_DEG, by fraction
# along that section's schematic polyline; else the offset of the nearest mapped vertex.
import json, sys, math, collections

PACK, NAT, GRAPH, MAP, OUT = sys.argv[1:6]
SIDES = sys.argv[6:]
SNAP_DEG = 0.05      # max distance from a section for the projection transform
SIMPLIFY_DEG = 0.004  # Douglas-Peucker tolerance for octi's rendered corner points (~0.4 km)


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


M = lambda p: (p[0], math.degrees(math.log(math.tan(math.pi / 4 + math.radians(p[1]) / 2))))  # mercator, deg units
def plen(q, f=lambda p: p):
    return sum(math.dist(f(q[i]), f(q[i + 1])) for i in range(len(q) - 1))


def dp(q, tol):
    if len(q) < 3: return list(q)
    keep = [False] * len(q); keep[0] = keep[-1] = True; st = [(0, len(q) - 1)]
    while st:
        i, j = st.pop(); best, bd = -1, tol
        ax, ay = q[i]; bx, by = q[j]; dx, dy = bx - ax, by - ay; l2 = dx * dx + dy * dy
        for k in range(i + 1, j):
            px, py = q[k]
            t = 0 if l2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
            d = math.hypot(ax + t * dx - px, ay + t * dy - py)
            if d > bd: bd, best = d, k
        if best > 0: keep[best] = True; st += [(i, best), (best, j)]
    return [p for p, k in zip(q, keep) if k]


def dedup(q):
    o = []
    for p in q:
        if not o or math.dist(o[-1], p) > 1e-9: o.append(p)
    return o


pack = json.load(open(PACK)); nat = json.load(open(NAT))
feats = json.load(open(GRAPH))['features']; mp = json.load(open(MAP))
assert nat['n_sec'] == len(pack['sections']) and nat['n_thr'] == len(pack['throats']), 'national trains do not match the pack'

# --- octi edges and nodes (global indices from the mapping)
E = []
for fi, _ in mp['edges']:
    c = [tuple(x) for x in feats[fi]['geometry']['coordinates']]
    cum = [0.0]
    for i in range(len(c) - 1): cum.append(cum[-1] + math.dist(M(c[i]), M(c[i + 1])))
    E.append((c, cum))
N = [tuple(feats[fi]['geometry']['coordinates']) for fi, _ in mp['nodes']]


def ptat(k, u):
    c, cum = E[k]; t = u * cum[-1]
    for i in range(len(c) - 1):
        if cum[i + 1] >= t - 1e-12:
            s = cum[i + 1] - cum[i]; r = 0 if s == 0 else (t - cum[i]) / s
            return (c[i][0] + (c[i + 1][0] - c[i][0]) * r, c[i][1] + (c[i + 1][1] - c[i][1]) * r)
    return c[-1]


def sub(k, u0, u1):
    """Edge k from fraction u0 to u1 (either direction), interior vertices included."""
    c, cum = E[k]; L = cum[-1]; a, b = sorted((u0, u1))
    q = [ptat(k, a)] + [c[i] for i in range(len(c)) if a * L < cum[i] < b * L] + [ptat(k, b)]
    return q if u1 >= u0 else q[::-1]


# --- schematic polyline per pack section
nsec = len(pack['sections']); geo = [dec(s['g']) for s in pack['sections']]
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

# --- continuity along train paths. octi can leave the two sides of a station or junction on
# different nodes (ends snapped to neighbouring stations, collapsed throat pieces, tile seams),
# so a train's line jumps there. Section ends are grouped (union-find): ends at the same real
# point; ends a train path goes between with only throats in between (real gap <= JOIN_KM);
# dangling ends that snap to the same station. A join never makes a group wider than
# JOIN_KM (no chaining across a city) or puts both ends of a section longer than LOOP_KM into one group (octi itself collapses chains under half a grid cell,
# 10.8 km). Each group gets one schematic point: where most of its ends already
# are (then an octi station node, then the smallest coordinates); the other ends move there
# with a short octilinear leg, after trimming any stub that points away from the target.
JOIN_KM = 12.0   # >= the longest throat (11.7 km)
LOOP_KM = 5.0
def gkm(a, b): return math.hypot((a[0] - b[0]) * 111.32 * math.cos(math.radians((a[1] + b[1]) / 2)), (a[1] - b[1]) * 110.57)
def glen(q): return sum(gkm(q[i], q[i + 1]) for i in range(len(q) - 1))
PLf = lambda p: (p[0], M(p)[1])
PLi = lambda p: (p[0], math.degrees(2 * math.atan(math.exp(math.radians(p[1]))) - math.pi / 2))
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
for path in nat['paths']:
    prev = None
    for x in path:
        if abs(x) >= nsec: continue
        if prev is not None and abs(prev) != abs(x) and sch[abs(prev)] is not None and sch[abs(x)] is not None:
            # the closest pair of ends (the path's signs do not reliably give the ends)
            g_, ea, eb = min((gkm(geo[abs(prev)][-1 if i else 0], geo[abs(x)][-1 if j else 0]), (abs(prev), i), (abs(x), j))
                             for i in (0, 1) for j in (0, 1))
            if g_ <= JOIN_KM: cand.add((round(g_, 6), min(ea, eb), max(ea, eb)))
        prev = x
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
    for e in es[1:]: cand.add((0.0, min(es[0], e), max(es[0], e)))
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
        stnode_pts.add(tuple(round(c, 7) for c in f['geometry']['coordinates']))
key = lambda p: (round(p[0], 7), round(p[1], 7))
at_count = collections.Counter()
for s_ in range(nsec):
    if sch[s_] is not None: at_count[key(sch[s_][0])] += 1; at_count[key(sch[s_][-1])] += 1
def octi2pl(a, b):
    """<=2-leg octilinear path a->b in the output plane (lon, mercator-y degrees)"""
    dx, dy = b[0] - a[0], b[1] - a[1]; d = min(abs(dx), abs(dy))
    m = (a[0] + math.copysign(d, dx), a[1] + math.copysign(d, dy))
    return [a] + ([m] if 1e-9 < d and (abs(dx) - d > 1e-9 or abs(dy) - d > 1e-9) else []) + [b]
def extend(q, target):
    """q (lon/lat) ends at q[-1]; drop trailing vertices that lead away from target (at most
    half the length), then add an octilinear leg to target."""
    P = [PLf(p) for p in q]; T_ = PLf(target); L = plen(P); acc = 0; k = len(P) - 1
    while k > 0 and math.dist(P[k - 1], T_) < math.dist(P[k], T_) and acc + math.dist(P[k - 1], P[k]) <= L / 2:
        acc += math.dist(P[k - 1], P[k]); k -= 1
    P = P[:k + 1]; leg = octi2pl(P[-1], T_)
    trims.append(acc); legs.append([PLi(p) for p in leg])
    return [PLi(p) for p in P[:-1] + leg]
trims = []; legs = []; touched = set()
moved = collections.Counter(); moved_from = collections.Counter(); cstat = collections.Counter(); maxmove = []
for r_, es in groups.items():
    pos = collections.Counter(key(sch[s_][-1 if e else 0]) for s_, e in es)
    if len(pos) < 2: continue
    tgt = min(pos, key=lambda p: (-pos[p], p not in stnode_pts, p))
    tp = next(sch[s_][-1 if e else 0] for s_, e in es if key(sch[s_][-1 if e else 0]) == tgt)
    cstat['groups_moved'] += 1
    for s_, e in sorted(es):
        q = sch[s_]; cur = q[-1 if e else 0]
        if key(cur) == tgt: continue
        maxmove.append(gkm(cur, tp)); moved_from[key(cur)] += 1
        if len(q) == 2 and key(q[0]) == key(q[1]) and all(find((s_, x)) == r_ for x in (0, 1)):
            sch[s_] = [tp, tp]; moved_from[key(cur)] += 1; cstat['node_moved'] += 1; continue
        sch[s_] = extend(q, tp) if e else extend(q[::-1], tp)[::-1]; cstat['ends_moved'] += 1; touched.add(s_)
    for p in pos:
        if p != tgt: moved[p] = tp
# station nodes whose every section end moved follow it
node_move = {p: t for p, t in moved.items() if moved_from[p] >= at_count[p]}
maxmove.sort()
cstat = dict(cstat); cstat.update({'join_pairs': len(cand), 'joins_skipped': cskip,
              'move_km_p50_p90_max': [round(maxmove[len(maxmove) // 2], 1), round(maxmove[int(len(maxmove) * .9)], 1), round(maxmove[-1], 1)] if maxmove else None,
              'station_nodes_followed': len(node_move), 'legs': len(legs),
              'trimmed_ends': sum(1 for t in trims if t > 0), 'trimmed_plane_deg': round(sum(trims), 2)})

# --- cleanup (plane coordinates; ends never move). Moving an end can make a section double
# back over its own piece: a short section drawn as an out-and-back spike, or a loop.
# 1. loop erasure: a polyline that returns to a point it visited drops the loop;
# 2. a vertex where the line reverses or runs straight on (collinear) is dropped;
# 3. a section still drawn longer than DETOUR x its octilinear end-to-end distance + DETOUR_DEG
#    is redrawn as the <=2-leg octilinear route between its ends.
DETOUR, DETOUR_DEG = 1.6, 0.05
def octd(a, b):
    dx, dy = abs(b[0] - a[0]), abs(b[1] - a[1]); return min(dx, dy) * math.sqrt(2) + abs(dx - dy)
def clean(q, real_pl=0.0):
    """real_pl: the section's real length in plane units (a detour is drawn much longer than
    both its octilinear end-to-end distance and its real track)"""
    P = [PLf(p) for p in q]
    out = []
    for p in P:                                   # 1. loop erasure
        for j in range(len(out)):
            if math.dist(out[j], p) < 1e-7: out = out[:j]; break
        out.append(p)
    changed = True
    while changed and len(out) > 2:               # 2. reversals and straight-through vertices
        changed = False
        for i in range(1, len(out) - 1):
            a, b, c = out[i - 1], out[i], out[i + 1]
            ab, bc = math.dist(a, b), math.dist(b, c)
            if ab < 1e-9 or bc < 1e-9 or abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) < 1e-6 * ab * bc:
                del out[i]; changed = True; break
    if len(out) >= 2 and plen(out) > DETOUR * max(octd(out[0], out[-1]), real_pl) + DETOUR_DEG:
        out = octi2pl(out[0], out[-1]); cstat['detours_redrawn'] += 1
    if len(out) < 2: out = [out[0], out[0]]
    return [PLi(p) for p in out]
cstat = collections.Counter(cstat)
for s_ in range(nsec):
    if sch[s_] is None: continue
    a, b = sch[s_][0], sch[s_][-1]
    c = clean(sch[s_], plen([PLf(p) for p in geo[s_]])); c[0], c[-1] = a, b
    if len(c) != len(sch[s_]): cstat['cleaned'] += 1; touched.add(s_)
    sch[s_] = c

# --- straighten runs between junctions. octi trades straightness against everything around
# it and the continuity legs add jogs, so a line with no branch between two junctions can
# still zigzag. Each such run (sections chained through nodes where exactly two sections
# meet) is redrawn as the simplest octilinear route between its two junction nodes (one
# leg, or two: diagonal first or axis first), keeping the variant that crosses no more
# other lines than the current drawing (fewest crossings, then closest to it). Interior
# nodes (stations) are spaced along the new route by real distance; junctions never move.
def segx(a, b, c, d):
    """proper crossing or collinear overlap of segments ab and cd (shared ends excluded)"""
    if min(math.dist(a, c), math.dist(a, d), math.dist(b, c), math.dist(b, d)) < 1e-9: return False
    o = lambda p, q, r: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2, d3, d4 = o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d)
    eps = 1e-12
    if abs(d1) < eps and abs(d2) < eps:     # collinear: overlap of positive length
        ax = 0 if abs(b[0] - a[0]) >= abs(b[1] - a[1]) else 1
        lo, hi = sorted((a[ax], b[ax])); lo2, hi2 = sorted((c[ax], d[ax]))
        return min(hi, hi2) - max(lo, lo2) > 1e-7
    return (d1 > eps) != (d2 > eps) and (d3 > eps) != (d4 > eps) and abs(d1) > eps and abs(d2) > eps and abs(d3) > eps and abs(d4) > eps
GS = 0.25
def cells(P):
    out = set()
    for i in range(len(P) - 1):
        (x0, y0), (x1, y1) = P[i], P[i + 1]
        for cx in range(int(math.floor(min(x0, x1) / GS)), int(math.floor(max(x0, x1) / GS)) + 1):
            for cy in range(int(math.floor(min(y0, y1) / GS)), int(math.floor(max(y0, y1) / GS)) + 1): out.add((cx, cy))
    return out
pl = {s_: [PLf(p) for p in sch[s_]] for s_ in range(nsec) if sch[s_] is not None}
nonzero = [s_ for s_ in sorted(pl) if key(pl[s_][0]) != key(pl[s_][-1])]
sgrid2 = collections.defaultdict(set)
for s_ in nonzero:
    for c in cells(pl[s_]): sgrid2[c].add(s_)
def crossings(P, skip):
    n = 0; seen_ = set()
    for c in cells(P):
        for s_ in sgrid2.get(c, ()):
            if s_ in skip or s_ in seen_: continue
            seen_.add(s_); Q = pl[s_]
            for i in range(len(P) - 1):
                for j in range(len(Q) - 1):
                    if segx(P[i], P[i + 1], Q[j], Q[j + 1]): n += 1
    return n
# Parallel sections between the same two nodes (a "ladder": two lines sharing every station)
# form one bundle; runs are chains of bundles, and every member of a bundle gets the same route.
bund = collections.defaultdict(list)
for s_ in nonzero: bund[tuple(sorted((key(pl[s_][0]), key(pl[s_][-1]))))].append(s_)
bkeys = sorted(bund)
binc = collections.defaultdict(list)
for bk in bkeys: binc[bk[0]].append(bk); binc[bk[1]].append(bk)
deg2 = {k for k, L in binc.items() if len(L) == 2}
leaf = {k for k, L in binc.items() if len(L) == 1}
# real position of each node (plane coords of the real track end there): a dead-end run is
# redrawn in its real direction and length from its junction (octi stretches spurs: every
# station takes a grid cell, so Zhuhai's line ran ~110 km too far south)
nodegeo = {}
for s_ in nonzero:
    nodegeo.setdefault(key(pl[s_][0]), PLf(geo[s_][0])); nodegeo.setdefault(key(pl[s_][-1]), PLf(geo[s_][-1]))
zero_at = collections.defaultdict(list)
for s_ in sorted(pl):
    if key(pl[s_][0]) == key(pl[s_][-1]): zero_at[key(pl[s_][0])].append(s_)
def bwalk(bk0, frm):
    """bundles after bk0 leaving node `frm`'s far side, through degree-2 nodes: ([(bundle, from_node)], end node)"""
    out = []; cur = bk0; at = bk0[1] if frm == bk0[0] else bk0[0]
    while at in deg2:
        nxt = [x for x in binc[at] if x != cur][0]
        if nxt == bk0: return None, at
        out.append((nxt, at)); cur = nxt; at = nxt[1] if at == nxt[0] else nxt[0]
    return out, at
def bpoly(bk, frm):
    s_ = min(bund[bk]); q = pl[s_]
    return q if key(q[0]) == frm else q[::-1]
seen = set(); chain_move = {}; sstat = collections.Counter()
for bk0 in bkeys:
    if bk0 in seen: continue
    fw, kb = bwalk(bk0, bk0[0]); bw, ka = bwalk(bk0, bk0[1])
    if fw is None or bw is None:
        seen.add(bk0); sstat['rings'] += 1; continue
    # orient: run goes ka -> ... -> bk0 -> ... -> kb
    run_b = [bk for bk, _ in reversed(bw)] + [bk0] + [bk for bk, _ in fw]
    for bk in run_b: seen.add(bk)
    # node sequence along the run
    nodes_ = [ka]
    for bk in run_b:
        nodes_.append(bk[1] if nodes_[-1] == bk[0] else bk[0])
    if nodes_[-1] != kb: sstat['walk_mismatch'] += 1; continue
    pts = []
    for bk, frm in zip(run_b, nodes_):
        q = bpoly(bk, frm); pts += q if not pts else q[1:]
    if len(run_b) < 2 and len(pts) <= 3: continue
    A, B = pts[0], pts[-1]
    if key(A) == key(B): sstat['loops'] += 1; continue
    members = [s_ for bk in run_b for s_ in bund[bk]]
    skip = set(members)
    old_x = crossings(pts, skip)
    lA, lB = nodes_[0] in leaf, nodes_[-1] in leaf
    spur = None
    # the run's real length in plane units (mean over parallel members)
    real_run = sum(sum(plen([PLf(p) for p in geo[t]]) for t in bund[bk]) / len(bund[bk]) for bk in run_b)
    if (lA or lB) and nodes_[0] in nodegeo and nodes_[-1] in nodegeo and \
            math.dist(nodegeo[nodes_[0]], nodegeo[nodes_[-1]]) >= 0.5 * real_run:
        # only a branch that is itself roughly straight: one that loops (a ring cut at a tile
        # edge, Hainan) would collapse onto the short chord between its ends
        gA, gB = nodegeo[nodes_[0]], nodegeo[nodes_[-1]]
        if lB:   # free end B: from A along the real vector
            B2 = (A[0] + gB[0] - gA[0], A[1] + gB[1] - gA[1]); sc = [octi2pl(A, B2), octi2pl(B2, A)[::-1]]
        else:    # free end A
            A2 = (B[0] - gB[0] + gA[0], B[1] - gB[1] + gA[1]); sc = [octi2pl(A2, B), octi2pl(B, A2)[::-1]]
        best_s = min(((crossings(R, skip), plen(R), i, R) for i, R in enumerate(sc)), key=lambda x: x[:3])
        if best_s[0] <= old_x and plen(best_s[3]) >= 0.6 * real_run: spur = best_s[3]
    cands = [octi2pl(A, B), octi2pl(B, A)[::-1]]
    if spur is None and plen(cands[0]) >= plen(pts) - 1e-9 and len(pts) <= 3: continue      # already straight
    def dev(R):
        def pd(p):
            best_ = 1e18
            for i in range(len(R) - 1):
                (x0, y0), (x1, y1) = R[i], R[i + 1]; l2 = (x1 - x0) ** 2 + (y1 - y0) ** 2
                t = 0 if l2 == 0 else max(0, min(1, ((p[0] - x0) * (x1 - x0) + (p[1] - y0) * (y1 - y0)) / l2))
                best_ = min(best_, math.dist(p, (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)))
            return best_
        return max(pd(p) for p in pts)
    if spur is not None:
        R = spur; sstat['spurs_to_real'] += 1
    else:
        best = min(((crossings(R, skip), dev(R), i, R) for i, R in enumerate(cands)), key=lambda x: x[:3])
        if best[0] > old_x: sstat['kept_crossing'] += 1; continue
        # straightening removes jogs, it never collapses a run: a route much shorter than the
        # drawing means the run loops back near its start (Hainan's ring: both ends at Haikou)
        if plen(best[3]) < 0.6 * plen(pts): sstat['kept_short'] += 1; continue
        R = best[3]
    LR = plen(R)
    km_ = [max(sum(glen(geo[t]) for t in bund[bk]) / len(bund[bk]), 1e-6) for bk in run_b]; tot = sum(km_)
    cum = [0.0]
    for k_ in km_: cum.append(cum[-1] + k_ / tot)
    def at(u):
        t_ = u * LR; acc = 0
        for i in range(len(R) - 1):
            sl = math.dist(R[i], R[i + 1])
            if acc + sl >= t_ - 1e-12:
                r = 0 if sl == 0 else (t_ - acc) / sl
                return (R[i][0] + (R[i + 1][0] - R[i][0]) * r, R[i][1] + (R[i + 1][1] - R[i][1]) * r)
            acc += sl
        return R[-1]
    def subr(u0, u1):
        q = [at(u0)]; acc = 0
        for i in range(1, len(R) - 1):
            acc += math.dist(R[i - 1], R[i]); u = acc / LR
            if u0 < u < u1: q.append(R[i])
        return q + [at(u1)]
    newpt = {}
    for bk, frm, u0, u1 in zip(run_b, nodes_, cum, cum[1:]):
        q = subr(u0, u1)
        for s_ in bund[bk]:
            qq = q if key(pl[s_][0]) == frm else q[::-1]
            pl[s_] = qq; sch[s_] = [PLi(p) for p in qq]; touched.add(s_)
            for c in cells(qq): sgrid2[c].add(s_)
        newpt[frm] = q[0]
    for k_ in nodes_[1:-1]:
        chain_move[k_] = PLi(newpt[k_])          # keyed by plane node key
    if spur is not None:                         # the free end moved too
        if lB: chain_move[nodes_[-1]] = PLi(R[-1])
        else: chain_move[nodes_[0]] = PLi(R[0])
    sstat['runs_straightened'] += 1; sstat['sections_straightened'] += len(members)
for k_, L in zero_at.items():               # collapsed sections ride with their node
    np_ = chain_move.get(k_)
    if np_:
        for s_ in L: sch[s_] = [np_, np_]
cstat.update(sstat)
cstat = dict(cstat)
# --- islands redrawn from real track. Hainan joins the network only through the Qiongzhou
# train ferry, and a tile edge (109.6 E) cut its ring in two, so octi drew the east line down
# the west side. The island (and the ferry) are redrawn from real geometry, moved as one so
# the ferry's mainland end lands on its schematic point, then simplified (DP) and bent only at
# 0/45/90 degrees; section ends stay shared, so the ring closes by construction.
ISLANDS = [{'name': 'hainan', 'bbox': (108.4, 18.0, 111.3, 20.15),
            'ferry': lambda g: min(p[1] for p in g) < 20.15 and max(p[1] for p in g) > 20.2 and all(110.0 < p[0] < 110.3 for p in g)}]
ISLAND_TOL = 0.04   # DP tolerance in plane degrees (~4 km)
def snap_pl(P, tol):
    """octilinear polyline through a DP simplification of P (plane coords), ends exact"""
    if len(P) < 2: return list(P)
    Q = dp(P, tol); out = [Q[0]]
    for a, b in zip(Q, Q[1:]):
        c1 = octi2pl(a, b); c2 = octi2pl(b, a)[::-1]
        i0 = P.index(a) if a in P else 0; i1 = P.index(b) if b in P else len(P) - 1
        mid = P[min(i0, i1):max(i0, i1) + 1] or [a, b]
        def dev(R):
            return max(min(math.dist(p, (R[i][0] + (R[i + 1][0] - R[i][0]) * t, R[i][1] + (R[i + 1][1] - R[i][1]) * t))
                           for i in range(len(R) - 1) for t in [max(0, min(1, ((p[0] - R[i][0]) * (R[i + 1][0] - R[i][0]) + (p[1] - R[i][1]) * (R[i + 1][1] - R[i][1])) / max(1e-18, math.dist(R[i], R[i + 1]) ** 2)))])
                       for p in mid)
        out += (c1 if dev(c1) <= dev(c2) else c2)[1:]
    return dedup(out)
island_secs = set(); island_bbox = []
for isl in ISLANDS:
    x0, y0, x1, y1 = isl['bbox']
    inside = [s_ for s_ in range(nsec) if all(x0 < p[0] < x1 and y0 < p[1] < y1 for p in geo[s_])]
    ferry = [s_ for s_ in range(nsec) if isl['ferry'](geo[s_])]
    if not inside: continue
    # the ferry's mainland end: the end north of the strait; translation = schematic - real there
    vec = []
    for s_ in ferry:
        g = geo[s_]; e = 0 if g[0][1] > g[-1][1] else -1
        if sch[s_] is None: continue
        sp = PLf(sch[s_][e]); rp = PLf(g[e]); vec.append((sp[0] - rp[0], sp[1] - rp[1]))
    if not vec: continue
    dx = sum(v[0] for v in vec) / len(vec); dy = sum(v[1] for v in vec) / len(vec)
    for s_ in inside + ferry:
        P = [(PLf(p)[0] + dx, PLf(p)[1] + dy) for p in geo[s_]]
        q = snap_pl(P, ISLAND_TOL)
        if s_ in ferry:   # keep the mainland end exactly where the network has it
            g = geo[s_]; e = 0 if g[0][1] > g[-1][1] else -1
            tgt = PLf(sch[s_][e])
            if e == 0: q = octi2pl(tgt, q[0])[:-1] + q if math.dist(tgt, q[0]) > 1e-9 else q
            else: q = q + octi2pl(q[-1], tgt)[1:] if math.dist(tgt, q[-1]) > 1e-9 else q
        if len(q) < 2: q = [q[0], q[0]]
        sch[s_] = [PLi(p) for p in q]; touched.add(s_); island_secs.add(s_)
    island_bbox.append(isl['bbox']); cstat['island_sections'] = cstat.get('island_sections', 0) + len(inside) + len(ferry)

vimg = {}
for s_ in range(nsec):
    if sch[s_] is None: continue
    for gp, sp in ((geo[s_][0], sch[s_][0]), (geo[s_][-1], sch[s_][-1])): vimg.setdefault(gp, sp)

# --- transform T for off-mapping points
G = 0.1
grid = collections.defaultdict(list)          # cell -> (s, i) segments of mapped sections
cumg = [None] * nsec; cums = [None] * nsec
for s in range(nsec):
    if sch[s] is None: continue
    g = geo[s]; cg = [0.0]
    for i in range(len(g) - 1): cg.append(cg[-1] + math.dist(g[i], g[i + 1]))
    cs = [0.0]
    for i in range(len(sch[s]) - 1): cs.append(cs[-1] + math.dist(sch[s][i], sch[s][i + 1]))
    cumg[s], cums[s] = cg, cs
    for i in range(len(g) - 1):
        x0, x1 = sorted((g[i][0], g[i + 1][0])); y0, y1 = sorted((g[i][1], g[i + 1][1]))
        for cx in range(int(math.floor(x0 / G)), int(math.floor(x1 / G)) + 1):
            for cy in range(int(math.floor(y0 / G)), int(math.floor(y1 / G)) + 1):
                grid[(cx, cy)].append((s, i))


def at_frac(s, f):
    q, cs = sch[s], cums[s]; t = f * cs[-1]
    for i in range(len(q) - 1):
        if cs[i + 1] >= t - 1e-12:
            d = cs[i + 1] - cs[i]; r = 0 if d == 0 else (t - cs[i]) / d
            return (q[i][0] + (q[i + 1][0] - q[i][0]) * r, q[i][1] + (q[i + 1][1] - q[i][1]) * r)
    return q[-1]


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
        tstat['project'] += 1; return at_frac(s, f)
    # far from every section: shift by the nearest mapped vertex's offset
    gp = min(vimg, key=lambda v: (v[0] - p[0]) ** 2 + (v[1] - p[1]) ** 2); sp = vimg[gp]
    tstat['offset'] += 1; return (p[0] + sp[0] - gp[0], p[1] + sp[1] - gp[1])


for s in range(nsec):
    if sch[s] is None:
        q = [T(geo[s][0])]; sch[s] = [q[0], q[0]]; stat['unmapped->T'] += 1

# --- stations: octi station nodes where octi placed them, else T
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
        c = tuple(f['geometry']['coordinates']); c = tuple(node_move.get(key(c), c))
        stn.setdefault(int(st), tuple(chain_move.get(key(PLf(c)), c)))
# stations on a redrawn island are placed on the new drawing (by T below), not octi's nodes
for i_, t_ in enumerate(pack['station_table']):
    if 'pt' in t_ and any(b[0] < t_['pt'][0] < b[2] and b[1] < t_['pt'][1] < b[3] for b in island_bbox): stn.pop(i_, None)
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

# --- throats: straight from the image of one end to the other
def throat(g):
    q = dec(g); a, b = T(q[0]), T(q[-1]); return [a, b]
thr = [throat(g) for g in pack['throats']]
extra = [throat(g) for g in nat['extra']]
# the backdrop is the drawn sections themselves (after continuity, cleanup and straightening),
# so it never shows a line that trains are no longer drawn on
network = [dedup(sch[s_]) for s_ in range(nsec) if sch[s_] is not None and len(dedup(sch[s_])) >= 2]

# Output plane: octi is octilinear in web mercator, but the client draws lon/lat on an
# equirectangular plane. So every output point is (lon, mercator y in degrees): 0/45/90
# degrees stay exact on screen. The client projects the coastline outline the same way.
PL = lambda p: (p[0], M(p)[1])
sch = [[PL(p) for p in q] for q in sch]; in_sch = [[PL(p) for p in q] for q in in_sch]
network = [[PL(p) for p in q] for q in network]; thr = [[PL(p) for p in q] for q in thr]
extra = [[PL(p) for p in q] for q in extra]
station_pt = [PL(p) if p else None for p in station_pt]; city_pt = [PL(p) for p in city_pt]
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
print(json.dumps({'cities_on': cpstat, 'continuity': cstat, 'sections': stat, 'in_sections': istat, 'T': tstat, 'stations_octi': len(stn),
                  'stations': len(station_pt), 'cities': len(city_pt), 'network': len(network)}), file=sys.stderr)
