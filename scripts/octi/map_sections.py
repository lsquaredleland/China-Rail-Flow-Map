# usage: python3 -I map_sections.py octi_out.json side.json shared.json mapping.json [--bbox minlon minlat maxlon maxlat]
#
# Maps every pack section onto an octi layout produced from convert2.py --tags input.
# Output mapping.json:
#   edges:    [ [feature_index_in_octi_out, octi_edge_id], ... ]      (polyline ids used below)
#   nodes:    [ [feature_index_in_octi_out, octi_node_id], ... ]
#   sections: { "<si>": {"st": status, "p": [[edge, f0, f1, dir], ...]} | {"st": "node", "n": node} }
#     p is in section order (pack polyline start -> end); f0/f1 are fractions along the octi
#     polyline's own coordinate order (f0 -> f1 is the travel direction, dir = +1 if f1>f0).
#   status: mapped | node (collapsed to a point) | lost-convert:<why> | lost-octi
# Also prints coverage stats (count and km) and validation results.
import json, sys, math, collections, argparse

ap = argparse.ArgumentParser()
ap.add_argument('out'); ap.add_argument('side'); ap.add_argument('pack'); ap.add_argument('mapping')
ap.add_argument('--bbox', nargs=4, type=float)
ap.add_argument('--quiet', action='store_true')
A = ap.parse_args()

M = lambda p: (p[0], math.degrees(math.log(math.tan(math.pi / 4 + math.radians(p[1]) / 2))))  # mercator (deg units)
def mlen(q):
    return sum(math.dist(M(q[i]), M(q[i + 1])) for i in range(len(q) - 1))

side = json.load(open(A.side))
feats = json.load(open(A.out))['features']
ond = {}; nd_index = []; oed = []
for fi, f in enumerate(feats):
    p = f['properties']
    if f['geometry']['type'] == 'Point':
        ond[p['id']] = {'fi': fi, 'pt': f['geometry']['coordinates'], 'st': p.get('station_id'), 'k': len(nd_index)}
        nd_index.append([fi, p['id']])
for fi, f in enumerate(feats):
    p = f['properties']
    if f['geometry']['type'] == 'LineString':
        c = f['geometry']['coordinates']
        tags = {l['id'] for l in p.get('lines', []) if l['id'].startswith('#')}
        oed.append({'fi': fi, 'id': p['id'], 'a': p['from'], 'b': p['to'], 'c': c, 'L': mlen(c), 'tags': tags})

bytag = collections.defaultdict(list)
for k, e in enumerate(oed):
    for t in e['tags']: bytag[t].append(k)

chains = side['chains']; nodes = side['nodes']
# --- order each chain's output edges into a path
badtags = {}   # chains whose tagged edges are not one simple path (octi line bookkeeping quirks)
paths = {}   # tag -> (list of (edge k, forward bool), start out node, end out node)
bad = collections.Counter()
for ch in chains:
    ks = bytag.get(ch['tag'], [])
    if not ks: continue
    def mkadj(ks):
        adj = collections.defaultdict(list)
        for k in ks: adj[oed[k]['a']].append(k); adj[oed[k]['b']].append(k)
        return adj, [n for n, v in adj.items() if len(v) == 1]
    adj, ends = mkadj(ks)
    if len(ends) != 2 or any(len(v) > 2 for v in adj.values()):
        # zero-length stubs (two octi nodes on one grid point) can branch a path: drop them
        ks2 = [k for k in ks if oed[k]['L'] > 0]
        if ks2:
            a2, e2 = mkadj(ks2)
            if len(e2) == 2 and all(len(v) <= 2 for v in a2.values()):
                ks, adj, ends = ks2, a2, e2; bad['zero-stub-dropped'] += 1
    if len(ends) != 2 or any(len(v) > 2 for v in adj.values()):
        bad['nonpath'] += 1; badtags[ch['tag']] = set(ks); continue   # resolved after node images
    start = ends[0] if ends else next(iter(adj))
    seq = []; used = set(); cur = start
    while True:
        nxt = [k for k in adj[cur] if k not in used]
        if not nxt: break
        k = nxt[0]; used.add(k)
        fwd = oed[k]['a'] == cur
        seq.append((k, fwd)); cur = oed[k]['b'] if fwd else oed[k]['a']
    if len(used) != len(ks): bad['disconnected'] += 1; badtags[ch['tag']] = set(ks); continue
    paths[ch['tag']] = [seq, start, cur]

