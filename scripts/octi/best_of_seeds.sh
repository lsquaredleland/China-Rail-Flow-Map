#!/bin/bash
# best_of_seeds.sh <name> <input.json> <K> <P> [octi flags...]
# Runs octi K times with detmalloc seeds 1..K (P at a time), each reproducible, and keeps the
# lowest total score as $W/out/<name>.json. Topology violations cost 100000 each in octi's
# score; a winding edge (drawn > 150 km and > 3x the straight line between its ends, i.e. an
# octi detour) is charged the same here. Columns: score, violations, seed, winding edges.
. "$(dirname "$0")/env.sh"
name=$1; in=$2; K=$3; P=$4; shift 4
seq 1 $K | xargs -P $P -I{} env OCTI_DET=1 DETMALLOC_SEED={} "$SRC/run.sh" ${name}_s{} 1500 $in --write-stats "$@" > /dev/null
best=$(for s in $(seq 1 $K); do python3 -I -c "
import json
import math
def km(a, b): return math.hypot((a[0] - b[0]) * 111.32 * math.cos(math.radians((a[1] + b[1]) / 2)), (a[1] - b[1]) * 110.57)
try:
    j = json.load(open('$W/out/${name}_s$s.json')); d = j['properties']['statistics']['scores']; wind = 0
    for f in j['features']:
        c = f['geometry']['coordinates']
        if f['geometry']['type'] != 'LineString': continue
        L = sum(km(c[i], c[i + 1]) for i in range(len(c) - 1))
        if L > 150 and L > 3 * km(c[0], c[-1]): wind += 1
    print(d['total-score'] + 100000 * wind, d['topo-violations'], $s, wind)
except Exception: print(1e18, -1, $s, -1)"; done | tee $W/out/$name.seeds.txt | sort -g | head -1 | awk '{print $3}')
cp $W/out/${name}_s$best.json $W/out/$name.json
echo "$name best seed $best"; cat $W/out/$name.seeds.txt
