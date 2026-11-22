# usage: python3 -I stitch.py partition.json <tag> shared.json out_prefix
#   reads  out/<tag>_<tile>.json, out/<tag>_<tile>.map.json, tiles/<tile>.side.json
#   writes <out_prefix>.json      stitched octi graph (tile edges + connector edges; GeoJSON like octi's)
#          <out_prefix>.map.json  per-section mapping in map_sections.py format, global edge/node indices
#          prints stats (coverage, connector lengths, crossings, contiguity)
# Tiles are octi layouts of disjoint rectangles (sections cut at tile edges, cut ends kept as
# deg-1 'cut' nodes). octi keeps coordinates roughly geographic, so all tiles already share one
# web-mercator frame; each cut is closed with an octilinear connector (<=2 legs: diagonal, then
# axis-parallel) between the two cut nodes' octi positions.
import json, sys, math, collections

PART, TAG, PACK, OUT = sys.argv[1:5]
STUB_KM = float(sys.argv[5]) if len(sys.argv) > 5 else 0   # >0: replace stub+connector+stub by one octilinear edge when both stubs are <= STUB_KM
import os
R = os.environ['OCTI_WORK']   # set by scripts/octi/env.sh
tiles = [t['name'] for t in json.load(open(PART))]

def wm(p):
    return (p[0] * 20037508.34 / 180, math.log(math.tan((90 + p[1]) * math.pi / 360)) * 20037508.34 / math.pi)
def unwm(x):
    return [x[0] * 180 / 20037508.34, math.degrees(2 * math.atan(math.exp(x[1] * math.pi / 20037508.34)) - math.pi / 2)]
def kmlen(c):
    return sum(math.hypot((c[i][0] - c[i + 1][0]) * 111.32 * math.cos(math.radians(c[i][1])), (c[i][1] - c[i + 1][1]) * 110.57)
               for i in range(len(c) - 1))

feats = []; edges = []; nodes = []      # global: edges/nodes = [feature index, id]
tl = {}                                  # tile -> dict
for t in tiles:
    out = json.load(open('%s/out/%s_%s.json' % (R, TAG, t)))['features']
    mp = json.load(open('%s/out/%s_%s.map.json' % (R, TAG, t)))
    side = json.load(open('%s/tiles/%s.side.json' % (R, t)))
    base = len(feats)
    for f in out:
        f['properties']['id'] = t + ':' + f['properties']['id']
        for k in ('from', 'to'):
            if k in f['properties']: f['properties'][k] = t + ':' + f['properties'][k]
        f['properties']['tile'] = t
        feats.append(f)
    e0, n0 = len(edges), len(nodes)
    for fi, _ in mp['edges']: edges.append([base + fi, feats[base + fi]['properties']['id']])
    for fi, _ in mp['nodes']: nodes.append([base + fi, feats[base + fi]['properties']['id']])
    st2node = {}
    for fi, f in enumerate(out):
        p = f['properties']
        if f['geometry']['type'] == 'Point' and p.get('station_id'): st2node[p['station_id'][3:]] = base + fi
    tl[t] = {'mp': mp, 'side': side, 'e0': e0, 'n0': n0, 'st2node': st2node}

# --- connectors
fi_to_node = {fi: k for k, (fi, _) in enumerate(nodes)}
cutpos = collections.defaultdict(list)    # cut id -> [(tile, feature idx)]
for t in tiles:
    for cid, nid in tl[t]['side']['cutnodes'].items():
        fi = tl[t]['st2node'].get(nid)
        cutpos[cid].append((t, fi))
def octi2(pa, pb):
    """<=2-leg octilinear polyline pa->pb (web-mercator in, lon/lat out): diagonal then axis-parallel"""
    dx, dy = pb[0] - pa[0], pb[1] - pa[1]; d = min(abs(dx), abs(dy))
    mid = (pa[0] + math.copysign(d, dx), pa[1] + math.copysign(d, dy))
    pts = [pa] + ([mid] if 0 < d and (abs(dx) - d > 1 or abs(dy) - d > 1) else []) + [pb]
    return [unwm(p) for p in pts]
