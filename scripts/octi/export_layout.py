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
# Points that are not on the mapping (throat ends, stations, in_sections that differ from
# sections) go through one transform T: nearest section segment within SNAP_DEG, by fraction
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
    if st is not None: stn.setdefault(int(st), tuple(f['geometry']['coordinates']))
station_pt = []
for i, t in enumerate(pack['station_table']):
    if i in stn: station_pt.append(stn[i])
    elif 'pt' in t: station_pt.append(T(t['pt']))
    else: station_pt.append(None)
# cities: shifted by the mean offset of their stations
off = collections.defaultdict(list)
for i, t in enumerate(pack['station_table']):
    if 'pt' in t and station_pt[i] is not None and t.get('city') is not None:
        off[t['city']].append((station_pt[i][0] - t['pt'][0], station_pt[i][1] - t['pt'][1]))
city_pt = []
for i, c in enumerate(pack['city_table']):
    o = off.get(i)
    if o: city_pt.append((c['pt'][0] + sum(x for x, _ in o) / len(o), c['pt'][1] + sum(y for _, y in o) / len(o)))
    else: city_pt.append(T(c['pt']))

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
network = [dp(dedup(c), SIMPLIFY_DEG) for c, _ in E]

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
print(json.dumps({'sections': stat, 'in_sections': istat, 'T': tstat, 'stations_octi': len(stn),
                  'stations': len(station_pt), 'cities': len(city_pt), 'network': len(network)}), file=sys.stderr)
