//! China-specific input file names (dated 12306 / GTFS dumps).

/// Timetable deliverables under the output dir, in train-table order. The
/// first file is the "national" set, the rest are appended.
pub const TIMETABLE_FILES: [&str; 2] = [
    "china-rail-timetables-2026-10-21.json",
    "china-rail-intercity-2026-10-28.json",
];
/// Station coordinate table (GTFS `stops.txt`) under the output dir.
pub const GTFS_STOPS: &str = "gtfs-2026-10-21/stops.txt";
/// Default OSM rail extract under the data dir (`CRFM_OSM_PATH` overrides).
pub const OSM_EXTRACT: &str = "osm/china-rail.osm";