# --- input node -> output node
img = {}
stmap = {}
for oid, o in ond.items():
    if o['st']: stmap[o['st'][3:]] = oid          # 'st_n12' -> 'n12'
for n in nodes:
    if n in stmap: img[n] = stmap[n]
inc = collections.defaultdict(list)
for ch in chains:
    inc[ch['from']].append(ch); inc[ch['to']].append(ch)
def geo_d(a, b): return math.dist(M(a), M(b))


# resolve each remaining input node by voting: every drawn incident chain votes for its two
# output end nodes (minus the one already taken by its other, resolved, end). Collapsed chains
# (no output edges) let a resolved end hand its image to the other end.
def votes(m):
    v = collections.Counter()
    for ch in inc[m]:
        if ch['tag'] not in paths: continue
        _, s_, e_ = paths[ch['tag']]
        ends = {s_, e_}
        other = ch['to'] if ch['from'] == m else ch['from']
        if other in img and img[other] in ends and len(ends) == 2: ends = ends - {img[other]}
        for x in ends: v[x] += 1
    return v


for it in range(50):
    progress = False
    for m in nodes:
        if m in img: continue
        v = votes(m)
        if not v: continue
        top = v.most_common(2)
        if len(top) == 1 or top[0][1] > top[1][1]:
            img[m] = top[0][0]; progress = True
    for ch in chains:
        if ch['tag'] in paths: continue
        a_, b_ = ch['from'], ch['to']
        if (a_ in img) != (b_ in img):
            if a_ in img: img[b_] = img[a_]
            else: img[a_] = img[b_]
            progress = True
    if not progress:
        # geometric tie-break for one still-ambiguous node, then continue
        amb = [m for m in nodes if m not in img and votes(m)]
        if not amb: break
        m = amb[0]; v = votes(m); best = max(v.values())
        cand = [x for x, c in v.items() if c == best]
        img[m] = min(cand, key=lambda x: geo_d(ond[x]['pt'], nodes[m]['pt'])); bad['geo-tiebreak'] += 1

# --- recover chains octi dropped although both ends landed on different output nodes
# (seen when contraction turns two chains into parallels and only one keeps its tag):
# route them along the shortest output path between their end images.
import heapq
oadj = collections.defaultdict(list)
for k, e in enumerate(oed): oadj[e['a']].append(k); oadj[e['b']].append(k)
def spath(u, v, allowed=None):
    dist = {u: 0}; prev = {}; pq = [(0, u)]
    while pq:
        d_, x = heapq.heappop(pq)
        if x == v: break
        if d_ > dist[x]: continue
        for k in oadj[x]:
            if allowed is not None and k not in allowed: continue
            y = oed[k]['b'] if oed[k]['a'] == x else oed[k]['a']
            nd_ = d_ + oed[k]['L']
            if nd_ < dist.get(y, 1e18): dist[y] = nd_; prev[y] = (x, k); heapq.heappush(pq, (nd_, y))
    if v not in dist: return None
    seq = []; x = v
    while x != u:
        px, k = prev[x]; seq.append((k, oed[k]['a'] == px)); x = px
    return seq[::-1]
recovered = set()
for ch in chains:
    if ch['tag'] in paths: continue
    u, v = img.get(ch['from']), img.get(ch['to'])
    if u and v and u != v:
        sq = spath(u, v, badtags.get(ch['tag'])) if ch['tag'] in badtags else None   # prefer its own tagged edges
        if sq: paths[ch['tag']] = [sq, u, v]; bad['nonpath-repaired'] += 1; continue
        sq = spath(u, v)
        if sq: paths[ch['tag']] = [sq, u, v]; recovered.add(ch['tag'])

