# usage: python3 -I quality.py graph.json mapping.json side_or_km.json [more side files...]
# Layout quality numbers: total schematic km, longest edges, and per-section detours
# (schematic km of a section's mapped pieces vs its geographic km).
import json, sys, math
g = json.load(open(sys.argv[1]))['features']; mp = json.load(open(sys.argv[2]))
km = {}
for p in sys.argv[3:]: km.update(json.load(open(p))['km'])
def L(c): return sum(math.hypot((c[i][0] - c[i + 1][0]) * 111.32 * math.cos(math.radians(c[i][1])), (c[i][1] - c[i + 1][1]) * 110.57) for i in range(len(c) - 1))
E = [L(g[fi]['geometry']['coordinates']) for fi, _ in mp['edges']]
tot = sum(L(f['geometry']['coordinates']) for f in g if f['geometry']['type'] == 'LineString')
det = []; schem = 0; geo = 0
for si, r in mp['sections'].items():
    if r['st'] != 'mapped': continue
    s = sum(E[k] * abs(b - a) for k, a, b, _ in r['p']); gk = km.get(si, 0)
    schem += s; geo += gk
    if s > 3 * gk + 200: det.append((round(s), round(gk), si))
det.sort(reverse=True)
print(json.dumps({'total_km': round(tot), 'edges_over_500km': sum(1 for x in E if x > 500), 'longest_edges_km': [round(x) for x in sorted(E)[-3:]],
                  'mapped_schematic_over_geo': round(schem / geo, 2), 'detoured_sections': len(det), 'detoured_extra_km': sum(a - 3 * b for a, b, _ in det),
                  'worst_detours': det[:3]}))
