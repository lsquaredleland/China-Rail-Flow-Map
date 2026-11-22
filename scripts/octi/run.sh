#!/bin/bash
# run.sh <name> <timeout_s> <input.json> [octi flags...]  -> $W/out/<name>.json, appends to $W/runs.log
# env OCTI=path overrides the binary; OCTI_DET=1 preloads detmalloc (deterministic output).
# (DYLD_* must be set by env right before octi: SIP strips it across time/perl.)
. "$(dirname "$0")/env.sh"
B=${OCTI:-$W/build/octi}
name=$1; t=$2; in=$3; shift 3
/usr/bin/time -l perl -e 'alarm shift; exec @ARGV' "$t" ${OCTI_DET:+/usr/bin/env DYLD_INSERT_LIBRARIES=$W/detmalloc.dylib} "$B" "$@" < "$in" > "$W/out/$name.json" 2> "$W/out/$name.err"
rc=$?
w=$(grep -E ' real ' "$W/out/$name.err" | awk '{print $1}')
m=$(grep 'maximum resident' "$W/out/$name.err" | awk '{printf "%.0f", $1/1048576}')
echo "$name rc=$rc wall=${w}s rss=${m}MB in=$(basename $in) flags=[$*]" >> "$W/runs.log"
tail -1 "$W/runs.log"
