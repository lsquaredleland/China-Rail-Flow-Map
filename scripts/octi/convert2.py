# usage: python3 -I convert2.py shared.json out.json side.json [--bbox minlon minlat maxlon maxlat]
#        [--lines first|all] [--tags] [--fix-loops] [--split-parallel KM] [--fix-degenerate]
#
# Variant of scripts/convert.py that keeps track of where every pack section goes.
#   default flags reproduce scripts/convert.py's edges exactly (same nodes, lines, coords).
#   --tags            pre-contract degree-2 non-station nodes exactly where octi's
#                     contractStrayNds would (same line set on both sides, no multigraph),
#                     and give every resulting "chain" edge one extra line '#c<k>' (the tag).
#                     octi unions line sets on every merge/split, so the tag survives into
#                     the output and names the chain each output edge belongs to.
#   --loops-as-node   (recommended) sections whose two ends hit the same node are left out of the
#                     octi input and mapped to that node's image (a split loop is drawn as a ring
#                     around a whole grid cell: nationally 29 km of loops became 2,790 km of rings).
#   --fix-loops       sections whose two ends hit the same node are split into 3 pieces
#                     (octi drops self-edges; a 2-piece split would be merged as parallel).
#   --split-parallel  edges between the same node pair whose geometries differ by more than
#                     KM km (Hausdorff) get a midpoint node so octi does not merge them.
#                     Near-identical ones (double track) are left to merge.
#   --fix-degenerate  sections with one distinct point become a node-only entry (mapped to a
#                     node later) instead of disappearing silently.
# side.json records: universe of section ids, per-section status, pieces, chains, nodes.
import json, sys, hashlib, math, collections, argparse

ap = argparse.ArgumentParser()
ap.add_argument('pack'); ap.add_argument('out'); ap.add_argument('side')
ap.add_argument('--bbox', nargs=4, type=float)
ap.add_argument('--partition', help='tiles json from partition.py (with --tile)')
ap.add_argument('--tile', help='tile name: keep the runs of every section that lie in this tile, '
                'cutting sections at tile edges; cut ends become deg-1 nodes labelled "cut"')
ap.add_argument('--lines', default='first', choices=['first', 'all'])
ap.add_argument('--tags', action='store_true')
ap.add_argument('--fix-loops', action='store_true')
ap.add_argument('--loops-as-node', action='store_true')
ap.add_argument('--split-parallel', type=float, default=None)
ap.add_argument('--fix-degenerate', action='store_true')
ap.add_argument('--join-paths', help='national-trains.json: section ends that trains run between (only '
                'throats in between) become one node, so the drawn line is continuous there')
ap.add_argument('--join-km', type=float, default=5.0, help='max real gap for --join-paths')
A = ap.parse_args()


def dec(s):
    pts = []; lat = lon = 0; i = 0; n = len(s)
    while i < n:
        for k in (0, 1):
            sh = res = 0
            while True:
                b = ord(s[i]) - 63; i += 1; res |= (b & 0x1f) << sh; sh += 5
                if b < 0x20: break
            v = ~(res >> 1) if res & 1 else res >> 1
            if k == 0: lat += v
            else: lon += v
        pts.append((lon / 1e4, lat / 1e4))
    return pts


def km(a, b):
    x = math.radians(b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2)); y = math.radians(b[1] - a[1])
    return 6371 * math.hypot(x, y)


def plen(q): return sum(km(q[i], q[i + 1]) for i in range(len(q) - 1))


def cut(q, f0, f1):
    """sub-polyline of q between length fractions f0<f1"""
    L = plen(q); a, b = f0 * L, f1 * L; out = []; acc = 0
    for i in range(len(q) - 1):
        s = km(q[i], q[i + 1]); lo, hi = acc, acc + s
        def at(t):
            r = 0 if s == 0 else (t - lo) / s
            return (q[i][0] + (q[i + 1][0] - q[i][0]) * r, q[i][1] + (q[i + 1][1] - q[i][1]) * r)
        if hi >= a and lo <= b:
            if not out: out.append(at(max(a, lo)))
            if hi <= b: out.append(q[i + 1])
            else: out.append(at(b)); break
        acc = hi
    return out


d = json.load(open(A.pack))
bb = A.bbox
inb = lambda p: bb is None or (bb[0] <= p[0] <= bb[2] and bb[1] <= p[1] <= bb[3])
lines = d['lines']
col = lambda i: hashlib.md5(str(i).encode()).hexdigest()[:6]

