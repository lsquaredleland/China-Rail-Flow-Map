# usage: python3 -I render_map.py octi_out.json mapping.json shared.json out.svg [--bbox ...] [--side 1400]
# Left: pack sections in geography, coloured by mapping status.
# Right: octi layout; every mapped section drawn as its mapped pieces in its own colour
#        (hash of section id) over a grey base; collapsed sections as red dots at their node.
# Lost sections are drawn thick magenta on the left.
import json, sys, math, hashlib, argparse
ap = argparse.ArgumentParser()
ap.add_argument('out'); ap.add_argument('mapping'); ap.add_argument('pack'); ap.add_argument('svg')
ap.add_argument('--bbox', nargs=4, type=float); ap.add_argument('--side', type=int, default=1400)
ap.add_argument('--title', default='')
A = ap.parse_args()
P = lambda p: (p[0], -math.degrees(math.log(math.tan(math.pi / 4 + math.radians(p[1]) / 2))))


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


feats = json.load(open(A.out))['features']; mp = json.load(open(A.mapping)); pack = json.load(open(A.pack))
E = mp['edges']; N = mp['nodes']
side = A.side; pad = side * 0.03


def fitter(pts, x_off):
    xs = [P(c) for c in pts]
    x0, x1 = min(a for a, b in xs), max(a for a, b in xs); y0, y1 = min(b for a, b in xs), max(b for a, b in xs)
    s = min((side - 2 * pad) / (x1 - x0 or 1), (side - 2 * pad) / (y1 - y0 or 1))
    return lambda c: ((P(c)[0] - x0) * s + pad + x_off, (P(c)[1] - y0) * s + pad + 30)


def pl(cs, T, color, w, op=1):
    return '<polyline fill="none" stroke="%s" stroke-opacity="%.2f" stroke-width="%.2f" stroke-linejoin="round" stroke-linecap="round" points="%s"/>' % (
        color, op, w, ' '.join('%.1f,%.1f' % T(c) for c in cs))


def sub(c, u0, u1):
    if u0 > u1: return sub(c, u1, u0)[::-1]
    L = [0]
    for i in range(len(c) - 1): L.append(L[-1] + math.dist(P(c[i]), P(c[i + 1])))
    tot = L[-1] or 1; a, b = u0 * tot, u1 * tot; out = []
    def at(i, t):
        s = L[i + 1] - L[i]; r = 0 if s == 0 else (t - L[i]) / s
        return (c[i][0] + (c[i + 1][0] - c[i][0]) * r, c[i][1] + (c[i + 1][1] - c[i][1]) * r)
    for i in range(len(c) - 1):
        if L[i + 1] >= a and L[i] <= b:
            if not out: out.append(at(i, max(a, L[i])))
            if L[i + 1] <= b: out.append(c[i + 1])
            else: out.append(at(i, b)); break
    return out or [c[0], c[0]]


secs = mp['sections']
geo = {si: dec(pack['sections'][int(si)]['g']) for si in secs}
TL = fitter([c for q in geo.values() for c in q], 0)
TR = fitter([c for f in feats if f['geometry']['type'] == 'LineString' for c in f['geometry']['coordinates']], 0)
sw = side / 900
COL = {'mapped/own': '#2b6cb0', 'mapped/parallel': '#38a169', 'node': '#dd6b20', 'lost': '#d53f8c'}
o = ['<rect width="100%" height="100%" fill="white"/>',
     '<text x="10" y="20" font-family="Helvetica" font-size="14">%s geography: blue own edge, green shares an edge with a parallel, orange collapsed to node, magenta lost</text>' % A.title]
for si, r in secs.items():
    st = r['st']
    k = 'lost' if st.startswith('lost') else 'node' if st == 'node' else ('mapped/parallel' if r.get('par') else 'mapped/own')
    o.append(pl(geo[si] if len(geo[si]) > 1 else geo[si] * 2, TL, COL[k], sw * (3 if k == 'lost' else 1.4)))
HDR = '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d">%s</svg>'
open(A.svg.replace('.svg', '_geo.svg'), 'w').write(HDR % (side, side + 40, '\n'.join(o)))
o = ['<rect width="100%" height="100%" fill="white"/>',
     '<text x="10" y="20" font-family="Helvetica" font-size="14">%s octi layout: grey = octi edges; each mapped section drawn over it in its own colour (dot = section start); orange rings = collapsed sections</text>' % A.title]
for f in feats:
    if f['geometry']['type'] == 'LineString':
        o.append(pl(f['geometry']['coordinates'], TR, '#ccc', sw * 4))
ecoords = [feats[fi]['geometry']['coordinates'] for fi, _ in E]
for si, r in secs.items():
    if r['st'] != 'mapped': continue
    c = '#' + hashlib.md5(si.encode()).hexdigest()[:6]
    for k, u0, u1, d_ in r['p']:
        o.append(pl(sub(ecoords[k], u0, u1), TR, c, sw * 1.6, 0.9))
    # start marker: small tick at section start
    k, u0, u1, _ = r['p'][0]
    x, y = TR(sub(ecoords[k], u0, u1)[0]); o.append('<circle cx="%.1f" cy="%.1f" r="%.2f" fill="%s"/>' % (x, y, sw * 1.0, c))
for si, r in secs.items():
    if r['st'] == 'node':
        x, y = TR(feats[N[r['n']][0]]['geometry']['coordinates'])
        o.append('<circle cx="%.1f" cy="%.1f" r="%.2f" fill="none" stroke="#dd6b20" stroke-width="%.2f"/>' % (x, y, sw * 2.5, sw * 0.6))
open(A.svg.replace('.svg', '_octi.svg'), 'w').write(HDR % (side, side + 40, '\n'.join(o)))
