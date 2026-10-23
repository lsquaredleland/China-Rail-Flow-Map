#!/bin/bash
B=~/workspace/bench
run() {
  local name="$1"; shift
  local start end
  start=$(date +%s%N)
  "$@" > "$B/bench_$name.log" 2>&1
  local rc=$?
  end=$(date +%s%N)
  awk -v n="$name" -v s="$start" -v e="$end" -v r="$rc" 'BEGIN{printf "%s: %.1f s (exit %d)\n", n, (e-s)/1e9, r}' >> "$B/bench.log"
}
export PATH=$HOME/.cargo/bin:$PATH
{ echo "benchmark run $(date -Is)"; df -h ~ | tail -1; } > "$B/bench.log"
cd ~/workspace/china-rail/pipeline/analyze
run citypairs ./target/release/citypairs
run chengdu ./target/release/chengdu
run atlas ./target/release/atlas
run audit ./target/release/audit
cd ~/workspace/china-rail/pipeline/outline
run outline ./target/release/outline
cd ~/workspace/china-rail/pipeline/filter
run filter ./target/release/filter ~/workspace/china-rail/china-latest.osm.pbf ~/workspace/bench/bench-filter.osm
cd ~/workspace/china-rail/pipeline/tiler
run tiler ./target/release/tiler
cd ~/workspace/china-rail/pipeline/analyze
run paths ./target/release/paths --out ~/workspace/bench/bench_pair_paths.json
echo DONE >> "$B/bench.log"