status = {}   # si -> 'ok' | 'degenerate' | 'loop' | 'parallel-split' ...
universe = []
secs = []; degen = []   # (si, s, q, f0, f1, cut_start, cut_end)
TILES = json.load(open(A.partition)) if A.partition else None
def tile_of(p):
    for t in TILES:
        b = t['bbox']
        if b[0] <= p[0] < b[2] and b[1] <= p[1] < b[3]: return t['name']
    return None
def runs_of(q):
    """cut q at every tile edge; -> [(f0, f1, coords, tile)] with km fractions along q"""
    xs = sorted({t['bbox'][0] for t in TILES} | {t['bbox'][2] for t in TILES})
    ys = sorted({t['bbox'][1] for t in TILES} | {t['bbox'][3] for t in TILES})
    L = plen(q) or 1; pts = [(q[0], 0.0, False)]; acc = 0
    for i in range(len(q) - 1):
        a, b = q[i], q[i + 1]; sl = km(a, b); ts = []
        if True:
            for x in xs:
                if (a[0] - x) * (b[0] - x) < 0: ts.append((x - a[0]) / (b[0] - a[0]))
            for y in ys:
                if (a[1] - y) * (b[1] - y) < 0: ts.append((y - a[1]) / (b[1] - a[1]))
        for t in sorted(ts):
            c = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            pts.append((c, (acc + sl * t) / L, True))
        acc += sl; pts.append((b, acc / L, False))
    runs = []; cur = [pts[0]]
    for p in pts[1:]:
        cur.append(p)
        if p[2]: runs.append(cur); cur = [p]
    runs.append(cur)
    out = []
    for r in runs:
        co = [x[0] for x in r]
        if plen(co) == 0: continue
        mid = cut(co, 0, 0.5)[-1]
        out.append((r[0][1], r[-1][1], co, tile_of(mid), r[0][2], r[-1][2]))
    # merge consecutive runs that land in the same tile (cut lines that are not this tile's edge)
    m = []
    for r in out:
        if m and m[-1][3] == r[3]:
            p_ = m[-1]; m[-1] = (p_[0], r[1], p_[2] + r[2][1:], r[3], p_[4], r[5])
        else: m.append(r)
    return m
for si, s in enumerate(d['sections']):
    raw = dec(s['g'])
    q = []
    for p in raw:
        if not q or p != q[-1]: q.append(p)
    if TILES:
        if len(q) < 2:
            if tile_of(q[0]) == A.tile: universe.append(si); status[si] = 'degenerate'; degen.append((si, q[0]))
            continue
        rs = [r for r in runs_of(q) if r[3] == A.tile]
        if rs: universe.append(si)
        for f0, f1, co, _, ca, cb in rs:
            secs.append((si, s, co, f0, f1, ca, cb))
        continue
    if not (inb(raw[0]) and inb(raw[-1])): continue
    universe.append(si)
    if len(q) >= 2: secs.append((si, s, q, 0.0, 1.0, False, False))
    else: status[si] = 'degenerate'; degen.append((si, q[0]))
deg = collections.Counter()
if TILES:   # station snapping must agree across tiles: degree over the whole pack
    for s in d['sections']:
        q = dec(s['g'])
        if len(set(q)) >= 2: deg[q[0]] += 1; deg[q[-1]] += 1
else:
    for si, s, q, *_ in secs: deg[q[0]] += 1; deg[q[-1]] += 1

sts = [(i, t) for i, t in enumerate(d['station_table']) if 'pt' in t]
grid = {}
for i, t in sts: grid.setdefault((int(t['pt'][0] * 20), int(t['pt'][1] * 20)), []).append((i, t))


def near(p):
    best = None
    for gx in (-1, 0, 1):
        for gy in (-1, 0, 1):
            for i, t in grid.get((int(p[0] * 20) + gx, int(p[1] * 20) + gy), []):
                dd = math.hypot(t['pt'][0] - p[0], t['pt'][1] - p[1])
                if dd <= 0.03 and (best is None or dd < best[0]): best = (dd, i, t)
    return best


nodes = {}
def nid(key, pt, lab=None, st=None):
    if key not in nodes: nodes[key] = ('n%d' % len(nodes), pt, lab, st)
    return nodes[key][0]


# pieces: edges before contraction. (a, b, coords, lineset, [(si, f0, f1)])  f along section, a->b
pieces = []; secnodes = {}; loopnode = {}; cuts = []; cutkey = {}