conn = {}; clen = []; missing = 0; cutfi = {}
for cid, lst in sorted(cutpos.items()):
    if len(lst) != 2 or any(fi is None for _, fi in lst):
        missing += 1; continue
    (ta, fa), (tb, fb) = lst
    pa, pb = wm(feats[fa]['geometry']['coordinates']), wm(feats[fb]['geometry']['coordinates'])
    coords = octi2(pa, pb)
    L = kmlen(coords); clen.append((L, cid))
    f = {'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': coords},
         'properties': {'id': 'conn:' + cid, 'from': feats[fa]['properties']['id'], 'to': feats[fb]['properties']['id'],
                        'connector': True, 'lines': [{'id': 'Lconn', 'label': 'connector', 'color': 'ff0000'}]}}
    feats.append(f); edges.append([len(feats) - 1, f['properties']['id']])
    conn[cid] = (len(edges) - 1, ta, tb); cutfi[cid] = (fa, fb)

# --- per-section mapping
pack = json.load(open(PACK))
res = {}
for t in tiles:
    for si, r in tl[t]['mp']['sections'].items():
        res.setdefault(si, []).append((t, r))
smap = {}; cnt = collections.Counter(); kmc = collections.Counter(); broken_conn = 0
seckm = {}
for t in tiles: seckm.update(tl[t]['side']['km'])
for si, lst in res.items():
    if len(lst) == 1 and 'runs' not in lst[0][1]:
        t, r = lst[0]; r = dict(r)
        if r['st'] == 'mapped': r['p'] = [[k + tl[t]['e0'], a, b, d] for k, a, b, d in r['p']]
        elif r['st'] == 'node': r['n'] = r['n'] + tl[t]['n0']
        smap[si] = r
    else:   # cut section: runs from several tiles, joined by connectors in section order
        runs = []
        for t, r in lst:
            for a, b, pc, nd in r.get('runs', []):
                runs.append((a, b, t, pc, nd))
        runs.sort()
        p = []; nodeonly = None
        for i, (a, b, t, pc, nd) in enumerate(runs):
            if i:
                cid = tl[t]['side']['cutkey'].get('%s@%.9f' % (si, a))
                if cid in conn:
                    k, ta, tb = conn[cid]
                    p.append([k, 0.0, 1.0, 1] if t == tb else [k, 1.0, 0.0, -1])
                else: broken_conn += 1
            if pc: p += [[k + tl[t]['e0'], u0, u1, 1 if u1 >= u0 else -1] for k, u0, u1 in pc]
            elif nd is not None and nodeonly is None: nodeonly = nd + tl[t]['n0']
        if p: smap[si] = {'st': 'mapped', 'p': p, 'cut': True}
        elif nodeonly is not None: smap[si] = {'st': 'node', 'n': nodeonly, 'cut': True}
        else: smap[si] = {'st': 'lost-octi', 'cut': True}
    st = smap[si]['st']; cat = st + ('/cut' if smap[si].get('cut') else '')
    cnt[cat] += 1; kmc[cat] += seckm.get(si, 0)