# --- orient paths and place members
secpieces = collections.defaultdict(list)   # si -> [(sec f0, f1, [pieces])]
orient_bad = 0
extended = set()
runinfo = collections.defaultdict(list)   # si -> [(f_lo, f_hi, pieces, node)] for tiled (cut) sections
for ch in chains:
    t = ch['tag']
    if t not in paths: continue
    seq, s, e = paths[t]
    ia, ib = img.get(ch['from']), img.get(ch['to'])
    if ia == e and ib == s or (ia != s and ib == s) or (ia == e and ib != e):
        seq = [(k, not f) for k, f in reversed(seq)]; s, e = e, s
    elif not (ia == s or ib == e):
        orient_bad += 1   # neither end anchored: keep as found, check geometrically
        pa = nodes[ch['from']]['pt']
        if geo_d(ond[e]['pt'], pa) < geo_d(ond[s]['pt'], pa):
            seq = [(k, not f) for k, f in reversed(seq)]; s, e = e, s
    # end completion: octi can drop a tag on a short stub next to a node (topologizeIsects
    # re-uses an existing parallel edge without merging lines), so the tagged path may stop
    # one node short of its anchored end. Extend along the shortest output path.
    if ia and ia != s and t not in recovered:
        sq = spath(ia, s)
        if sq: seq = sq + seq; s = ia; extended.add(t)
    if ib and ib != e and t not in recovered:
        sq = spath(e, ib)
        if sq: seq = seq + sq; e = ib; extended.add(t)
    tot = sum(oed[k]['L'] for k, f in seq) or 1
    # group weights: geographic km of each stretch (max over its parallel members)
    mk = [max(side['km'][str(si)] * abs(f1 - f0) for si, f0, f1 in g) for g in ch['mem']]
    W = sum(mk) or 1
    acc = 0
    for g, w in zip(ch['mem'], mk):
        lo, hi = acc / W, (acc + w) / W; acc += w
        out = []; pos = 0
        for k, fwd in seq:
            el = oed[k]['L'] / tot; a, b = pos, pos + el; pos = b
            x0, x1 = max(lo, a), min(hi, b)
            if x1 <= x0 + 1e-12 and not (el == 0 and lo <= a <= hi): continue
            u0 = (x0 - a) / el if el else 0; u1 = (x1 - a) / el if el else 1
            if not fwd: u0, u1 = 1 - u0, 1 - u1
            out.append([k, u0, u1])
        for si, f0, f1 in g:
            o2 = out if f1 >= f0 else [[k, u1, u0] for k, u0, u1 in reversed(out)]   # member runs against its section
            secpieces[si].append((min(f0, f1), o2, len(g) > 1, len(ch['mem']) > 1, t in recovered, t in extended))
            runinfo[si].append((min(f0, f1), max(f0, f1), o2, None))

# --- assemble
# degenerate sections (one distinct point): attach to the nearest resolved input node within ~2 km
degen_node = {}
for si_, p_ in side.get('degenerate', []):
    best = None
    for n_, info in nodes.items():
        if n_ not in img: continue
        dd = math.hypot((info['pt'][0] - p_[0]) * math.cos(math.radians(p_[1])), info['pt'][1] - p_[1]) * 111
        if dd < 2 and (best is None or dd < best[0]): best = (dd, n_)
    if best: degen_node[str(si_)] = img[best[1]]
res = {}; kmtot = collections.Counter(); cnt = collections.Counter()
universe = side['universe']; status = side['status']
memchains = collections.defaultdict(list)
for ch in chains:
    for g in ch['mem']:
        for si, f0, f1 in g: memchains[si].append(ch)
