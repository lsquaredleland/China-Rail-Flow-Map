# corridor-router

Per-train corridor inference on an OSM rail network: for every train leg
between consecutive stops, choose which track corridor it ran on, from
the schedule's running times. The recipe command and its inputs are in
`docs/PIPELINE.md` §3 step 5.

```
corridor-router --data ../data --files ../staging/inputs/output \
    --out <dir> --station-fixes ../data/station_fixes.json \
    [--osm <extract.osm>] [--config <router.toml>] [--threads <n>] \
    [--pair "A,B"] [--limit <n pairs>]
corridor-router --dump-config        # print the effective config as TOML
```

## Modules

`main.rs` only wires the stages together. Everything else is in the
library (`src/lib.rs`), which `src/bin/cordcheck.rs` uses too.

| Stage | Module | What it holds |
|---|---|---|
| **Inputs (seams)** | `schedule.rs` | `Train` / `Stop` (names normalised, times in minutes), the `ScheduleSource` trait, `travel_time`, `dwell` |
| | `stations.rs` | `Stations` (name to candidate points), `normalize_name`, `cluster`, `pick_points` |
| | `baseline.rs` | Optional production geometry: `Baseline { pairs, paths }` |
| | `graph.rs` | The network: OSM XML to graph (way filter, speeds, line names, stitching), snapping, A*, Dijkstra, reach |
| | `china.rs` | Today's datasets: `TimetableJson` (a `ScheduleSource`), `load_stations`, `load_baseline`, the `--data` / `--files` / `--osm` layout |
| **Policy** | `config.rs` | `Config`: every threshold and penalty, with documented defaults, TOML loading, `CV3_*` env overrides |
| | `classes.rs` | The service-class table (G/D/C/S/Z/T/K: speed caps, HSR access, routing groups) |
| **Routing + model** | `legs.rs` | Trains to legs, legs grouped by unordered pair, `PairInfo` per pair |
| | `candidates.rs` | `gen_candidates`: fastest per class, shortest, penalty alternatives, baseline |
| | `bridge.rs` | `min_gap_bridge`, `pick_bridge`: the smallest-gap bridge over unmapped track |
| | `evidence.rs` | `service_counts`: demonstrated corridors from stopping services |
| | `model.rs` | `Cand`, `Shape`, run-time model, `Calibration`, `emissions`, forward-backward `posteriors` |
| | `infer.rs` | Calibration samples, bridge selection, the per-train chains, calls `decide` |
| | `decide.rs` | `decide(obs, posteriors, cfg) -> Decision`: the pure decision policy, with its tests |
| | `canon.rs` | Canonical double-track-merged geometry (`best_for_canon` by `[canon] mode`, `redraw`, `canonical`) |
| | `validate.rs` | The hidden-stop self-check |
| **Outputs** | `output.rs` | Writers for `leg_routes.jsonl`, `leg_paths.json`, `pair_paths_canonical.json`, `candidates.json`, `bridges.json`, `validation_wrong_switches.jsonl`, `summary.json` |

Where the code was before this split:

- `main.rs`:
  - `gen_candidates` moved to `candidates.rs`.
  - `min_gap_bridge` and `pick_bridge` moved to `bridge.rs`.
  - `redraw`, `edge_usage` and the `best_for_canon` canonical-geometry
    selection moved to `canon.rs`.
  - `osm_segments`, `r1` and the write blocks moved to `output.rs`.
  - `service_counts` and `stop_point` moved to `evidence.rs` and
    `Stations::stop_point`.
  - `validate` moved to `validate.rs`.
  - `pick_points` moved to `stations.rs`.
  - The legs and pairs blocks moved to `legs.rs`.
  - The calibration, bridging and inference blocks moved to `infer.rs`.
  - The decision block moved to `decide.rs`.
  - The constants moved to `config.rs`.
- `inputs.rs` became `china.rs` (file formats), `schedule.rs`
  (`travel_time`, `dwell`, `parse_hhmm`), `stations.rs` (`clean`, now
  `normalize_name`) and `baseline.rs` (`PairRec`, `BasePaths`).
- `model.rs`:
  - The class table moved to `classes.rs` and is re-exported from `model`.
  - `Params` and `params()` became `config::ModelConfig` and
    `DecideConfig`. `model::params()` now returns the model section of the
    installed config.

## Configuration

`Config::default()` is the shipped China setup and reproduces the
corridor-v3-o17 run byte for byte. To change it:

- `--config router.toml` overrides any subset. Sections are `network`,
  `candidates`, `bridge`, `calibration`, `model`, `evidence`, `decide`
  and `canon`. Unknown keys are an error.
- The `CV3_*` environment variables still win over the file:
  `CV3_ACCEL`, `CV3_OVERHEAD`, `CV3_TAIL_TAU`, `CV3_LENGTH_PRIOR`,
  `CV3_SWITCH_POST`, `CV3_BASE_MAX`, `CV3_FILL_POST` and
  `CV3_SERVICE_PRIOR`.
