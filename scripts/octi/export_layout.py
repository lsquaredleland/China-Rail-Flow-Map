"""Turns a stitched octi layout into the client's schematic geometry asset.

usage: python3 -I export_layout.py shared.json national-trains.json graph.json map.json out.json side.json...

Inputs: the shared pack, the national trains, the stitched octi graph and its per-section
mapping (stitch.py), and the tiles' side files (convert2.py). Output: atlas-v2-octi.json
(docs/OCTI.md). Every geometry field the client draws gets a schematic twin with the SAME ids
and lengths, so flows, paths, trains and tables are untouched; the client swaps the arrays
before decoding (dumb client):
  sections[s], in_sections[s]  encoded polylines (precision 1e4, lat/lon order, like `g`)
  network                      the drawn sections (backdrop only, own count)
  throats[t], extra[t]         station throats (shared pack, national trains `extra`)
  station_pt[i], city_pt[i]    [lon, y]
All schematic points are on the plane (lon, mercator y in degrees; octi_geom.PL).

Stages (one function each, called in order by `main`):
  octi_drawing      the octi edges each section was mapped to, as one polyline per section
  join_stations     rule 1: section ends that real track joins inside a station are one point
  Skeleton          nodes, bundles and runs of that drawing (octi_geom)
  place_junctions   rule 2: offsets between neighbouring junctions are pulled towards the
                    real ones (short runs firmly, long runs loosely); then every junction
                    takes a point of the lattice
  place_free_ends   rule 3: a dead-end branch keeps its real offset from its junction
  route_runs        rule 4: every run is the simplest octilinear route that stays near its
                    real shape, crosses only what it really crosses and keeps to its real
                    side of the lines that really run alongside (class Router)
  Transform         every point that is not on the mapping (throat ends, stations,
                    in_sections that differ from sections): nearest section within
                    SNAP_DEG, by fraction along its drawing; else the nearest vertex's offset
  place_stations, place_cities, draw_in_sections, draw_throats, write_asset

octi gives the starting layout; the four rules compare it with the real track and redraw
what disagrees. There are no per-place cases. The run is deterministic: every loop that
decides something walks sorted or insertion-ordered data.
"""
import json, sys, math, collections, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # -I leaves the script's directory out
from octi_geom import (CELL, EPS, KM_PER_DEG, SIDE_MIN_KM, STEP, PL, PLi, Skeleton, carry, cells, cumlen, cut, dec, dedup,
                       dp, drawn_side, enc, gkm, glen, key, lattice, meet, octi2pl, octi3pl, octi_along, pdist, plen,
                       side_samples, tidy, walk)

# --- constants (plane degrees unless named _KM)
SNAP_DEG = 0.05        # Transform: max distance (lon/lat degrees) from a section to project onto it
TRANSFORM_CELL = 0.1   # Transform: cell of its grid over the real track (lon/lat degrees)
SIMPLIFY_DEG = 0.004   # Douglas-Peucker tolerance for octi's rendered corner points (~0.4 km)
JOIN_KM = 12.0         # rule 1: widest station, >= the longest throat (11.7 km)
LOOP_KM = 5.0          # rule 1: a section longer than this is never collapsed into a station
STATION_SNAP = 0.03    # rule 1: a dangling end this close (lon/lat degrees) to a station is at it (as convert2)
STATION_CELLS = 20     # rule 1: station lookup grid, cells per degree
SMOOTH = 1.0           # rule 2: how firmly a junction holds octi's point against its runs' real offsets
STIFF = CELL / 2       # rule 2: runs shorter than this pull no harder (one station complex stays apart)
RELAX_ITERS = 200      # rule 2: Gauss-Seidel iterations (converged long before)
LATTICE_REACH = 2      # rule 2: a junction looks this many lattice steps around for a free point
FIT = CELL / 2         # rule 4: a run is drawn within this distance (10.8 km) of its real shape where it can be
FAR = 3 * CELL         # rule 4: and never further than this when a nearer route exists
SHAPES = (CELL, CELL / 2, CELL / 4, CELL / 8)   # rule 4: Douglas-Peucker tolerances of the real-shape routes, simplest first
OCTI_TOL = CELL / 4    # rule 4: tolerance when octi's own route is carried to moved ends
BESIDE_SHAPES = SHAPES[1:3]   # rule 4: tolerances of the routes one lattice step aside
BESIDE = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))   # rule 4: the eight ways aside
SWEEPS = 4             # rule 4: passes over all runs (each run is routed against the others' routes)


