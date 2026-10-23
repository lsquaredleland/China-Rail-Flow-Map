# corridor-v3 — per-train corridor routing (STAGING, not applied)

Built 2026-10-22. Nothing here touches the live data in `output/`, the
original app in `china-rail-flow-map/`, or the production pipeline's
behaviour: `atlas`/`audit` gained an `ATLAS_LEG_PATHS` switch that is a
no-op when unset (control run: 0 changed atomic edges, 0 per-origin
summary changes vs the live rebuild). **Swap only on the owner's go-ahead.**

## What changed in the design

Production draws every train between two consecutive stops on one stored
geometry per station pair, chosen by shortest path plus ratio/speed audits.
`router/` (Rust crate `corridor-router`) instead decides **per train leg**:

1. Rail graph with OSM `maxspeed` (84% of main-line ways tagged),
   `highspeed`, `usage`, `service`, line `name`; same 250 m stitching.
2. Candidate corridors per pair: fastest per class group, shortest,
   up to 3 penalty-diversified alternatives, plus production's geometry.
   "Same corridor" is geometric (within 150 m), so double track is ONE
   corridor everywhere: distinctness, merging with production, the
   diversification penalty, and the map redraw (step 7).
3. Run-time model: per edge, min(limit, class cap, braking curve
   v = sqrt(2·a·d) to the nearer stop). Scheduled/model ratio learned per
   class from ~50k legs whose corridor is undisputed.
4. Evidence per leg = learned run-time likelihood (fast side strict, slow
   side fat-tailed: padding is common, outrunning a corridor is not)
   + length prior + **demonstrated-corridor prior**: how stopping
   services of the same class group between the same two stations
   route (their intermediate stops show the corridor; 71k spans).
5. Per train, consecutive legs linked by a reversal penalty (short
   dwell + heading flip), forward-backward posterior per leg.
