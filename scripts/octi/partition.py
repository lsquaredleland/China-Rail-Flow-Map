# usage: python3 -I partition.py shared.json out.json [max_sections_per_tile=1500]
# Disjoint rectangular tiling of the pack for stitched octi layouts. Recursive split of the
# longer side; the cut line is chosen among the 30%..70% quantiles of section midpoints to
# cross as few sections (and as little dense network) as possible.
import json, sys, math

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

d = json.load(open(sys.argv[1])); N = int(sys.argv[3]) if len(sys.argv) > 3 else 1500
secs = [dec(s['g']) for s in d['sections']]
box0 = [min(p[0] for q in secs for p in q) - 0.5, min(p[1] for q in secs for p in q) - 0.5,
        max(p[0] for q in secs for p in q) + 0.5, max(p[1] for q in secs for p in q) + 0.5]
info = [(min(p[0] for p in q), min(p[1] for p in q), max(p[0] for p in q), max(p[1] for p in q),
         q[len(q) // 2]) for q in secs]

def inside(i, b):
    m = info[i][4]; return b[0] <= m[0] < b[2] and b[1] <= m[1] < b[3]

def split(b, ids, name):
    if len(ids) <= N: return [(name, b, len(ids))]
    w = (b[2] - b[0]) * math.cos(math.radians((b[1] + b[3]) / 2)); h = b[3] - b[1]
    ax = 0 if w >= h else 1
    ms = sorted(info[i][4][ax] for i in ids)
    best = None
    for qi in range(30, 71):
        c = round(ms[int(len(ms) * qi / 100)], 2)
        cross = sum(1 for i in ids if info[i][ax] < c < info[i][ax + 2])
        # mild preference for the middle
        score = cross + abs(qi - 50) * 0.5
        if best is None or score < best[0]: best = (score, c, cross)
    _, c, cross = best
    b1 = list(b); b2 = list(b); b1[ax + 2] = c; b2[ax] = c
    i1 = [i for i in ids if info[i][4][ax] < c]; i2 = [i for i in ids if info[i][4][ax] >= c]
    print(name, 'split', 'lon' if ax == 0 else 'lat', c, 'crossing', cross, len(i1), len(i2), file=sys.stderr)
    return split(b1, i1, name + 'a') + split(b2, i2, name + 'b')

tiles = split(box0, list(range(len(secs))), 't')
json.dump([{'name': n, 'bbox': b, 'sections_by_mid': k} for n, b, k in tiles], open(sys.argv[2], 'w'), indent=1)
for t in tiles: print(t, file=sys.stderr)