for si in universe:
    s = status.get(str(si))
    if s == 'degenerate' and str(si) in degen_node:
        r = {'st': 'node', 'n': ond[degen_node[str(si)]]['k'], 'degenerate': True}
    elif s in ('degenerate', 'loop'):
        r = {'st': 'lost-convert:' + s}
    elif s == 'loop-node':
        o = img.get(side['loopnode'][str(si)])
        if not o and str(si) in side.get('looppt', {}):
            # its node carries nothing but loops (dropped from the octi input): nearest placed node
            lp = side['looppt'][str(si)]; best = None
            for n_, info in nodes.items():
                if n_ not in img: continue
                dd = math.hypot((info['pt'][0] - lp[0]) * math.cos(math.radians(lp[1])), info['pt'][1] - lp[1]) * 111
                if dd < 5 and (best is None or dd < best[0]): best = (dd, n_)
            if best: o = img[best[1]]
        r = {'st': 'node', 'n': ond[o]['k'], 'loop': True} if o else {'st': 'lost-octi'}
    elif si in secpieces and any(x[1] for x in secpieces[si]):
        ps = []
        for x in sorted(secpieces[si], key=lambda x: x[0]): ps += x[1]
        par_ = any(x[2] for x in secpieces[si]); ctr = any(x[3] for x in secpieces[si])
        rec_ = any(x[4] for x in secpieces[si]); ext_ = any(x[5] for x in secpieces[si])
        r = {'st': 'mapped', 'par': par_, 'chain': ctr, 'rec': rec_, 'ext': ext_, 'p': [[k, round(u0, 6), round(u1, 6), 1 if u1 >= u0 else -1] for k, u0, u1 in ps]}
    else:
        chs = memchains.get(si, [])
        o = (img.get(chs[0]['from']) or img.get(chs[0]['to'])) if chs else None

        r = {'st': 'node', 'n': ond[o]['k']} if o else {'st': 'lost-octi'}
    if s == 'cut':   # per-run detail so a stitcher can join runs across tiles in section order
        rr = list(runinfo.get(si, []))
        have = {round(x[0], 9) for x in rr}
        for ch in memchains.get(si, []):
            if ch['tag'] in paths: continue
            for g in ch['mem']:
                for s2, f0, f1 in g:
                    if s2 == si and round(min(f0, f1), 9) not in have:
                        o = img.get(ch['from']) or img.get(ch['to'])
                        rr.append((min(f0, f1), max(f0, f1), [], ond[o]['k'] if o else None))
        r['runs'] = [[round(a, 9), round(b, 9), [[k, round(u0, 6), round(u1, 6)] for k, u0, u1 in pc], nd]
                     for a, b, pc, nd in sorted(rr)]
    res[str(si)] = r
    cat = r['st']
    if cat == 'mapped':
        cat = 'mapped/' + ('recovered' if r['rec'] else ('parallel' if r['par'] else 'own') + ('+deg2chain' if r['chain'] else ''))
    cnt[cat] += 1; kmtot[cat] += side['km'][str(si)]

# --- validation
# 1. contiguity: consecutive pieces of a section must join (same point), first/last at end images
def ptat(k, u):
    c = oed[k]['c']; L = oed[k]['L']; t = u * L; acc = 0
    for i in range(len(c) - 1):
        s = math.dist(M(c[i]), M(c[i + 1]))
        if acc + s >= t - 1e-12:
            r = 0 if s == 0 else (t - acc) / s
            return (c[i][0] + (c[i + 1][0] - c[i][0]) * r, c[i][1] + (c[i + 1][1] - c[i][1]) * r)
        acc += s
    return tuple(c[-1])
gap = []; nonc = 0
for si, r in res.items():
    if r['st'] != 'mapped': continue
    p = r['p']
    for (k1, a1, b1, _), (k2, a2, b2, _) in zip(p, p[1:]):
        g_ = geo_d(ptat(k1, b1), ptat(k2, a2))
        gap.append(g_)
        if g_ > 1e-6: nonc += 1
# 2. displacement: section midpoint (geo) vs mapped midpoint (schematic), in km-ish deg
pack = json.load(open(A.pack))
def dec(s):
    pts = []; lat = lon = 0; i = 0; n = len(s)
    while i < n:
        for k in (0, 1):
            sh = r_ = 0
            while True:
                b = ord(s[i]) - 63; i += 1; r_ |= (b & 0x1f) << sh; sh += 5
                if b < 0x20: break
            v = ~(r_ >> 1) if r_ & 1 else r_ >> 1
            if k == 0: lat += v
            else: lon += v
        pts.append((lon / 1e4, lat / 1e4))
    return pts
