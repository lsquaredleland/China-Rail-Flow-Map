"""Scan china-rail.osm for the O9 gap regions: node coords in bboxes, station
nodes, and railway ways (any railway=* incl. construction/proposed) touching them.
Usage: python3 -I osm_gaps.py <china-rail.osm> <out.json>"""
import json
import sys
import xml.etree.ElementTree as ET

BOXES = {
    "henan": (32.90, 112.40, 35.00, 114.30),   # 平顶山西 禹州 郏县 郑州东
    "yuexi": (21.40, 110.70, 22.80, 113.30),   # 恩平 阳江 江门
    "luxi": (34.30, 115.00, 36.60, 116.60),    # 聊城西 菏泽东
}


def box_of(lat, lon):
    for k, (a, b, c, d) in BOXES.items():
        if a <= lat <= c and b <= lon <= d:
            return k
    return None


nodes = {}       # id -> [lat, lon]
stations = []    # {id, lat, lon, tags}
ways = []        # {id, tags, nodes}
for ev, el in ET.iterparse(sys.argv[1], events=("end",)):
    if el.tag == "node":
        lat, lon = float(el.get("lat")), float(el.get("lon"))
        if box_of(lat, lon):
            nid = int(el.get("id"))
            nodes[nid] = [lat, lon]
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if tags.get("railway") in ("station", "halt", "stop") or tags.get("public_transport") == "station":
                stations.append({"id": nid, "lat": lat, "lon": lon, "tags": tags})
        el.clear()
    elif el.tag == "way":
        nds = [int(n.get("ref")) for n in el.findall("nd")]
        if any(n in nodes for n in nds):
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            ways.append({"id": int(el.get("id")), "tags": tags, "nodes": nds})
        el.clear()
    elif el.tag == "relation":
        el.clear()
json.dump({"nodes": nodes, "stations": stations, "ways": ways}, open(sys.argv[2], "w"), ensure_ascii=False)
print(len(nodes), "nodes", len(stations), "stations", len(ways), "ways")
