#!/bin/bash
# Usage: scripts/rebuild_pack.sh <out_dir> [--audit | --audit-only]
# Rebuilds the live pack into <out_dir> with the shipped recipe (docs/PIPELINE.md
# step 5): atlas -> atlaspack, then optionally the full audit with the goldens.
# --audit-only re-audits a pack already in <out_dir> (copy *.br there first).
# Inputs are the git-ignored local data: staging/inputs/data (CRFM_DATA_DIR,
# leg_overrides.json), data/raw/train-exports-2026-10-25 (the schedule) and the
# router outputs in $R (default staging/closeups/router; pass R=<dir> to use a
# fresh corridor-router run). Compare the result with
# `node scripts/cmp_pack.mjs web/public/assets <out_dir>`.
set -euo pipefail
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
MODE=${2:-}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
S=$ROOT/staging
X=$ROOT/data/raw/train-exports-2026-10-25
R=${R:-$S/closeups/router}
export CRFM_DATA_DIR=$S/inputs/data
export CRFM_OUTPUT_DIR=$S/inputs/output
export ATLAS_OVERRIDES=$S/inputs/data/leg_overrides.json
export CRFM_SCHEDULE=$X/trains-all.json
export CRFM_SCHEDULE_SUPPLEMENTS=$X/train-operating-days.json
export ATLAS_LEG_PATHS=$R/leg_paths.json
export ATLAS_PAIR_PATHS=$ROOT/data/pair_path_fixes.json,$R/pair_paths_canonical.json
cd "$ROOT/pipeline"
cargo build --release -q
cd analyze
if [ "$MODE" != "--audit-only" ]; then
  ATLAS_OUT=$OUT/china-flow-atlas-data.json ../target/release/atlas > "$OUT/atlas.log" 2>&1
  ../target/release/atlaspack --in "$OUT/china-flow-atlas-data.json" --out-dir "$OUT" > "$OUT/pack.log" 2>&1
fi
if [ "$MODE" = "--audit" ] || [ "$MODE" = "--audit-only" ]; then
  if AUDIT_PACK_DIR=$OUT ../target/release/audit --goldens "$ROOT/pipeline/goldens.json" > "$OUT/audit.log" 2>&1; then
    echo "audit PASS"
  else
    echo "audit FAIL"; tail -20 "$OUT/audit.log"; exit 1
  fi
fi
echo "built $OUT"
