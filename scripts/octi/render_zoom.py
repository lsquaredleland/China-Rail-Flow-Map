# usage: python3 -I render_zoom.py graph.json out.svg minlon minlat maxlon maxlat [side=1200] [partition.json]
# Zoomed render of an octi/stitched graph: edges by first line colour, connectors thick red,
# 'cut' nodes as red rings, stations as dots; tile edges dashed when a partition is given.
import json, sys, math
P = lambda p: (p[0], -math.degrees(math.log(math.tan(math.pi / 4 + math.radians(p[1]) / 2))))
g = json.load(open(sys.argv[1]))['features']; bb = list(map(float, sys.argv[3:7]))
side = int(sys.argv[7]) if len(sys.argv) > 7 else 1200
x0, y1 = P((bb[0], bb[1])); x1, y0 = P((bb[2], bb[3]))
s = side / max(x1 - x0, y1 - y0)
T = lambda c: ((P(c)[0] - x0) * s, (P(c)[1] - y0) * s)
o = ['<rect width="100%" height="100%" fill="white"/>']
if len(sys.argv) > 8:
    for t in json.load(open(sys.argv[8])):
        b = t['bbox']; a = T((b[0], b[3])); c = T((b[2], b[1]))
        o.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="none" stroke="#999" stroke-dasharray="6,4"/>' % (a[0], a[1], c[0] - a[0], c[1] - a[1]))
for e in g:
    if e['geometry']['type'] != 'LineString': continue
    c = e['geometry']['coordinates']
    if not any(bb[0] - 1 <= p[0] <= bb[2] + 1 and bb[1] - 1 <= p[1] <= bb[3] + 1 for p in c): continue
    pr = e['properties']; conn = pr.get('connector')
    ls = [l for l in pr.get('lines', []) if not l['id'].startswith('#')] or [{'color': '888888'}]
    o.append('<polyline fill="none" stroke="%s" stroke-width="%.1f" stroke-linejoin="round" points="%s"/>' % (
        '#e00' if conn else '#' + ls[0]['color'], 4 if conn else 2, ' '.join('%.1f,%.1f' % T(p) for p in c)))
for e in g:
    if e['geometry']['type'] != 'Point': continue
    p = e['geometry']['coordinates']
    if not (bb[0] <= p[0] <= bb[2] and bb[1] <= p[1] <= bb[3]): continue
    lab = e['properties'].get('station_label'); x, y = T(p)
    if lab == 'cut': o.append('<circle cx="%.1f" cy="%.1f" r="6" fill="none" stroke="#e00" stroke-width="2"/>' % (x, y))
    elif lab: o.append('<circle cx="%.1f" cy="%.1f" r="2.5" fill="#fff" stroke="#111"/>' % (x, y))
open(sys.argv[2], 'w').write('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d">%s</svg>' % (side, side, '\n'.join(o)))
