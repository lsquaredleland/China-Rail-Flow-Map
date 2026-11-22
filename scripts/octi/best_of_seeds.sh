#!/bin/bash
# best_of_seeds.sh <name> <input.json> <K> <P> [octi flags...]
# Runs octi K times with detmalloc seeds 1..K (P at a time), each reproducible, and keeps the
# lowest total score (topology violations cost 100000 each) as $W/out/<name>.json.
. "$(dirname "$0")/env.sh"
name=$1; in=$2; K=$3; P=$4; shift 4
seq 1 $K | xargs -P $P -I{} env OCTI_DET=1 DETMALLOC_SEED={} "$SRC/run.sh" ${name}_s{} 1500 $in --write-stats "$@" > /dev/null
best=$(for s in $(seq 1 $K); do python3 -I -c "
import json
try: d=json.load(open('$W/out/${name}_s$s.json'))['properties']['statistics']['scores']; print(d['total-score'], d['topo-violations'], $s)
except Exception: print(1e18, -1, $s)"; done | tee $W/out/$name.seeds.txt | sort -g | head -1 | awk '{print $3}')
cp $W/out/${name}_s$best.json $W/out/$name.json
echo "$name best seed $best"; cat $W/out/$name.seeds.txt