# ============================================================ octi's drawing
def octi_drawing(feats, mp, geo):
    """One plane polyline per pack section from the stitched octi graph: the pieces of octi
    edges it was mapped to, or the node it collapsed into. Sections octi lost (degenerate,
    0 km) sit at a touching section's end when there is one, else stay None (placed later
    by the Transform). Returns (sch, node points, counts)."""
    edges = []
    for fi, _ in mp['edges']:
        c = [PL(x) for x in feats[fi]['geometry']['coordinates']]; edges.append((c, cumlen(c)))
    nodes = [PL(feats[fi]['geometry']['coordinates']) for fi, _ in mp['nodes']]

    def piece(k, u0, u1):
        """edge k from fraction u0 to u1 (either direction)"""
        c, cum = edges[k]; a, b = sorted((u0, u1)); q = cut(c, cum, a * cum[-1], b * cum[-1])
        return q if u1 >= u0 else q[::-1]

    sch = [None] * len(geo); stat = collections.Counter()
    for s in range(len(geo)):
        r = mp['sections'].get(str(s))
        if r and r.get('p'):
            q = []
            for k, u0, u1, _ in r['p']: q += piece(k, u0, u1)
            q = dedup(q)
            if len(q) < 2: q = [q[0], q[0]]
            ends = (q[0], q[-1]); q = dp(q, SIMPLIFY_DEG); q[0], q[-1] = ends
            sch[s] = q; stat['line'] += 1
        elif r and 'n' in r:
            sch[s] = [nodes[r['n']], nodes[r['n']]]; stat['node'] += 1
        else:
            stat['unmapped'] += 1
    vimg = end_images(geo, sch)
    for s in range(len(geo)):
        if sch[s] is None and geo[s][0] in vimg: sch[s] = [vimg[geo[s][0]], vimg[geo[s][0]]]; stat['unmapped->end'] += 1
    return sch, stat


def end_images(geo, sch):
    """real end point (lon, lat) -> where the first section ending there is drawn"""
    vimg = {}
    for s in range(len(geo)):
        if sch[s] is None: continue
        for gp, sp in ((geo[s][0], sch[s][0]), (geo[s][-1], sch[s][-1])): vimg.setdefault(gp, sp)
    return vimg


# ============================================================ rule 1: stations
class EndGroups:
    """Union-find over section ends (section, 0 = start | 1 = end). A checked join never
    makes a group wider than JOIN_KM (no chaining across a city) or puts both ends of a
    section longer than LOOP_KM into one group (it would be drawn as a point)."""
    def __init__(self, geo):
        self.geo = geo; self.par = {}; self.long = {}; self.box = {}
        self.is_long = [len(set(g)) >= 2 and glen(g) > LOOP_KM for g in geo]

    def find(self, x):
        """the root end of x's group"""
        if x not in self.par:
            p = self.geo[x[0]][-1 if x[1] else 0]
            self.par[x] = x; self.long[x] = {x[0]} if self.is_long[x[0]] else set(); self.box[x] = (p[0], p[1], p[0], p[1])
        while self.par[x] != x: self.par[x] = self.par[self.par[x]]; x = self.par[x]
        return x

    def union(self, a, b, check=True):
        """merge the groups of a and b; False when the check refuses"""
        ra, rb = self.find(a), self.find(b)
        if ra == rb: return True
        A, B = self.box[ra], self.box[rb]; bx = (min(A[0], B[0]), min(A[1], B[1]), max(A[2], B[2]), max(A[3], B[3]))
        if check and (self.long[ra] & self.long[rb] or gkm(bx[:2], bx[2:]) > JOIN_KM): return False
        if ra > rb: ra, rb = rb, ra
        self.par[rb] = ra; self.long[ra] |= self.long.pop(rb); self.box[ra] = bx; self.box.pop(rb); return True


def joins_from_paths(nat, geo, sch):
    """(gap km, end, end): the closest ends of sections a train path runs between with only
    throats in between (the path's signs do not reliably give the ends)"""
    nsec = len(geo)
    for path in nat['paths']:
        prev = None
        for x in path:
            if abs(x) >= nsec: continue
            if prev is not None and abs(prev) != abs(x) and sch[abs(prev)] is not None and sch[abs(x)] is not None:
                g, ea, eb = min((gkm(geo[abs(prev)][-1 if i else 0], geo[abs(x)][-1 if j else 0]), (abs(prev), i), (abs(x), j))
                                for i in (0, 1) for j in (0, 1))
                if g <= JOIN_KM: yield g, ea, eb
            prev = x