- Start a file from `corridor-router --dump-config`.

```toml
[decide]
switch_post = 0.95      # stricter switches; everything else stays default

[network]
rail_values = ["rail", "light_rail"]
name_key = "name:en"
```

### Canonical geometry: `[canon] mode`

A pair's canonical geometry (`pair_paths_canonical.json`, after the
double-track redraw) is what the map draws for every leg that does not
draw its own path: every outcome except `switched`, `filled` and
`bridge-fix`. It also sets the track usage that those own paths are
redrawn onto.

| `mode` | Picks |
|---|---|
| `shortest` (default) | The shortest gap-free candidate, else production. The shipped corridor-v3-o17 behaviour. |
| `production` | Production's path when gap-free, else as `shortest`. |
| `hybrid` | As `production`, unless the pair's timetabled legs favour another gap-free candidate. |

The hybrid rule:

1. Each leg of the pair is scored with its own class's prediction, so
   the pair's class mix weights the evidence. Legs whose class cannot
   use production are left out. An alternative that some remaining
   leg's class cannot use is not eligible.
2. A candidate's error on a leg is how many minutes the timetable is
   faster than the candidate allows: `max(0, predict(c) * p5_c - t)`,
   where `p5_c` is the class's fast-edge scheduled/model ratio from
   calibration.
   - It is one-sided because a train can always run slower than its
     track allows (recovery time, overnight sleepers). A slow timetable
     is no evidence for a longer path.
   - It uses the fast edge, not the median, so ordinary spread and
     speed-tag error are no evidence either.
3. The best alternative has the lowest mean error, shortest on ties. It
   replaces production only if it beats production's mean error by
   at least `margin_min` minutes, AND by at least `margin_rel` of
   production's error, over at least `min_legs` legs.

The margin defaults (`margin_min = 1.0`, `margin_rel = 0.2`,
`min_legs = 1`) were picked on a train-hash tune/holdout split. They
only take effect in `hybrid` mode.

```toml
[canon]
mode = "hybrid"
```

`main` installs the config once (`config::install`). The run-time model
reads it through `model::params()`; every other stage takes its section
as an argument. Search plumbing stays as constants next to its code:
snap radii, grid cells, the 0.97 production-track discount, the
parallel-track hop and the KDE grid.

## Plugging in a new schedule

Implement `schedule::ScheduleSource`:

```rust
struct MyGtfs { dir: PathBuf }
impl ScheduleSource for MyGtfs {
    fn load(&self) -> Vec<Train> { /* trips -> Train { train_no, code, class, stops } */ }
}
```

The source must meet these rules:

- **Names:** each `Stop::name` goes through `stations::normalize_name`
  and matches a key in the `Stations` you build.
- **Times:** `arrive` and `depart` are minutes after midnight, `None`
  when not given. Times may wrap past midnight; `travel_time` handles
  the wrap.
- **Class:** `Train::class` is a string that `classes::class_index`
  maps. Unknown classes become the conventional K class.
- **Order:** trains come in a stable order, because outputs follow it.

Then replace the `china::TimetableJson::in_dir(&files).load()` line in
`main.rs`. If the new data still uses China's station names, keep
`china::load_stations` and `china::load_baseline`.

## Plugging in a different OSM network

The parts:

1. **Extract:** pass `--osm <file.osm>`, OSM XML in standard order, nodes
   before ways (as `osmium cat` or `pipeline/filter` write it).
2. **Tags and speeds:** set the `[network]` section:
   - which `way_key` / `rail_values` / `ferry_values` count as track;
   - the line-name tag;
   - the stitch radius (<= 1 km);
   - the speed defaults (all <= 350 km/h, which the A* bound assumes).
3. **Stations:** build a `Stations` (`Stations::new()` then
   `insert(normalize_name(name), points)`). For example, cluster OSM
   `railway=station` nodes with `stations::cluster`.
4. **Baseline:** use `Baseline::default()` when there is no production
   geometry. Every pair is then routed from scratch, and legs come out
   `filled` or `chord`. Nothing is "kept".
5. **Classes:** if the operator's classes differ from G/D/C/S/Z/T/K,
   edit `classes.rs`. The class count is compile-time because it sizes
   `Cand::run_min` and the `pred_min` columns.

## China-specific parts that remain

- **`classes.rs`:** a compile-time table, for the reason above.
- **`china.rs`:** file names and formats, including the dated
  deliverable names `china-rail-timetables-2026-10-21.json` and
  `china-rail-intercity-2026-10-28.json`.
- **Output field names:** `production`, `prod_status`, the `#cv3:` ids,
  and the `about` text of `pair_paths_canonical.json`. These are
  atlas.rs's contract.
- **`"bridged"`:** `infer::needs_bridge` keys on the analyzer's
  `"bridged"` pair status.

## Gate

Every refactor must leave the outputs unchanged. Run the recipe command
twice: once as is, and once with `--threads 1`. In both runs every file
except `summary.json` must be `cmp`-identical to
`staging/inputs/data/derived/corridor-v3-o17/`.