# --join-paths: union section end points that a train path goes between with only throats in
# between (e.g. two lines meeting at a station through its throats, or ends snapped to two
# neighbouring stations). Each group becomes one node: its station if a member snaps to one
# (most members, then lowest index), else the member point with the highest degree.
joingrp = {}
if A.join_paths:
    nt = json.load(open(A.join_paths)); NS = nt['n_sec']
    assert NS == len(d['sections']), 'national trains do not match the pack'
    G_ = {}
    def ge(si):
        if si not in G_: G_[si] = dec(d['sections'][si]['g'])
        return G_[si]
    cand = set()
    for path in nt['paths']:
        prev = None
        for x in path:
            if abs(x) >= NS: continue          # throat / extra
            if prev is not None and abs(prev) != abs(x):
                qa, qb = ge(abs(prev)), ge(abs(x))
                # the closest pair of ends (the path's signs do not reliably give the ends)
                g_, pa, pb = min((km(u, v), u, v) for u in (qa[0], qa[-1]) for v in (qb[0], qb[-1]))
                if pa != pb and g_ <= A.join_km: cand.add((g_, min(pa, pb), max(pa, pb)))
            prev = x
    # sections touching each end point; a join must not turn a real section (> 1 km) into a loop
    secs_at = collections.defaultdict(set)
    for si_, s_ in enumerate(d['sections']):
        q_ = dec(s_['g'])
        if len(set(q_)) >= 2 and plen(q_) > 1.0: secs_at[q_[0]].add(si_); secs_at[q_[-1]].add(si_)
    par = {}; gsec = {}; gbox = {}
    def find(x):
        if x not in par: par[x] = x; gsec[x] = set(secs_at.get(x, ())); gbox[x] = (x[0], x[1], x[0], x[1])
        while par[x] != x: par[x] = par[par[x]]; x = par[x]
        return x
    skipped = 0
    for g_, pa, pb in sorted(cand):   # closest pairs first; deterministic
        ra, rb = find(pa), find(pb)
        if ra == rb: continue
        A_, B_ = gbox[ra], gbox[rb]; bx = (min(A_[0], B_[0]), min(A_[1], B_[1]), max(A_[2], B_[2]), max(A_[3], B_[3]))
        # never loop a real section (> 1 km), never grow a group wider than --join-km
        if gsec[ra] & gsec[rb] or km(bx[:2], bx[2:]) > A.join_km: skipped += 1; continue
        par[ra] = rb; gsec[rb] |= gsec.pop(ra); gbox[rb] = bx
    members = collections.defaultdict(list)
    for x in list(par): members[find(x)].append(x)
    for r, ms in members.items():
        if len(ms) < 2: continue
        stc = collections.Counter()
        for m in ms:
            nb = near(m) if deg[m] == 1 else None
            if nb: stc[nb[1]] += 1
        if stc:
            i = min(stc, key=lambda k: (-stc[k], k)); t = d['station_table'][i]
            info = (('st', i), tuple(t['pt']), t['en'] or t['zh'], i)
        else:
            rep = min(ms, key=lambda m: (-deg[m], m)); info = (('pt', rep), rep, None, None)
        for m in ms: joingrp[m] = info
    print('join-paths: candidate pairs', len(cand), 'skipped (loop or too wide)', skipped, file=sys.stderr)
def end_info(si, p, iscut, f, groups=True):
    if iscut:   # parallel tracks crossing a tile edge together share one cut node (0.02 deg bins)
        ck = 'c%d_%d' % (round(p[0] / 0.02), round(p[1] / 0.02))
        cutkey['%d@%.9f' % (si, f)] = ck
        return (('cut', ck), p, 'cut', None)
    if groups and p in joingrp: return joingrp[p]
    nb = near(p) if deg[p] == 1 else None
    if nb:
        _, i, t = nb; return (('st', i), tuple(t['pt']), t['en'] or t['zh'], i)
    return (('pt', p), p, None, None)