def joins_from_throats(pack, ends_at):
    """(gap km, end, end): ends linked by throats, through the station's own points (which
    are no section's end)"""
    tadj = collections.defaultdict(list)
    for g in pack['throats']:
        q = dec(g)
        if q[0] != q[-1]: l = glen(q); tadj[q[0]].append((q[-1], l)); tadj[q[-1]].append((q[0], l))
    for pt in sorted(ends_at):
        seen = {pt}; todo = [(pt, 0.0)]
        while todo:
            x, d = todo.pop()
            for y, l in tadj.get(x, ()):
                if y in seen or d + l > JOIN_KM: continue
                seen.add(y)
                if y not in ends_at: todo.append((y, d + l))
                elif pt < y and gkm(pt, y) <= JOIN_KM: yield gkm(pt, y), ends_at[pt][0], ends_at[y][0]


def joins_from_stations(pack, geo, ends_at):
    """(0, end, end): dangling ends (no other track ends there) that snap to the same station"""
    degree = collections.Counter()
    for g in geo:
        if len(set(g)) >= 2: degree[g[0]] += 1; degree[g[-1]] += 1
    grid = collections.defaultdict(list); K = STATION_CELLS
    for i, t in enumerate(pack['station_table']):
        if 'pt' in t: grid[(int(t['pt'][0] * K), int(t['pt'][1] * K))].append((i, t['pt']))
    by_station = collections.defaultdict(list)
    for pt, es in ends_at.items():
        if degree[pt] != 1: continue
        best = None
        for gx in (-1, 0, 1):
            for gy in (-1, 0, 1):
                for i, sp in grid.get((int(pt[0] * K) + gx, int(pt[1] * K) + gy), []):
                    d = math.hypot(sp[0] - pt[0], sp[1] - pt[1])
                    if d <= STATION_SNAP and (best is None or d < best[0]): best = (d, i)
        if best: by_station[best[1]].append(es[0])
    for es in by_station.values():
        for e in es[1:]: yield 0.0, es[0], e


def extend(q, target):
    """q ends at q[-1]; drop trailing vertices that lead away from target (at most half the
    length), then add an octilinear leg to target"""
    L = plen(q); acc = 0; k = len(q) - 1
    while k > 0 and math.dist(q[k - 1], target) < math.dist(q[k], target) and acc + math.dist(q[k - 1], q[k]) <= L / 2:
        acc += math.dist(q[k - 1], q[k]); k -= 1
    return q[:k] + octi2pl(q[k], target)


def join_stations(pack, nat, feats, geo, sch):
    """Rule 1. octi can leave the two sides of a station or junction on different nodes
    (ends snapped to neighbouring stations, collapsed throat pieces, tile seams), so a line
    jumps there. Section ends are grouped: ends at the same real point; ends that real
    track joins inside a station (`joins_from_paths`, `joins_from_throats`); dangling ends
    at one station (`joins_from_stations`); closest pairs first, under the checks of
    `EndGroups`. Each group gets one schematic point: where most of its ends already are
    (then an octi station node, then the smallest coordinates); the other ends move there
    with a short octilinear leg (`extend`). Changes `sch` in place. Returns (node_move:
    octi node key -> new point, for nodes whose every section end moved; counts)."""
    nsec = len(geo); groups = EndGroups(geo); stat = collections.Counter()
    ends_at = collections.defaultdict(list)            # real end point -> section ends
    for s in range(nsec):
        if sch[s] is None: continue
        ends_at[geo[s][0]].append((s, 0)); ends_at[geo[s][-1]].append((s, 1))
    for es in ends_at.values():
        for e in es[1:]: groups.union(es[0], e, check=False)
    cand = set()
    for source in (joins_from_paths(nat, geo, sch), joins_from_throats(pack, ends_at), joins_from_stations(pack, geo, ends_at)):
        for g, ea, eb in source: cand.add((round(g, 6), min(ea, eb), max(ea, eb)))
    skipped = sum(not groups.union(a, b) for _, a, b in sorted(cand))
    members = collections.defaultdict(list)
    for s in range(nsec):
        if sch[s] is None: continue
        for e in ((s, 0), (s, 1)): members[groups.find(e)].append(e)
    station_nodes = set()
    for f in feats:
        if f['geometry']['type'] == 'Point' and f['properties'].get('station_id') and f['properties'].get('station_label') != 'cut':
            station_nodes.add(key(PL(f['geometry']['coordinates'])))
    ends_here = collections.Counter()
    for s in range(nsec):
        if sch[s] is not None: ends_here[key(sch[s][0])] += 1; ends_here[key(sch[s][-1])] += 1

    moved = {}; moved_from = collections.Counter(); moves_km = []
    for root, es in members.items():
        at = collections.Counter(key(sch[s][-1 if e else 0]) for s, e in es)
        if len(at) < 2: continue
        tgt = min(at, key=lambda p: (-at[p], p not in station_nodes, p))
        tp = next(sch[s][-1 if e else 0] for s, e in es if key(sch[s][-1 if e else 0]) == tgt)
        stat['groups_moved'] += 1
        for s, e in sorted(es):
            q = sch[s]; cur = q[-1 if e else 0]
            if key(cur) == tgt: continue
            moves_km.append(gkm(PLi(cur), PLi(tp))); moved_from[key(cur)] += 1
            if len(q) == 2 and key(q[0]) == key(q[1]) and all(groups.find((s, x)) == root for x in (0, 1)):
                sch[s] = [tp, tp]; moved_from[key(cur)] += 1; stat['node_moved'] += 1; continue
            sch[s] = extend(q, tp) if e else extend(q[::-1], tp)[::-1]; stat['ends_moved'] += 1
        for p in at:
            if p != tgt: moved[p] = tp
    node_move = {p: t for p, t in moved.items() if moved_from[p] >= ends_here[p]}
    # moving an end can make a section double back over its own piece (an out-and-back spike, a loop)
    for s in range(nsec):
        if sch[s] is not None: sch[s] = tidy(sch[s])
    stat = dict(stat); stat.update({'join_pairs': len(cand), 'joins_skipped': skipped, 'station_nodes_followed': len(node_move)})
    if moves_km: stat['move_km_p50_p90_max'] = quantiles(moves_km)
    return node_move, stat


