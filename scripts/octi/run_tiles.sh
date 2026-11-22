#!/bin/bash
# run_tiles.sh <partition.json> <grid_m> <K> <tag>   -> $W/out/<tag>_<tile>.json (+ .map.json)
. "$(dirname "$0")/env.sh"
P=$1; g=$2; K=$3; tag=$4
for t in $(python3 -I -c "import json;print(' '.join(x['name'] for x in json.load(open('$P'))))"); do
  python3 -I $SRC/convert2.py $S $W/tiles/$t.json $W/tiles/$t.side.json --partition $P --tile $t --tags --loops-as-node --split-parallel 2 2>/dev/null
  $SRC/best_of_seeds.sh ${tag}_$t $W/tiles/$t.json $K 2 -g $g | head -1
  python3 -I $SRC/map_sections.py $W/out/${tag}_$t.json $W/tiles/$t.side.json $S $W/out/${tag}_$t.map.json --quiet > $W/out/${tag}_$t.stats.json
done