6. Leave production only on decisive evidence (posterior >= 0.9 and
   production's <= 0.05). Pairs production draws as chords get a track
   path when one corridor is >= 0.8 likely.
7. Map redraw: a chosen corridor is redrawn within 200 m of itself on
   the track carrying the most production train-legs, so re-routed
   trains join the drawn line instead of the other track.
8. Bridging: smallest plausible gap, starting at a dangling track end
   (production minimised total length, which picked the largest allowed
   straight-line shortcut — 917/952 gaps sat at ~10 km).

## Double track merged (the "thin cord inside a thick cord")

Cause, measured between 荣昌北 and 大足南: the Chengyu HSR is two OSM
ways ~6 m apart joined only at stations. Production routes each station
pair independently and the two tracks tie, so long pairs (成都东→重庆*,
内江北→重庆*: the nonstop / limited-stop trains) landed on one track
(68 Chengdu trains) and short station-to-station pairs (stopping
trains) on the other (28). The atlas counts per physical edge, so one
line became two sections, the thinner drawn on top of the wider. Same
at station loops (隆昌北 68 + 19). Present in the live build; not
router-made.

Fix (staged): `out/pair_paths_canonical.json` — every production pair
path redrawn within 200 m of itself onto the busiest track, allowed to
hop (<= 30 m) between parallel ways of the SAME named line (distinct
lines such as an HSR beside a conventional line never merge); 4 rounds
re-weighting by usage. Consumed by atlas.rs/audit.rs via
`ATLAS_PAIR_PATHS` (no-op when unset). Result: 荣昌北–大足南 is one
96-train section (97 with the router's switches); 内江北/隆昌北 one
line (a 1.8 km, 10-train loop inside 内江北 station remains, under the
dot). Widest sections grow where tracks merge: Chengdu 133 → 145,
石家庄 133 → 166, 38 of 100 origins up. A few widest values that were
2–3 km station-throat stubs drop slightly (上饶 95 → 70: its throat
splits across station tracks), invisible at map scale. Builds:
`atlas-canon/` (merge only), `atlas-v3/` (merge + router).

## Self-check (hide a stopping train's intermediate stop; which corridor?)

6,922 tests (leave-one-out for the service prior):

| | correct |
|---|---|
| production geometry | 84.3% |
| shortest path | 80.6% |
| router's top choice | 97.2% |
| **what v3 ships** (production + decisive switches) | **94.0%** |
| switch precision | 93.1% (1,170 / 1,257) |

Caveat: tests are stopping trains, which the service prior knows well;
true nonstop legs get only same-class stopping evidence. Remaining wrong
switches: rare-routing D trains (D981/D985 via the southern loop),
short urban hops (东莞/广州新塘), long Xinjiang legs.

## Effect on the atlas (staged build `atlas-v3/`)

- Decisions over 74,411 legs: production 55,721 · switched 5,764 ·
  bridge-fix 4,691 · filled (chord → track) 627 · ambiguous-keep 6,808 ·
  chord 277 · infeasible-keep 285 · other 238.
- Audit gate: dropped chains 0, flow lost 0.
- Chord legs over all 100 origins 478 → 228; fully-tracked departures
  28,305 → 28,830 of 29,864.
- (Figures in this section are router-only, before the double-track
  merge; with the merge Chengdu widest becomes 145, see above.)
- Goldens: Chengdu outbound 564 / 610 / widest 133 unchanged, fully
  tracked 544 → 561, chords 8 → 4; Chengdu↔Chongqing 136/53/62 min
  unchanged; top-100 cut unchanged. **Changed: Chengdu inbound widest
  111 → 108** (five westbound D trains moved to the northern route).
- Widest-corridor parallel splits (`splitcheck`): 9/100 origins, now
  real separate lines — e.g. 无锡: production drew conventional K/Z/T
  trains on the 沪宁城际 HSR; v3 puts them on the parallel 京沪线.

## Chengdu ↔ Chongqing

- All G/D nonstops 62–90 min: Chengyu HSR (unchanged).
- D951, D2208, D5128 east + D2236, D2242, D2373, D361, D952 west
  (113–115 min) → northern route (沪蓉线 via 遂宁), posterior ~0.99.
  Live spot check of D2208 (2026-10-28): nonstop 成都东 08:02 →
  重庆北 09:56, ¥96 2nd class = northern fare band — agrees.
- D846/D848/D862/D864 (118–123 min, 重庆西): ambiguous, kept on
  Chengyu (posterior 0.25 — the southern loop is the competing
  explanation; needs evidence).
- G3355 (109 min): kept on Chengyu.

## Speed

Whole router: **~20 s** wall (incl. 5 s canonical redraw) on 14 cores (graph 4.9 s, candidates
7.6 s, everything else < 2 s), 1.9 GB peak. Parameter sweeps via env
vars (`CV3_*`, documented in `router/src/model.rs`) and `./sweep.sh`.

## Files

- `router/` — the crate (`cargo build --release`); also `splitcheck`
  (parallel-split detector) and `cordcheck` (explains nested cords at a
  point: sections, separation, track nodes, which pairs use which track).
  rustfmt clean, clippy 0 warnings, unit tests pass.
- `out/` — `leg_routes.jsonl` (every leg's decision), `leg_paths.json`
  (ATLAS_LEG_PATHS input), `candidates.json`, `bridges.json`,
  `summary.json`, `validation_wrong_switches.jsonl`.
- `atlas-control/`, `atlas-v3/` (+ `pack/`) — staged atlas builds, logs,
  secdiff/edge diffs.
- `web-v3/`, `web-v3.html` — the flow map on v3 data (merge + router);
  `web-canon/`, `web-canon.html` — double-track merge only;
  `web-baseline/`, `web-baseline.html` — same app on the live rebuild.
- `spot_check.mjs`, `spot_D2208_2026-10-28.json` — the one-train
  12306 check. `live_check.log` — log of an aborted bulk pull (stopped
  at the owner's request; no data kept).

## Rebuild

```bash
cd project/staging/corridor-v3
(cd router && cargo build --release)
./router/target/release/corridor-router --out out
R=../../pipeline/analyze/target/release
ATLAS_OVERRIDES=$PWD/../../data/no_overrides.json \
ATLAS_PAIR_PATHS=$PWD/out/pair_paths_canonical.json \
ATLAS_LEG_PATHS=$PWD/out/leg_paths.json \
ATLAS_OUT=$PWD/atlas-v3/china-flow-atlas-data.json $R/atlas
$R/audit            # same env
$R/atlaspack --in atlas-v3/china-flow-atlas-data.json --out-dir atlas-v3/pack
python3 -I make_web.py atlas-v3/pack web-v3 "corridor-v3 staging"
```

## Open follow-ups

- 郑州东→新乡东: 43 trains switched from 京广高速 to the parallel
  济郑高速 approach — likely the same corridor under two line names;
  check before any swap.
- Distinct-name parallel lines sharing one formation (e.g. 京广高速 /
  济郑高速 out of 郑州东) are not merged by the same-name hop rule.
