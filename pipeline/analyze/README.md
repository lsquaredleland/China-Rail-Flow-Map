# analyze-rs

The data-pack crate: timetable plus routed track geometry in, the atlas and
the v2 pack the web app fetches out. The recipe, inputs and gates are in
`docs/PIPELINE.md`; this file is only a map of the code.

## Library (`src/lib.rs`)

`lib.rs` has the module map in its header. In short: `timetable` / `export`
(schedule sources), `legs` / `chains` / `trainpath` (geometry per leg and per
train), `flows` / `entries` (the counting rules and national entry minutes),
`pack` / `packdiff` / `provenance` (reading, diffing and stamping the v2
pack), `model` (row types), `cn` (China-specific data).

## Binaries (`src/bin/`, plus `src/main.rs`)

| Bin | Does |
|---|---|
| `atlas` | Sections, flows and per-train tables from the routed legs (v1 combined JSON) |
| `atlaspack` | Packs v1 into the v2 files in `web/public/assets` (`.json` / `.json.br`) |
| `audit` | The gate: dropped chains 0, flow lost 0; `--pack-only` checks a committed pack (CI) |
| `secdiff` | Section-level diff between two atlas builds |
| `chainfill`, `legclass` | Post-passes for nonstop legs on parallel corridors |
| `paths`, `osm_export` | OSM node-path and PTv2/GTFS export (side products) |
| `main.rs` (`analyze-rs`) | The original single-pass station and distance analysis |

Run from `pipeline/`: `cargo run --release -p analyze-rs --bin <name>`.