for si, s, q, F0, F1, CA, CB in secs:
    ends = [end_info(si, q[0], CA, F0), end_info(si, q[-1], CB, F1)]
    if ends[0][0] == ends[1][0] and plen(q) > 1.0:
        # two join groups claimed the same station: keep a real section a line, not a loop
        ends = [end_info(si, q[0], CA, F0, False), end_info(si, q[-1], CB, F1, False)]
    coords = list(q)
    if tuple(ends[0][1]) != tuple(coords[0]): coords.insert(0, ends[0][1])
    if tuple(ends[1][1]) != tuple(coords[-1]): coords.append(ends[1][1])
    a = nid(*ends[0]); b = nid(*ends[1])
    if (F0, F1) == (0.0, 1.0): secnodes[si] = [a, b]
    ls = s.get('l') or []
    ls = tuple(ls[:1] if A.lines == 'first' else ls) or ('none',)
    if a == b:
        if A.loops_as_node:
            status[si] = 'loop-node'; loopnode[si] = a; continue
        if not A.fix_loops or plen(coords) == 0:
            status[si] = 'loop'; continue
        status[si] = 'loop-split'
        m1 = nid(('loop', si, 1), cut(coords, 0, 1 / 3)[-1]); m2 = nid(('loop', si, 2), cut(coords, 0, 2 / 3)[-1])
        for (x, y, f0, f1) in ((a, m1, 0, 1 / 3), (m1, m2, 1 / 3, 2 / 3), (m2, b, 2 / 3, 1)):
            g0, g1 = F0 + (F1 - F0) * f0, F0 + (F1 - F0) * f1
            pieces.append([x, y, cut(coords, f0, f1), ls, [(si, g0, g1)]])
        continue
    status[si] = 'ok' if (F0, F1) == (0.0, 1.0) else 'cut'
    pieces.append([a, b, coords, ls, [(si, F0, F1)]])
    if CA or CB:
        cuts.append({'si': si, 'f0': F0, 'f1': F1, 'a': a, 'b': b, 'cut_a': CA, 'cut_b': CB})

ndinfo = {v[0]: {'pt': list(v[1]), 'label': v[2], 'st': v[3]} for v in nodes.values()}


def hausdorff_km(p, q):
    def samp(x):
        L = plen(x); n = max(2, min(40, int(L / 0.5) + 2))
        return [cut(x, 0, i / (n - 1))[-1] if i else x[0] for i in range(n)]
    sp, sq = samp(p), samp(q)
    def one(u, v):
        return max(min(km(a, b) for b in v) for a in u)
    return max(one(sp, sq), one(sq, sp))


# split geometrically distinct parallels
if A.split_parallel is not None:
    grp = collections.defaultdict(list)
    for k, pc in enumerate(pieces): grp[frozenset((pc[0], pc[1]))].append(k)
    newp = []
    for g, ks in grp.items():
        if len(ks) < 2: continue
        keep = [ks[0]]
        for k in ks[1:]:
            pc = pieces[k]
            ref = pieces[keep[0]]
            rc = ref[2] if ref[0] == pc[0] else ref[2][::-1]
            if hausdorff_km(pc[2], rc) > A.split_parallel:
                m = nid(('par', k), cut(pc[2], 0, 0.5)[-1]); ndinfo[m] = {'pt': list(nodes[('par', k)][1]), 'label': None, 'st': None}
                (si, f0, f1), = pc[4]
                fm = (f0 + f1) / 2
                newp.append([pc[0], m, cut(pc[2], 0, 0.5), pc[3], [(si, f0, fm)]])
                newp.append([m, pc[1], cut(pc[2], 0.5, 1), pc[3], [(si, fm, f1)]])
                pc[4] = None
                status[si] = 'parallel-split'
            else:
                keep.append(k)
    pieces = [p for p in pieces if p[4] is not None] + newp
for k in nodes:  # loop/par nodes
    v = nodes[k]
    if v[0] not in ndinfo: ndinfo[v[0]] = {'pt': list(v[1]), 'label': v[2], 'st': v[3]}

# chains: optionally pre-contract like octi's contractStrayNds
# chain = [a, b, coords, lineset, [(si, f0, f1)...] in a->b order]
# octi's grid size "-g X%" is X% of avgStatDist over ITS input graph; pre-contraction changes
# that graph, so record the value octi would compute on the uncontracted one (webmerc metres,
# straight node-to-node, parallel edges merged as octi does on read). Pass -g <abs> to octi.
def wm(p):
    return (p[0] * 20037508.34 / 180, math.log(math.tan((90 + p[1]) * math.pi / 360)) * 20037508.34 / math.pi)
_nb = collections.defaultdict(set)
for p in pieces: _nb[p[0]].add(p[1]); _nb[p[1]].add(p[0])
_tot = 0
for n, ns in _nb.items():
    a = wm(ndinfo[n]['pt']); _tot += sum(math.dist(a, wm(ndinfo[m]['pt'])) for m in sorted(ns)) / len(ns)
AVGDIST = _tot / max(1, len(_nb))