disp = []; disp_rec = []
for si, r in res.items():
    if r['st'] != 'mapped': continue
    q = dec(pack['sections'][int(si)]['g'])
    gm = q[len(q) // 2]
    k, a, b, _ = r['p'][len(r['p']) // 2]
    dv = geo_d(gm, ptat(k, (a + b) / 2)) * 111 * math.cos(math.radians(gm[1]))
    (disp_rec if r.get('rec') else disp).append(dv)
disp.sort(); disp_rec.sort()

# 2b. node consistency: all mapped sections meeting at one input node must start/end at the
#     same schematic point, and that point must be the node's resolved image (station nodes:
#     the station's own octi node).
touch = collections.defaultdict(list)
for si, r in res.items():
    if r['st'] != 'mapped' or si not in side['secnodes']: continue
    a_, b_ = side['secnodes'][si]
    k, u0, u1, _ = r['p'][0]; touch[a_].append(ptat(k, u0))
    k, u0, u1, _ = r['p'][-1]; touch[b_].append(ptat(k, u1))
node_split = node_off = st_off = 0
for n_, pts in touch.items():
    if max(geo_d(pts[0], p_) for p_ in pts) > 1e-6: node_split += 1
    if n_ in img:
        if max(geo_d(ond[img[n_]]['pt'], p_) for p_ in pts) > 1e-6:
            node_off += 1
            if n_ in stmap: st_off += 1
# 3. station coverage
bb = A.bbox
inb = lambda p: bb is None or (bb[0] <= p[0] <= bb[2] and bb[1] <= p[1] <= bb[3])
sts = [(i, t) for i, t in enumerate(pack['station_table']) if 'pt' in t and inb(t['pt'])]
direct = {int(nodes[n]['st']) for n in stmap if n in nodes and nodes[n]['st'] is not None}
# locatable: nearest section (within 0.03 deg) is mapped (or node)
segs = collections.defaultdict(list)
for si in universe:
    q = dec(pack['sections'][si]['g'])
    for a, b in zip(q, q[1:]):
        for gx in range(int(min(a[0], b[0]) * 20) - 1, int(max(a[0], b[0]) * 20) + 2):
            for gy in range(int(min(a[1], b[1]) * 20) - 1, int(max(a[1], b[1]) * 20) + 2):
                segs[(gx, gy)].append((si, a, b))
def segd(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx - ax, by - ay; L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(ax + t * dx - px, ay + t * dy - py)
loc = 0; nearsec = 0
for i, t in sts:
    p = t['pt']; best = None
    for si, a, b in segs.get((int(p[0] * 20), int(p[1] * 20)), []):
        dd = segd(p, a, b)
        if dd <= 0.03 and (best is None or dd < best[0]): best = (dd, si)
    if i in direct: loc += 1; nearsec += best is not None; continue
    if best is None: continue
    nearsec += 1
    if res[str(best[1])]['st'] in ('mapped', 'node'): loc += 1

json.dump({'edges': [[e['fi'], e['id']] for e in oed], 'nodes': nd_index, 'sections': res}, open(A.mapping, 'w'))
U = len(universe); K = sum(side['km'][str(s)] for s in universe)
stats = {'sections': U, 'km': round(K, 1),
         'by_status': {k: [cnt[k], round(100 * cnt[k] / U, 1), round(kmtot[k], 1), round(100 * kmtot[k] / K, 1)] for k in sorted(cnt)},
         'stations_in_region': len(sts), 'stations_near_a_section': nearsec, 'stations_direct': len(direct & {i for i, _ in sts}),
         'stations_locatable': loc,
         'out_edges': len(oed), 'chains': len(chains), 'chains_drawn': len(paths), 'path_issues': dict(bad), 'orient_unanchored': orient_bad,
         'nodes_touched': len(touch), 'nodes_split': node_split, 'nodes_off_image': node_off, 'stations_off_image': st_off,
         'chains_recovered': len(recovered), 'chains_end_extended': len(extended), 'piece_joins': len(gap), 'piece_joins_broken': nonc,
         'displacement_recovered_km_p50_max': [round(disp_rec[len(disp_rec) // 2], 1), round(disp_rec[-1], 1)] if disp_rec else None,
         'displacement_km_p50_p90_p99_max': [round(disp[int(len(disp) * q)], 1) for q in (0.5, 0.9, 0.99)] + [round(disp[-1], 1)] if disp else None}
print(json.dumps(stats))
if not A.quiet:
    for n_, pts in touch.items():
        if n_ in img and max(geo_d(ond[img[n_]]['pt'], p_) for p_ in pts) > 1e-6:
            print('OFF', n_, nodes[n_]['label'], 'img', ond[img[n_]]['pt'], 'touch', sorted({tuple(round(c, 4) for c in p_) for p_ in pts}), file=sys.stderr)
