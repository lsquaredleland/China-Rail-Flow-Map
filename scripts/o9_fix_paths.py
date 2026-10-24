"""Build O9 pair-path fixes: shortest path over OSM railway=rail ways (no
construction/proposed/disused), between the station terminal nodes the
pair's trains actually use, plus any listed connector hops (none at present).
Edges already used by the canonical pair paths / router leg paths cost 1.0x,
others 1.3x, so the path lands on the same track of a double track (one
corridor).

Usage: python3 -I o9_osm_regions.py <china-rail.osm> osm_regions.json, then
       python3 -I o9_fix_paths.py <osm_regions.json> <pair_paths_canonical.json>
       <leg_paths.json> <out pair_path_fixes.json>
"""
import heapq
import json
import math
import sys
from collections import Counter, defaultdict

# (from, to, from terminal node, to terminal node, why)
PAIRS = [
    ("平顶山西", "禹州", 14159897243, 11587052472,
     "禹州 snapped to the 登禹铁路 station (34.1406,113.4445); trains use the 郑渝高铁 station (34.1256,113.5647)"),
    ("禹州", "郏县", 11587052472, 12366584438, "same 禹州 snap"),
    ("恩平", "阳江", 13584639914, 8976473532,
     "阳江 snapped to the 阳阳铁路 station (21.8635,111.8773); trains use the 深茂铁路 station (21.8131,111.9860)"),
    ("江门", "阳江", 11597704847, 8976473532, "same 阳江 snap (via_chain 台山, 开平南)"),
    ("郏县", "郑州东", 12366584438, 8025366872,
     "郏县 snapped to the 禹郏铁路 station (34.0933,113.2415); trains use the 郑渝高铁 station (33.9467,113.2644)"),
]
# Pairs taken as a slice of an existing canonical pair path that runs through
# both terminals (the scanned regions do not hold its whole route).
CUTS = {("郏县", "郑州东"): ("平顶山西", "郑州东")}
# Connector hops (node, node) where OSM leaves parallel tracks unjoined at a
# station throat. None: the owner kept 菏泽东 (京港高速线 unjoined) as a chord.
CONNECTORS = []
UNUSED_COST = 1.3
# The terminal node each station's trains use; every other canonical pair at
# these stations that ends > 3 km from it or has a > 3 km hole is rerouted
# too, so consecutive legs meet at the same station.
TERMINAL = {"禹州": 11587052472, "阳江": 8976473532, "郏县": 12366584438}


def km(p, q):
    la1, lo1, la2, lo2 = map(math.radians, (p[0], p[1], q[0], q[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def main():
    R = json.load(open(sys.argv[1]))
    nodes = {int(k): v for k, v in R["nodes"].items()}
    used = set()
    for r in json.load(open(sys.argv[2]))["pairs"]:
        for s in r["segments"]:
            for u, v in zip(s, s[1:]):
                used.add((min(u, v), max(u, v)))
    for r in json.load(open(sys.argv[3])):
        for s in r["segments"]:
            for u, v in zip(s, s[1:]):
                used.add((min(u, v), max(u, v)))
    adj = defaultdict(list)
    wname = {}
    for w in R["ways"]:
        if w["tags"].get("railway") != "rail":
            continue
        nm = w["tags"].get("name", "") or "<" + w["tags"].get("service", "track") + ">"
        ns = w["nodes"]
        for u, v in zip(ns, ns[1:]):
            if u in nodes and v in nodes:
                d = km(nodes[u], nodes[v])
                c = d * (1.0 if (min(u, v), max(u, v)) in used else UNUSED_COST)
                adj[u].append((v, c, d))
                adj[v].append((u, c, d))
                wname[(min(u, v), max(u, v))] = nm
    for u, v in CONNECTORS:
        d = km(nodes[u], nodes[v])
        adj[u].append((v, d, d))
        adj[v].append((u, d, d))
        wname[(min(u, v), max(u, v))] = "<connector %.0f m>" % (d * 1000)
    canon = {(r["from"], r["to"]): r for r in json.load(open(sys.argv[2]))["pairs"]}
    pairs = list(PAIRS)
    listed = {frozenset((x[0], x[1])) for x in PAIRS}
    for (f, t), r in sorted(canon.items()):
        segs = [x for x in r["segments"] if x]
        if frozenset((f, t)) in listed or not segs or not ({f, t} & TERMINAL.keys()):
            continue
        a, b = segs[0][0], segs[-1][-1]
        holes = [km(nodes[x[-1]], nodes[y[0]]) for x, y in zip(segs, segs[1:]) if x[-1] in nodes and y[0] in nodes]
        a2, b2 = TERMINAL.get(f, a), TERMINAL.get(t, b)
        off = max(km(nodes[a], nodes[a2]), km(nodes[b], nodes[b2])) if a in nodes and b in nodes else 0.0
        if off > 3 or any(h > 3 for h in holes):
            pairs.append((f, t, a2, b2, "same station cause (auto: %s, ends %s->%s, holes %s)" % (r["status"], a, b, [round(h, 1) for h in holes])))
    out = []
    for a_nm, b_nm, a, b, why in pairs:
        if (a_nm, b_nm) in CUTS:
            seg = canon[CUTS[(a_nm, b_nm)]]["segments"][0]
            path = seg[seg.index(a):seg.index(b) + 1]
            print("%s-%s: slice of canonical %s, %d nodes" % (a_nm, b_nm, "-".join(CUTS[(a_nm, b_nm)]), len(path)))
            out.append({"from": a_nm, "to": b_nm, "status": "o9_fix", "note": why, "segments": [path]})
            continue
        dist, prev, pq = {a: 0.0}, {}, [(0.0, a)]
        while pq:
            d, u = heapq.heappop(pq)
            if u == b:
                break
            if d > dist[u]:
                continue
            for v, c, _ in adj[u]:
                if d + c < dist.get(v, 1e18):
                    dist[v] = d + c
                    prev[v] = u
                    heapq.heappush(pq, (d + c, v))
        if b not in dist:
            print("UNROUTABLE", a_nm, b_nm, why)
            continue
        path = [b]
        while path[-1] != a:
            path.append(prev[path[-1]])
        path.reverse()
        legs = list(zip(path, path[1:]))
        track = sum(km(nodes[u], nodes[v]) for u, v in legs)
        hop = max(km(nodes[u], nodes[v]) for u, v in legs)
        unused = sum(km(nodes[u], nodes[v]) for u, v in legs if (min(u, v), max(u, v)) not in used)
        lines = []
        for u, v in legs:
            nm = wname[(min(u, v), max(u, v))]
            if not lines or lines[-1][0] != nm:
                lines.append([nm, 0.0])
            lines[-1][1] += km(nodes[u], nodes[v])
        print("%s-%s: %.1f km, %d nodes, max hop %.0f m, off existing paths %.1f km" % (a_nm, b_nm, track, len(path), hop * 1000, unused))
        print("   ", " > ".join("%s %.1f" % (n, l) for n, l in lines if l >= 0.5 or n.startswith("<conn")))
        out.append({"from": a_nm, "to": b_nm, "status": "o9_fix", "track_km": round(track, 1), "note": why, "segments": [path]})
    json.dump({"about": "O9 pair-path fixes (staging/o5o9/scripts/o9_fix_paths.py): listed FIRST in ATLAS_PAIR_PATHS so they replace the canonical record for these pairs.", "pairs": out},
              open(sys.argv[4], "w"), ensure_ascii=False)


main()