# --- optional seam cleanup: stub_A + connector + stub_B -> one octilinear edge X_A -> X_B
removed = set(); joined = 0; jlen = []
if STUB_KM > 0:
    inc = collections.defaultdict(list); fid = {}
    for k, (fi, _) in enumerate(edges):
        pr = feats[fi]['properties']; inc[pr['from']].append(k); inc[pr['to']].append(k)
    for fi, f in enumerate(feats):
        if f['geometry']['type'] == 'Point': fid[f['properties']['id']] = fi
    xform = {}   # removed edge -> (J edge, function u -> J u)
    cutnode_at = {}   # dropped cut node feature -> (J edge, fraction): sections collapsed into it
    for cid, (kc, ta, tb) in conn.items():
        fa, fb = cutfi[cid]; ca, cb = feats[fa]['properties']['id'], feats[fb]['properties']['id']
        ea = [k for k in inc[ca] if k != kc]; eb = [k for k in inc[cb] if k != kc]
        if len(ea) != 1 or len(eb) != 1: continue
        ea, eb = ea[0], eb[0]
        if ea in removed or eb in removed: continue
        A_, B_ = feats[edges[ea][0]], feats[edges[eb][0]]
        LA, LB, LC = kmlen(A_['geometry']['coordinates']), kmlen(B_['geometry']['coordinates']), kmlen(feats[edges[kc][0]]['geometry']['coordinates'])
        if LA > STUB_KM or LB > STUB_KM: continue
        xa = A_['properties']['to'] if A_['properties']['from'] == ca else A_['properties']['from']
        xb = B_['properties']['to'] if B_['properties']['from'] == cb else B_['properties']['from']
        if xa == xb: continue
        coords = octi2(wm(feats[fid[xa]]['geometry']['coordinates']), wm(feats[fid[xb]]['geometry']['coordinates']))
        lines = {l['id']: l for l in A_['properties'].get('lines', []) + B_['properties'].get('lines', [])}
        f = {'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': coords},
             'properties': {'id': 'join:' + cid, 'from': xa, 'to': xb, 'seam': True, 'lines': list(lines.values())}}
        feats.append(f); edges.append([len(feats) - 1, f['properties']['id']]); kj = len(edges) - 1
        T_ = LA + LB + LC or 1; a_, b_ = LA / T_, (LA + LC) / T_
        afx = A_['properties']['from'] == xa; bfc = B_['properties']['from'] == cb
        xform[ea] = (kj, lambda u, afx=afx, a_=a_: a_ * (u if afx else 1 - u))
        xform[kc] = (kj, lambda u, a_=a_, b_=b_: a_ + (b_ - a_) * u)
        xform[eb] = (kj, lambda u, bfc=bfc, b_=b_: b_ + (1 - b_) * (u if bfc else 1 - u))
        removed |= {ea, eb, kc}; joined += 1
        cutnode_at[fa] = (kj, a_); cutnode_at[fb] = (kj, b_); jlen.append(kmlen(coords) - LA - LB - LC)
    for si, r in smap.items():
        if r['st'] != 'mapped': continue
        out = []
        for k, u0, u1, d in r['p']:
            if k in xform:
                kj, fn = xform[k]; u0, u1, k = fn(u0), fn(u1), kj
            if out and out[-1][0] == k and abs(out[-1][2] - u0) < 1e-9:
                out[-1][2] = u1
            else: out.append([k, u0, u1, 0])
        for x in out: x[3] = 1 if x[2] >= x[1] else -1
        r['p'] = [[k, round(a, 6), round(b, 6), d] for k, a, b, d in out]
    # drop removed edges and orphaned cut nodes; renumber
    dropfi = {edges[k][0] for k in removed}
    alive_ids = set()
    for k, (fi, _) in enumerate(edges):
        if k not in removed: alive_ids |= {feats[fi]['properties']['from'], feats[fi]['properties']['to']}
    for cid in conn:
        for fi in cutfi[cid]:
            if feats[fi]['properties']['id'] not in alive_ids: dropfi.add(fi)
    newfi = {}; nf = []
    for fi, f in enumerate(feats):
        if fi not in dropfi: newfi[fi] = len(nf); nf.append(f)
    ek = {}; ne = []
    for k, (fi, i_) in enumerate(edges):
        if k not in removed: ek[k] = len(ne); ne.append([newfi[fi], i_])
    nk = {}; nn = []
    for k, (fi, i_) in enumerate(nodes):
        if fi in newfi: nk[k] = len(nn); nn.append([newfi[fi], i_])
    for si, r in smap.items():
        if r['st'] == 'mapped': r['p'] = [[ek[k], a, b, d] for k, a, b, d in r['p']]
        elif r['st'] == 'node':
            if r['n'] in nk: r['n'] = nk[r['n']]
            else:   # collapsed into a cut node that the seam join removed: a point on the joined edge
                kj, u = cutnode_at[nodes[r['n']][0]]
                r['st'] = 'mapped'; r['p'] = [[ek[kj], round(u, 6), round(u, 6), 1]]; r.pop('n')
    feats, edges, nodes = nf, ne, nn