# chain = [a, b, coords, lineset, groups]; groups ordered a->b, each group a list of
# parallel members (si, f0, f1) occupying the same stretch (octi merges same-endpoint edges
# on read and unions their lines, so they are one edge to it).
chains = [[p[0], p[1], p[2], p[3], [p[4]]] for p in pieces]
if A.tags:
    bund = collections.OrderedDict()
    for c in chains:
        key = frozenset((c[0], c[1]))
        if key not in bund: bund[key] = c; continue
        b = bund[key]
        (m,), = c[4]
        si, f0, f1 = m
        if c[0] != b[0]: f0, f1 = f1, f0
        b[4][0].append((si, f0, f1))
        b[3] = tuple(list(b[3]) + [l for l in c[3] if l not in b[3]])
    chains = list(bund.values())
    loopset = set(loopnode.values())
    alive = set(range(len(chains)))
    adj = collections.defaultdict(set)
    for k, c in enumerate(chains): adj[c[0]].add(k); adj[c[1]].add(k)
    changed = True
    while changed:
        changed = False
        for n in list(adj):
            if ndinfo[n]['label'] or n in loopset: continue   # keep stations and loop anchors as nodes
            ks = adj[n]
            if len(ks) != 2: continue
            k1, k2 = sorted(ks)
            c1, c2 = chains[k1], chains[k2]
            if set(c1[3]) != set(c2[3]): continue
            x = c1[0] if c1[1] == n else c1[1]; y = c2[0] if c2[1] == n else c2[1]
            if x == y: continue
            if any(frozenset((x, y)) == frozenset((chains[k][0], chains[k][1])) for k in adj[x]): continue
            def orient(c, start):   # c as start->other
                if c[0] == start: return c[2], c[4]
                return c[2][::-1], [[(si, f1, f0) for (si, f0, f1) in g] for g in reversed(c[4])]
            g1, m1 = orient(c1, x); g2, m2 = orient(c2, n)
            chains.append([x, y, g1 + g2[1:], c1[3], m1 + m2]); kn = len(chains) - 1
            for k in (k1, k2):
                alive.discard(k); adj[chains[k][0]].discard(k); adj[chains[k][1]].discard(k)
            alive.add(kn); adj[x].add(kn); adj[y].add(kn)
            del adj[n]
            changed = True
    chains = [chains[k] for k in sorted(alive)]

feats = []; side_chains = []
for k, (a, b, coords, ls, mem) in enumerate(chains):
    L = [{'id': 'L%d' % i, 'label': (lines[i][1] or lines[i][0]), 'color': col(i)} if i != 'none'
         else {'id': 'Lnone', 'label': 'unnamed', 'color': '888888'} for i in ls]
    tag = '#c%d' % k
    if A.tags: L.append({'id': tag, 'label': tag, 'color': '888888'})
    pr = {'id': tag, 'from': a, 'to': b, 'lines': L}
    if not A.tags: pr['sec'] = mem[0][0][0]
    feats.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [list(c) for c in coords]},
                  'properties': pr})
    side_chains.append({'tag': tag, 'from': a, 'to': b, 'km': plen(coords),
                        'mem': [[[si, f0, f1] for (si, f0, f1) in g] for g in mem], 'lines': list(map(str, ls))})
nst = 0
used = {c[0] for c in chains} | {c[1] for c in chains}   # a loop-only node would be an edgeless component octi cannot embed
for n, info in ndinfo.items():
    if n not in used: continue
    pr = {'id': n}
    if info['label']: pr['station_id'] = 'st_' + n; pr['station_label'] = info['label']; nst += 1
    feats.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': list(info['pt'])}, 'properties': pr})
json.dump({'type': 'FeatureCollection', 'features': feats}, open(A.out, 'w'))

# section km (geographic) for weighting
seckm = {}
for si in universe:
    raw = dec(d['sections'][si]['g']); seckm[si] = plen(raw)
json.dump({'universe': universe, 'status': {str(k): v for k, v in status.items()}, 'km': {str(k): v for k, v in seckm.items()},
           'chains': side_chains, 'nodes': {n: v for n, v in ndinfo.items() if n in used},
           'degenerate': [[si, list(p)] for si, p in degen], 'flags': vars(A), 'avgdist': AVGDIST, 'secnodes': {str(k): v for k, v in secnodes.items()}, 'loopnode': {str(k): v for k, v in loopnode.items()}, 'looppt': {str(k): ndinfo[v]['pt'] for k, v in loopnode.items()}, 'runs': cuts, 'tile': A.tile,
           'cutnodes': {k[1]: v[0] for k, v in nodes.items() if k[0] == 'cut'}, 'cutkey': cutkey}, open(A.side, 'w'))
c = collections.Counter(status.values())
print('joined groups', len({v[0] for v in joingrp.values()}), 'ends', len(joingrp), 'avgdist %.1f' % AVGDIST, 'universe', len(universe), 'edges', len(chains), 'nodes', len(used), 'stations', nst, dict(c), file=sys.stderr)
