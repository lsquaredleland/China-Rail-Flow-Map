#!/bin/bash
# stitch_pipeline.sh [grid_m=21660] [K=4] [stub_km=60] [tag=st3]
# The stitched national octi layout with a per-section mapping (see docs/OCTI.md):
#   partition.py (8 disjoint tiles of ~1500 sections)
#   -> per tile: convert2 --partition/--tile (sections cut at tile edges, shared 'cut' nodes)
#      + best of K detmalloc seeds + map_sections
#   -> stitch.py (one web-mercator frame, octilinear connectors, short stubs joined)
#   -> quality.py + validate_lines.py
. "$(dirname "$0")/env.sh"
g=${1:-21660}; K=${2:-4}; J=${3:-60}; tag=${4:-st3}
[ -f $W/tiles/part1500.json ] || python3 -I $SRC/partition.py $S $W/tiles/part1500.json 1500
$SRC/run_tiles.sh $W/tiles/part1500.json $g $K $tag
python3 -I $SRC/stitch.py $W/tiles/part1500.json $tag $S $W/out/stitch_${tag}_j$J $J
python3 -I $SRC/quality.py $W/out/stitch_${tag}_j$J.json $W/out/stitch_${tag}_j$J.map.json $W/tiles/t*.side.json
python3 -I $SRC/validate_lines.py $W/out/stitch_${tag}_j$J.json $W/out/stitch_${tag}_j$J.map.json $S
