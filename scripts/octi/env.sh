# Sourced by the octi scripts. SRC = this directory (committed code); W = work dir
# (git-ignored: LOOM build, inputs, octi outputs); S = the decoded shared pack.
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$SRC/../.." && pwd)
# default work dir: output/octi of the main checkout (shared by its worktrees)
MAIN=$(cd "$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
export OCTI_WORK=${OCTI_WORK:-$MAIN/output/octi}
W=$OCTI_WORK; S=$W/shared.json
mkdir -p "$W/out" "$W/tiles"
[ -f "$S" ] || brotli -dc "$ROOT/web/public/assets/atlas-v2-shared.json.br" > "$S"
[ -f "$W/detmalloc.dylib" ] || clang -O2 -dynamiclib -o "$W/detmalloc.dylib" "$SRC/detmalloc/detmalloc.c"
