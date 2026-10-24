"""Splice a corridor-router rerun into the shipped corridor-v3 outputs, for the
named stations only. The router is not deterministic run to run (two runs on
identical inputs differ on ~400 legs), so a whole rerun would change legs far
from the fix. This keeps every record of the shipped files and replaces (or
adds) only leg paths and canonical pairs that touch one of the stations.
Spliced leg-path ids get a "#cv3o9:" prefix so they cannot collide with the
shipped "#cv3:" ids.

Usage: python3 -I o9_splice_router.py <shipped corridor-v3 dir> <rerun out dir>
       <out dir> <station> [station ...]
"""
import json
import os
import sys


def main():
    shipped, rerun, out, stations = sys.argv[1], sys.argv[2], sys.argv[3], set(sys.argv[4:])
    touch = lambda r: r["from"] in stations or r["to"] in stations
    os.makedirs(out, exist_ok=True)

    lkey = lambda r: (r["train_no"] or r["code"], r["from"], r["to"])
    old = json.load(open(os.path.join(shipped, "leg_paths.json")))
    new = {lkey(r): r for r in json.load(open(os.path.join(rerun, "leg_paths.json"))) if touch(r)}
    ids = {}
    for r in new.values():
        ids.setdefault(r["id"], "#cv3o9:" + r["id"][len("#cv3:"):])
        r["id"] = ids[r["id"]]
    legs, dropped = [], 0
    for r in old:
        if touch(r):
            dropped += 1
            continue
        legs.append(r)
    legs.extend(new[k] for k in sorted(new))
    json.dump(legs, open(os.path.join(out, "leg_paths.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    print("leg_paths: %d shipped, %d touching %s replaced by %d from the rerun -> %d"
          % (len(old), dropped, "/".join(sorted(stations)), len(new), len(legs)))

    pp = json.load(open(os.path.join(shipped, "pair_paths_canonical.json")))
    rp = {(r["from"], r["to"]): r for r in json.load(open(os.path.join(rerun, "pair_paths_canonical.json")))["pairs"] if touch(r)}
    n = 0
    for i, r in enumerate(pp["pairs"]):
        k = (r["from"], r["to"])
        if k in rp:
            n += r != rp[k]
            pp["pairs"][i] = rp[k]
    json.dump(pp, open(os.path.join(out, "pair_paths_canonical.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    print("pair_paths_canonical: %d pairs touching the stations taken from the rerun, %d differ" % (len(rp), n))


main()