# --- crossings introduced by connectors (proper segment intersections with any other edge)
def segs(c): return [(wm(c[i]), wm(c[i + 1])) for i in range(len(c) - 1)]
def isect(a, b, c, d):
    def o(p, q, r): return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2, d3, d4 = o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d)
    return (d1 * d2 < 0) and (d3 * d4 < 0)
G = 50000; grid = collections.defaultdict(list)
for k, (fi, _) in enumerate(edges):
    for s_ in segs(feats[fi]['geometry']['coordinates']):
        for gx in range(int(min(s_[0][0], s_[1][0]) // G), int(max(s_[0][0], s_[1][0]) // G) + 1):
            for gy in range(int(min(s_[0][1], s_[1][1]) // G), int(max(s_[0][1], s_[1][1]) // G) + 1):
                grid[(gx, gy)].append((k, s_))
crossings = 0; crossed = []
for k, (fi, _) in enumerate(edges):
    pr = feats[fi]['properties']
    if not (pr.get('connector') or pr.get('seam')): continue
    cid = pr['id']; hit = set()
    for s_ in segs(feats[edges[k][0]]['geometry']['coordinates']):
        for gx in range(int(min(s_[0][0], s_[1][0]) // G), int(max(s_[0][0], s_[1][0]) // G) + 1):
            for gy in range(int(min(s_[0][1], s_[1][1]) // G), int(max(s_[0][1], s_[1][1]) // G) + 1):
                for k2, s2 in grid[(gx, gy)]:
                    if k2 != k and k2 not in hit and isect(s_[0], s_[1], s2[0], s2[1]): hit.add(k2)
    if hit: crossings += len(hit); crossed.append((cid, len(hit)))

# contiguity of mapped pieces (incl. connectors)
def ptat(k, u):
    c = feats[edges[k][0]]['geometry']['coordinates']; P = [wm(x) for x in c]
    L = sum(math.dist(P[i], P[i + 1]) for i in range(len(P) - 1)); t = u * L; acc = 0
    for i in range(len(P) - 1):
        s_ = math.dist(P[i], P[i + 1])
        if acc + s_ >= t - 1e-9:
            r = 0 if s_ == 0 else (t - acc) / s_
            return (P[i][0] + (P[i + 1][0] - P[i][0]) * r, P[i][1] + (P[i + 1][1] - P[i][1]) * r)
        acc += s_
    return P[-1]
joins = brk = 0; worst = 0
for si, r in smap.items():
    if r['st'] != 'mapped': continue
    for (k1, a1, b1, _), (k2, a2, b2, _) in zip(r['p'], r['p'][1:]):
        g = math.dist(ptat(k1, b1), ptat(k2, a2)); joins += 1
        if g > 1: brk += 1; worst = max(worst, g)

json.dump({'type': 'FeatureCollection', 'features': feats}, open(OUT + '.json', 'w'))
json.dump({'edges': edges, 'nodes': nodes, 'sections': smap}, open(OUT + '.map.json', 'w'))
U = len(smap); K = sum(seckm.get(s, 0) for s in smap)
clen.sort()
print(json.dumps({'tiles': len(tiles), 'sections': U, 'km': round(K),
                  'by_status': {k: [cnt[k], round(100 * cnt[k] / U, 1), round(kmc[k]), round(100 * kmc[k] / K, 1)] for k in sorted(cnt)},
                  'cuts': len(cutpos), 'connectors': len(conn), 'cuts_unmatched': missing,
                  'connector_km_p50_p90_max': [round(clen[len(clen) // 2][0], 1), round(clen[int(len(clen) * .9)][0], 1), round(clen[-1][0], 1)] if clen else None,
                  'connector_km_total': round(sum(x[0] for x in clen)), 'longest_connectors': [(round(l), c) for l, c in clen[-5:]],
                  'connector_crossings': crossings, 'connectors_crossing': len(crossed),
                  'cut_runs_without_connector': broken_conn, 'seams_joined': joined,
                  'join_extra_km_p50_max': [round(sorted(jlen)[len(jlen) // 2], 1), round(max(jlen), 1)] if jlen else None, 'piece_joins': joins, 'piece_joins_broken': brk, 'worst_gap_m': round(worst)}))
