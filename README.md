# China Rail Flow Map · 中国铁路流量图

An interactive, Minard-style passenger rail flow atlas across China's top 100 rail cities — rendering **11,248 scheduled passenger services** (running 23 Oct – 6 Nov 2026) across **48,000 km** of high-speed rail and **162,000 km** of total track on a deck.gl (WebGL2) renderer (zero map tile libraries, zero external API keys).

**Live Demo:** [china-rail-flow-map-web.vercel.app](https://china-rail-flow-map-web.vercel.app/)

---

## Features

- **Proportional Minard Flow Rendering**: Track section widths scale in proportion to scheduled trains/day (`0.06 px/train` at national fit, square-root compressed above 40 trains), decomposed into 9,106 outbound and 9,055 inbound atomic track sections.
- **National mode**: every train in the pack on one 24h clock (moving dots with tails and dwell rings), the national per-section flows and per-city circles that grow as the day runs, hour / distance / duration / class / train filters answered by a per-train index, a windowed table of all 11,248 trains, and a train timetable with "Play from origin" and single-train isolation. One component tree serves the origin and national views.
- **Exact City-Pair Chord Isolation**: Clicking any destination or source station dims non-connecting corridors and station dots while rendering the exact per-section volume of trains calling at that station (stopping cleanly at intermediate stops via per-call section cutoffs). Clicking the selected station a second time promotes it to the new origin city.
- **8-Class Dynamic Filtering (`G, D, C, S, Z, T, K, 普`)**: Filter both the map and timetables by any combination of train classes; unavailable classes for the active origin or city pair are automatically disabled.
- **2-Color HSR vs. Conventional Infrastructure Overlay**: Superimposes high-speed rail (`highspeed=yes` / `maxspeed >= 200 km/h`) and conventional rail centrelines over the proportional traffic bands.
- **Three Interactive Histograms**: Filter the departures/arrivals table by **hour of day**, **journey distance**, or **journey duration**, with hover count readouts and class-filter highlight overlays.
- **Staged Progressive Brotli Loading**: First paint transfers only the shared track geometry (`605 KB`) and active outbound map aggregates (`549 KB`) plus the lazily loaded deck.gl chunk (`233 KB`), streaming per-train tables, schedules and inbound flows in the background; the four national files (`1.8 MB`) load only on entering national mode.

---

## Repository Structure

```text
China-Rail-Flow-Map/
├── web/                  # React 19 + TypeScript + deck.gl 9.4 frontend (bundled with esbuild via node bundle.mjs)
│   ├── src/              # Application, deck.gl renderer (components/map/deck), pure lib/, histograms, timetable views
│   ├── public/assets/    # the pre-built Brotli data pack (atlas-v2-*.json.br / .safetensors.br + china-outline.json.br)
│   ├── tests/            # bun test (runs on the committed pack and samples)
│   ├── tools/            # dev tooling: static server, screenshot diff, perf drivers, headless smoke (CI)
│   └── bundle.mjs        # Produces web/dist/ (index.html with the entry inlined + hashed assets/)
├── pipeline/             # Unified Rust Cargo workspace for OSM & timetable processing
│   ├── analyze/          # Core graph router, section decomposition (atlas) & v2 packer (atlaspack)
│   ├── router/           # Corridor-v3 candidate path selector & speed/infrastructure scorer
│   ├── filter/           # Fast PBF -> railway-only OSM XML extractor
│   └── outline/          # National boundary polyline generator
├── data/                 # Station gazetteers (ZH/EN), OSM station coordinates & corridor overrides
└── docs/                 # PIPELINE.md (reproduction), PACK_FORMAT.md (tables container),
                          # THIN_CLIENT.md (pipeline/client split, partly built), research/ (routing evidence),
                          # history/ (finished plans, audits, reviews; DECKGL_MIGRATION.md holds the renderer
                          # decisions that code comments cite as C19, C23, D3, ...)
```

---

## Quickstart

### 1. Run the Web Application Locally

Requires [Bun](https://bun.sh/) and Node.js 22+ (the build and the dev tools run on Node):

```bash
cd web
bun install
bun run build
node tools/serve.mjs --dir dist --port 8766
```

Then open `http://localhost:8766`. The packs are served pre-compressed (`.json.br` with
`Content-Encoding: br`, as `vercel.json` configures the host); a generic static server such as
`python3 -m http.server` does not send that header, so the client's plain-`.json` fallback 404s
and the map reports that the data could not be loaded.

Checks: `bun run typecheck`, `bun test`, and `node tools/smoke.mjs dist` (headless WebGL boot,
the CI `web-smoke` job). Screenshot and perf drivers: `web/tools/shots/`, `web/tools/perf/`.

The data pack is committed, so the web app needs nothing beyond the repo.

### 2. Build & Test the Rust Data Pipeline

Requires a stable Rust toolchain.

```bash
cd pipeline
cargo test --workspace --release
cargo build --workspace --release
```

Tests, `audit --pack-only` (the CI pack check) and `secdiff --packs` run from a clone. A full
rebuild of the pack also needs inputs that are not in git: an OpenStreetMap China extract
(`data/osm/china-latest.osm.pbf`, from Geofabrik) and the timetable export under `data/raw/`.

See [`docs/PIPELINE.md`](docs/PIPELINE.md) for the complete end-to-end data pipeline documentation (OSM PBF extraction, `corridor-v3` routing, `atlas` section assembly, and `atlaspack` v2 compression).

### 3. Analytics (optional)

The build reads `GA_MEASUREMENT_ID` (a GA4 `G-…` id). With it set, the page loads gtag.js and
sends a few interaction events (`mode_switch`, `origin_select`, `direction_switch`,
`animation_play`, `class_filter`, `train_open`, `train_isolate`, `ui_toggle`; see
`web/src/lib/analytics.ts`). Without it, nothing is loaded or sent.

---

## Timetable Input Data Format

The committed pack is built from a merged train export (`data/raw/train-exports-2026-10-25/trains-all.json`, 11,589 trains with an operating calendar, window 23 Oct – 6 Nov 2026; the recipe is in [`docs/PIPELINE.md`](docs/PIPELINE.md), "Train export"). The pipeline's original and still-supported input is the 12306 snapshot format below: timetable snapshots stored as JSON Lines (`.jsonl`) under `data/raw/` (e.g. `data/raw/trains.jsonl` and `data/raw/stops.jsonl` for national trunk services, and `data/raw/stops_cs.jsonl` for intercity C/S services). `data/raw/` is not tracked in git.

### 1. Discovered Trains (`data/raw/trains.jsonl`)

Each line is a JSON object with train identity and schedule bounds:

```json
{"train_no":"26000K773102","code":"K7731","start":"GHP","end":"QTP","start_time":"00:22","arrive_time":"02:05","duration":"01:43"}
```

| Field | Type | Description |
|---|---|---|
| `code` | string (required) | Train service code (e.g. `G1`, `D312`, `C2001`, `S4791`, `K7731`). The initial character indicates class (`G, D, C, S, Z, T, K`, or numeric for conventional `普`). |
| `train_no` | string (optional) | Internal railway service identifier. |
| `start` | string (optional) | Origin station telecode. |
| `end` | string (optional) | Terminus station telecode. |
| `start_time` | string (optional) | Origin departure time string (`HH:MM`). |
| `arrive_time` | string (optional) | Terminus arrival time string (`HH:MM`). |
| `duration` | string (optional) | Total journey duration string (`HH:MM`). |

### 2. Stop Sequences & Schedules (`data/raw/stops.jsonl`)

Each line is a JSON object containing the complete calling sequence for a train service:

```json
{
  "train_no": "26000K773102",
  "code": "K7731",
  "start": "GHP",
  "end": "QTP",
  "date_used": "2026-10-21",
  "stops": [
    {
      "station_name": "冠县",
      "station_no": "01",
      "arrive_time": "----",
      "start_time": "16:39",
      "stopover_time": "----"
    },
    {
      "station_name": "广平",
      "station_no": "02",
      "arrive_time": "17:21",
      "start_time": "17:23",
      "stopover_time": "2分钟"
    },
    {
      "station_name": "秦皇岛",
      "station_no": "14",
      "arrive_time": "06:33",
      "start_time": "06:33",
      "stopover_time": "----"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `code` | string (required) | Display train service code matching `trains.jsonl`. |
| `train_no` | string (required) | Internal railway service identifier. |
| `date_used` | string (optional) | Date of timetable validity (`YYYY-MM-DD`). |
| `stops` | array of objects (required) | Ordered sequence of stations called at from origin to terminus. |

#### Stop Object Schema (`stops[i]`):

| Field | Type | Description |
|---|---|---|
| `station_name` | string (required) | Calling station name in Simplified Chinese (e.g. `北京南`, `上海虹桥`). Whitespace is normalized during matching. |
| `station_no` | string (required) | 2-digit 1-indexed sequential stop counter (`"01"`, `"02"`, ...). |
| `arrive_time` | string (required) | Scheduled arrival time in `"HH:MM"` (or `"----"` for the originating station). |
| `start_time` | string (required) | Scheduled departure time in `"HH:MM"` (or `"----"` for the terminating station). |
| `stopover_time` | string (optional) | Dwell duration string (e.g. `"2分钟"` or `"----"`). |

---

## Data Sources & Licensing

- **Code**: Licensed under the [MIT License](LICENSE).
- **Track Geometry**: Derived from [OpenStreetMap](https://www.openstreetmap.org/copyright) (© OpenStreetMap contributors) and licensed under the [Open Data Commons Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
- **Timetable Data**: Pre-compiled point-in-time timetable datasets (the train export and `data/raw/*.jsonl` snapshots, sourced from China Railway 12306) provide the schedule inputs; only aggregated flow sections and pre-packed atlas bundles (`web/public/assets/*.json.br`) are served for the interactive visualization.
