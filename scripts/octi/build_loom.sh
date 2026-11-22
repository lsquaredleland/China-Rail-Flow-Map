#!/bin/bash
# Fetch and build LOOM's octi (and topo/loom/transitmap) at a pinned commit.
# LOOM is GPL-3.0: it is run as an external offline tool and never linked into or
# committed to this repo. Its output (layout data) is what we keep.
# usage: scripts/octi/build_loom.sh [workdir]   (default: output/octi, git-ignored)
# needs: brew install cmake glpk boost
set -euo pipefail
LOOM_REV=1e4757838104d1e4d22186c9b77d5fc4b98681a0   # 2026-07-24
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=${1:-$ROOT/output/octi}
mkdir -p "$W"
if [ ! -d "$W/src/.git" ]; then
  git clone -q https://github.com/ad-freiburg/loom.git "$W/src"
fi
git -C "$W/src" fetch -q origin
git -C "$W/src" checkout -q "$LOOM_REV"
git -C "$W/src" submodule update -q --init --recursive
mkdir -p "$W/build"
cmake -S "$W/src" -B "$W/build" -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/opt/homebrew >/dev/null
make -C "$W/build" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" octi topo loom transitmap
echo "built: $W/build/octi"