def quantiles(v):
    """[median, 90%, max] of v, rounded"""
    v = sorted(v); return [round(v[len(v) // 2], 1), round(v[int(len(v) * .9)], 1), round(v[-1], 1)]


# ============================================================ rule 4's machinery: routing a run
def deviation(R, I):
    """how far route R and the real-shape image I are apart (both ways)"""
    c = cumlen(R); n = max(2, int(c[-1] / (CELL / 2)) + 1)
    return max(max(pdist(p, R) for p in I), max(pdist(walk(R, c, c[-1] * i / n), I) for i in range(n + 1)))


class Router:
    """Chooses and draws the route of each run of a skeleton, against the current drawing of
    all other sections (`sk.sch`, which it updates)."""
    def __init__(self, sk):
        self.sk = sk
        # where real tracks run alongside: along[s] = [(u, t, f, side)], and the same seen from t
        self.along = side_samples(sk.real, [s for s in sk.nonzero if plen(sk.real[s]) * KM_PER_DEG >= SIDE_MIN_KM])
        self.along_of = collections.defaultdict(list)
        for s, rows in sorted(self.along.items()):
            for u, t, f, sg in rows:
                if t in sk.real: self.along_of[t].append((s, u, f, sg))
        self.grid = collections.defaultdict(set)       # cell -> sections drawn through it (never shrinks)
        for s in sk.nonzero:
            for c in cells(sk.sch[s]): self.grid[c].add(s)

    def faults(self, run, R):
        """what route R would get wrong, worst first: (sections crossed that the run's section
        does not really cross, points on the wrong side of, or on top of, a line that really
        runs alongside, lines overlapped outside a shared corridor)"""
        sk = self.sk; sch = sk.sch; crossed = lap = off_side = 0
        for bk, frm, piece in zip(run.b, run.n, run.pieces(R)):
            mem = sk.bund[bk]; seen = set(); s0 = mem[0]
            P = piece if sk.ends[s0][0] == frm else piece[::-1]; cP = cumlen(P)
            for u, t, f, sg in self.along.get(s0, ()):
                if t not in run.skip: d = drawn_side(P, cP, u, sch[t], cumlen(sch[t]), f); off_side += d is not None and d != sg
            for t, u, f, sg in self.along_of.get(s0, ()):
                if t not in run.skip: d = drawn_side(sch[t], cumlen(sch[t]), u, P, cP, f); off_side += d is not None and d != sg
            for c in sorted(cells(piece)):
                for t in sorted(self.grid.get(c, ())):
                    if t in run.skip or t in seen: continue
                    seen.add(t); x, o = meet(piece, sch[t])
                    if x and not any(sk.really_cross(s, t) for s in mem): crossed += 1
                    if o and not any(sk.corridor(s, t) for s in mem): lap += 1
        return crossed, off_side, lap

    def candidates(self, run, A, B, beside=False):
        """Routes for the run from A to B, simplest first, as (route, distance from the real
        shape, kind): one to three legs; octilinear routes along the real shape (coarse to
        fine); the route octi gave it (carried along if its ends moved); with `beside`, the
        real shape one lattice step to each side, tapered to the ends. The real shape is the
        real track carried to A and B. A run too short for the lattice is a point."""
        I = carry(run.real, A, B); Is = dp(I, CELL / 8); out = []; have = set()
        def add(R, kind):
            """keep route R unless it is a point or already there"""
            k = tuple(key(p) for p in R)
            if k not in have and plen(R) > EPS: have.add(k); out.append((R, deviation(R, Is), kind))
        if math.dist(A, B) > EPS:
            add(octi2pl(A, B), 'legs'); add(octi2pl(B, A)[::-1], 'legs')
            for R in octi3pl(A, B): add(R, 'legs')
        for tol in SHAPES: add(octi_along(I, tol), 'shape')
        O = run.octi
        add(O if key(O[0]) == key(A) and key(O[-1]) == key(B) else octi_along(carry(O, A, B), OCTI_TOL), 'octi')
        if beside:
            c = cumlen(I); L = c[-1]; ramp = min(L / 3, CELL) or 1.0
            for dx, dy in BESIDE:
                J = [(p[0] + dx * STEP * min(1, t / ramp, (L - t) / ramp), p[1] + dy * STEP * min(1, t / ramp, (L - t) / ramp)) for p, t in zip(I, c)]
                for tol in BESIDE_SHAPES: add(octi_along(J, tol), 'beside')
        return out or [([A, B], 0.0, 'point')]

    def best(self, run, cand):
        """(cost, candidate) to draw: never a route far off the real shape (FAR) when a nearer
        one exists; then the fewest faults; then the simplest that fits (FIT), else the nearest.
        cost[1] is the route's `faults`."""
        def cost(i):
            """the sort key of candidate i"""
            R, dev, _ = cand[i]
            return (dev > FAR, self.faults(run, R), dev > FIT, i if dev <= FIT else dev, i)
        c, i = min((cost(i), i) for i in range(len(cand)))
        return c, cand[i]

    def draw(self, run, choice):
        """give every section of the run its piece of the chosen route; nodes along the run follow"""
        sk = self.sk; R, run.dev, run.kind = choice; run.route = R
        for bk, frm, q in zip(run.b, run.n, run.pieces(R)):
            sk.pos[frm] = q[0]
            for s in sk.bund[bk]:
                sk.sch[s] = q if sk.ends[s][0] == frm else q[::-1]
                for c in cells(q): self.grid[c].add(s)
        sk.pos[run.n[-1]] = R[-1]


# ============================================================ rule 2: junctions
def place_junctions(sk, router):
    """Rule 2. octi places junctions on its grid one by one, so neighbours can end up on the
    wrong side of each other (a branch joining a line far from where it does, a ring folded
    flat). The schematic should be a smooth deformation of the real map: the offset between
    two junctions should be the real one, the more so the shorter the run between them.
    Junction positions X minimise
        sum over runs |X_j - X_i - real offset|^2 / run length  +  SMOOTH * sum |X_i - octi's point|^2
    (Gauss-Seidel; short runs are stiff, long runs give, and every junction stays near where
    octi put it). Every junction then takes the nearest free point of the lattice: routes
    between lattice points bend on lattice points, so lines coincide, touch or cross
    cleanly. All runs are then redrawn on octi's routes, carried to the new positions.
    Returns the distances moved (km)."""
    runs = sk.runs; pos = sk.pos
    junctions = sorted({k for r in runs for k in (r.n[0], r.n[-1])})
    link = {}       # junction pair -> (real offset a->b, real length) of the run between them
    for r in runs:
        a, b = r.n[0], r.n[-1]; v = (r.real[-1][0] - r.real[0][0], r.real[-1][1] - r.real[0][1])
        if a > b: a, b, v = b, a, (-v[0], -v[1])
        # of several runs between two junctions (their ends lie apart inside a station complex), the widest counts
        if a != b and ((a, b) not in link or math.hypot(*v) > math.hypot(*link[(a, b)][0])): link[(a, b)] = (v, plen(r.real))
    pull = collections.defaultdict(list)            # junction -> (other junction, weight, real offset to here)
    for (a, b), (v, l) in sorted(link.items()):
        w = 1 / max(l, STIFF); pull[b].append((a, w, v)); pull[a].append((b, w, (-v[0], -v[1])))
    X0 = {k: pos[k] for k in junctions}; X = dict(X0)
    for _ in range(RELAX_ITERS):
        for k in junctions:
            sw = SMOOTH; sx = SMOOTH * X0[k][0]; sy = SMOOTH * X0[k][1]
            for j, w, v in pull[k]: sw += w; sx += w * (X[j][0] + v[0]); sy += w * (X[j][1] + v[1])
            X[k] = (sx / sw, sy / sw)
    taken = set(); reach = range(-LATTICE_REACH, LATTICE_REACH + 1)
    for k in sorted(junctions, key=lambda k: (-len(pull[k]), k)):      # busiest junctions choose first
        c = lattice(X[k])
        spots = sorted((math.dist(X[k], q), q) for q in ((c[0] + i * STEP, c[1] + j * STEP) for i in reach for j in reach))
        X[k] = next(q for _, q in spots if key(q) not in taken); taken.add(key(X[k]))
    for k in junctions: pos[k] = X[k]
    for run in runs:
        router.draw(run, router.candidates(run, pos[run.n[0]], pos[run.n[-1]])[-1])
    return [math.dist(X[k], X0[k]) * KM_PER_DEG for k in junctions]


# ============================================================ rule 3: free ends
def hanging_runs(runs):
    """[(run index, junction it hangs on, its free node)] for every dead-end run, leaves
    first: peeling leaves off the graph of runs leaves the trunk"""
    degree = collections.Counter(); at = collections.defaultdict(list)
    for i, r in enumerate(runs):
        degree[r.n[0]] += 1; degree[r.n[-1]] += 1
        if r.n[0] != r.n[-1]: at[r.n[0]].append(i); at[r.n[-1]].append(i)
    hang = []; gone = set(); leaves = sorted(k for k in at if degree[k] == 1)
    while leaves:
        nxt = []
        for k in leaves:
            left = [i for i in at[k] if i not in gone]
            if degree[k] != 1 or len(left) != 1: continue
            i = left[0]; gone.add(i); up = runs[i].n[0] if runs[i].n[-1] == k else runs[i].n[-1]
            hang.append((i, up, k)); degree[up] -= 1; degree[k] -= 1
            if degree[up] == 1: nxt.append(up)
        leaves = sorted(set(nxt))
    return hang


def place_free_ends(sk, router):
    """Rule 3. octi gives every station a grid cell, which stretches branches (Zhuhai's line
    ran ~110 km too far south). A dead-end run hangs on one junction, so its free end is
    free to be right: it takes the real offset from that junction (on the lattice).
    Branches of branches follow from the trunk outwards. A move that would add faults is
    not made. Returns counts."""
    runs = sk.runs; pos = sk.pos; stat = collections.Counter()
    for i, up, k in reversed(hanging_runs(runs)):
        if runs[i].n[0] != up: runs[i] = runs[i].flipped()
        run = runs[i]; A = pos[up]
        real_end = lattice((A[0] + run.real[-1][0] - run.real[0][0], A[1] + run.real[-1][1] - run.real[0][1]))
        c0, kept = router.best(run, router.candidates(run, A, pos[k]))
        c1, real = router.best(run, router.candidates(run, A, real_end))
        if c1[1] <= c0[1]: router.draw(run, real); stat['free_ends_to_real'] += 1
        else: router.draw(run, kept); stat['free_ends_kept'] += 1
    return dict(stat)


# ============================================================ rule 4: runs
def route_runs(sk, router):
    """Rule 4. Every run is drawn as the simplest octilinear route between its two nodes that
    stays within FIT of its real shape, crosses only what it really crosses and keeps to its
    real side of every line that really runs alongside (so two lines in one valley are drawn
    side by side in the real order, swap sides where they really cross, and a line that
    leaves a corridor and rejoins it is drawn as that excursion): up to three legs when the
    real track is that straight, else a route along the real shape, as coarse as fits. A run
    whose best route still has a fault also tries the real shape one lattice step to either
    side. Parallel sections (a bundle) share the route; stations along it are spaced by real
    distance. Runs are routed against each other's current routes, in up to SWEEPS sweeps.
    Returns counts."""
    stat = {}
    for sweep in range(SWEEPS):
        changed = 0
        for run in sk.runs:
            A, B = sk.pos[run.n[0]], sk.pos[run.n[-1]]
            if run.cand is None: run.cand = router.candidates(run, A, B); run.wide = False
            c, choice = router.best(run, run.cand)
            if any(c[1]) and not run.wide:
                run.cand = router.candidates(run, A, B, beside=True); run.wide = True; c, choice = router.best(run, run.cand)
            if run.route is None or [key(p) for p in choice[0]] != [key(p) for p in run.route]: router.draw(run, choice); changed += 1
        stat['sweep%d_changed' % (sweep + 1)] = changed
        if not changed: break
    return stat


def ride_with_nodes(sk):
    """sections collapsed into a node are drawn where that node is now"""
    for s in sk.drawn:
        k = sk.ends[s][0]
        if k == sk.ends[s][1] and k in sk.pos:
            d = (sk.pos[k][0] - sk.sch[s][0][0], sk.pos[k][1] - sk.sch[s][0][1]); sk.sch[s] = [(p[0] + d[0], p[1] + d[1]) for p in sk.sch[s]]


def layout_stats(sk, router, moved_km):
    """counts describing the finished layout (for the log)"""
    f = [router.faults(r, r.route) for r in sk.runs]
    return {'junction_move_km_p50_p90_max': quantiles(moved_km), 'runs': len(sk.runs), 'bundles': len(sk.bund),
            'bundled_sections': sum(len(v) for v in sk.bund.values() if len(v) > 1),
            'drawn_as': dict(sorted(collections.Counter(r.kind for r in sk.runs).items())), 'off_real_shape': sum(r.dev > FIT for r in sk.runs),
            'wrong_crossings': sum(x[0] for x in f) // 2, 'wrong_side_samples': sum(x[1] for x in f) // 2, 'overlaps': sum(x[2] for x in f) // 2}


# ============================================================ points off the mapping
class Transform:
    """Real (lon, lat) -> the plane, for points that are not section ends: by fraction along
    the drawing of the nearest section within SNAP_DEG; else shifted by the offset of the
    nearest drawn section end. `stat` counts the three cases."""
    def __init__(self, geo, sch):
        self.geo = geo; self.sch = sch; self.vimg = end_images(geo, sch); self.stat = collections.Counter()
        self.grid = collections.defaultdict(list)          # cell -> (s, i) segments of drawn sections
        self.cumg = [None] * len(geo); self.cums = [None] * len(geo)
        for s in range(len(geo)):
            if sch[s] is None: continue
            self.cumg[s], self.cums[s] = cumlen(geo[s]), cumlen(sch[s])
            for i in range(len(geo[s]) - 1):
                for c in sorted(cells(geo[s][i:i + 2], TRANSFORM_CELL)): self.grid[c].append((s, i))

    def __call__(self, p):
        """the plane point of the real point p"""
        p = tuple(p); geo = self.geo; G = TRANSFORM_CELL
        if p in self.vimg: self.stat['vertex'] += 1; return self.vimg[p]
        cx, cy = int(math.floor(p[0] / G)), int(math.floor(p[1] / G)); best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for s, i in self.grid.get((cx + dx, cy + dy), ()):
                    a, b = geo[s][i], geo[s][i + 1]; vx, vy = b[0] - a[0], b[1] - a[1]; l2 = vx * vx + vy * vy
                    t = 0 if l2 == 0 else max(0, min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2))
                    d = math.hypot(a[0] + t * vx - p[0], a[1] + t * vy - p[1])
                    if best is None or d < best[0]: best = (d, s, i, t)
        if best and best[0] <= SNAP_DEG:
            d, s, i, t = best; cg = self.cumg[s]; L = cg[-1]
            f = 0 if L == 0 else (cg[i] + t * (cg[i + 1] - cg[i])) / L
            self.stat['project'] += 1; return walk(self.sch[s], self.cums[s], f * self.cums[s][-1])
        gp = min(self.vimg, key=lambda v: (v[0] - p[0]) ** 2 + (v[1] - p[1]) ** 2); sp = self.vimg[gp]; q = PL(p); gq = PL(gp)
        self.stat['offset'] += 1; return (q[0] + sp[0] - gq[0], q[1] + sp[1] - gq[1])


def place_stations(pack, feats, side_files, node_move, pos, T):
    """Station points: an octi station node that is a node of the skeleton is drawn where
    that node is; every other station goes through T (onto the drawn line); a station
    without a point stays None. Returns (points, number placed on skeleton nodes)."""
    sides = {}
    for p in side_files:
        sd = json.load(open(p)); sides[sd['tile']] = sd['nodes']
    on_node = {}
    for f in feats:
        pr = f['properties']
        if f['geometry']['type'] != 'Point' or 'station_id' not in pr: continue
        st = sides.get(pr['tile'], {}).get(pr['station_id'][3:], {}).get('st')
        if st is not None:
            c = PL(f['geometry']['coordinates']); k = key(node_move.get(key(c), c))
            if k in pos: on_node.setdefault(int(st), pos[k])
    pts = [on_node[i] if i in on_node else T(t['pt']) if 'pt' in t else None for i, t in enumerate(pack['station_table'])]
    return pts, len(on_node)


def place_cities(pack, station_pt, T):
    """City points. A city sits on one of its stations: the station at the city's own point
    (the pack puts a city where its main station is), else the most central of its placed
    stations (medoid; a mean could land between lines when octi spreads a city's stations
    apart); a city without stations goes through T. Returns (points, counts)."""
    by_city = collections.defaultdict(list)
    for i, t in enumerate(pack['station_table']):
        if 'pt' in t and station_pt[i] is not None and t.get('city') is not None:
            by_city[t['city']].append((i, t['pt'], station_pt[i]))
    pts = []; stat = collections.Counter()
    for i, c in enumerate(pack['city_table']):
        sts = by_city.get(i)
        if not sts: pts.append(T(c['pt'])); stat['transform'] += 1; continue
        main = [sp for _, rp, sp in sts if abs(rp[0] - c['pt'][0]) < 1e-6 and abs(rp[1] - c['pt'][1]) < 1e-6]
        if main: pts.append(main[0]); stat['main_station'] += 1; continue
        pts.append(min((sp for _, _, sp in sts), key=lambda a: (sum(math.dist(a, b) for _, _, b in sts), a)))
        stat['medoid'] += 1
    return pts, stat


def draw_in_sections(pack, sch, T):
    """in_sections: one with the geometry of a section takes that section's drawing; any
    other goes through T vertex by vertex. Returns (polylines, counts)."""
    by_g = {}
    for s, x in enumerate(pack['sections']): by_g.setdefault(x['g'], s)
    out = []; stat = collections.Counter()
    for x in pack['in_sections']:
        s = by_g.get(x['g'])
        if s is not None: out.append(sch[s]); stat['same'] += 1
        else:
            q = dedup([T(p) for p in dec(x['g'])]) or [T(dec(x['g'])[0])]
            if len(q) < 2: q = [q[0], q[0]]
            out.append(dp(q, SIMPLIFY_DEG)); stat['T'] += 1
    return out, stat


def draw_throats(encoded, T):
    """throats: <= 2 octilinear legs from the image of one end to the image of the other"""
    out = []
    for g in encoded:
        q = dec(g); out.append(octi2pl(T(q[0]), T(q[-1])))
    return out


def write_asset(path, pack, nat, sch, in_sch, throats, extra, station_pt, city_pt):
    """Write the asset (see the module docstring); returns the number of backdrop lines. The
    backdrop is the drawn sections themselves, so it never shows a line that trains are not
    drawn on."""
    network = [dedup(q) for q in sch if len(dedup(q)) >= 2]
    r6 = lambda p: [round(p[0], 6), round(p[1], 6)]
    out = {
        'fmt': pack['fmt'], 'build': pack['build'], 'layout': 'octi-stitched', 'plane': 'lon-mercdeg',
        'n_sec': len(sch), 'n_in': len(pack['in_sections']), 'n_thr': len(pack['throats']), 'n_extra': len(nat['extra']),
        'n_station': len(pack['station_table']), 'n_city': len(pack['city_table']),
        'sections': [enc(q) for q in sch], 'in_sections': [enc(q) for q in in_sch],
        'network': [enc(q) for q in network], 'throats': [enc(q) for q in throats], 'extra': [enc(q) for q in extra],
        'station_pt': [r6(p) if p else None for p in station_pt], 'city_pt': [r6(p) for p in city_pt],
    }
    json.dump(out, open(path, 'w'), separators=(',', ':'))
    return len(network)


# ============================================================ the pipeline
def main(argv):
    """Run the stages in order (see the module docstring); the layout state is the drawing
    `sch`, the `Skeleton` built on it and the `Router`; counts go to stderr."""
    pack_path, nat_path, graph_path, map_path, out_path = argv[:5]; side_files = argv[5:]
    pack = json.load(open(pack_path)); nat = json.load(open(nat_path))
    feats = json.load(open(graph_path))['features']; mp = json.load(open(map_path))
    assert nat['n_sec'] == len(pack['sections']) and nat['n_thr'] == len(pack['throats']), 'national trains do not match the pack'
    geo = [dec(s['g']) for s in pack['sections']]          # the real track, (lon, lat)
    geoP = [[PL(p) for p in g] for g in geo]               # and on the plane

    sch, sections = octi_drawing(feats, mp, geo)
    node_move, layout = join_stations(pack, nat, feats, geo, sch)          # rule 1
    sk = Skeleton(sch, geoP); router = Router(sk)
    moved_km = place_junctions(sk, router)                                 # rule 2
    layout.update(place_free_ends(sk, router))                             # rule 3
    layout.update(route_runs(sk, router))                                  # rule 4
    ride_with_nodes(sk)
    layout.update(layout_stats(sk, router, moved_km))

    T = Transform(geo, sch)
    for s in range(len(sch)):
        if sch[s] is None: p = T(geo[s][0]); sch[s] = [p, p]; sections['unmapped->T'] += 1
    station_pt, on_nodes = place_stations(pack, feats, side_files, node_move, sk.pos, T)
    city_pt, cities_on = place_cities(pack, station_pt, T)
    in_sch, in_sections = draw_in_sections(pack, sch, T)
    throats = draw_throats(pack['throats'], T); extra = draw_throats(nat['extra'], T)
    network = write_asset(out_path, pack, nat, sch, in_sch, throats, extra, station_pt, city_pt)
    print(json.dumps({'cities_on': cities_on, 'layout': layout, 'sections': sections, 'in_sections': in_sections, 'T': T.stat,
                      'stations_octi': on_nodes, 'stations': len(station_pt), 'cities': len(city_pt), 'network': network}), file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1:])
