//! corridor-router as a library: per-train corridor inference on an OSM
//! rail network. See README.md for the module map and the seams.
//!
//! Inputs (seams):
//!   schedule   `ScheduleSource` -> trains, stops, times
//!   stations   name -> candidate points (`Stations`)
//!   baseline   optional production geometry (`Baseline`)
//!   graph      OSM extract -> rail graph (`NetworkConfig`)
//!   china      today's implementations of all four, plus the file layout
//!   export     a second schedule source: a train export with a calendar
//! Routing + model:
//!   legs, candidates, bridge, evidence, model, infer, decide, canon, validate
//! Outputs:
//!   output     the writers
//! Policy:
//!   config     every threshold and penalty; classes: the class table
pub mod baseline;
pub mod bridge;
pub mod candidates;
pub mod canon;
pub mod china;
pub mod classes;
pub mod config;
pub mod decide;
pub mod evidence;
pub mod export;
pub mod graph;
pub mod infer;
pub mod legs;
pub mod model;
pub mod output;
pub mod schedule;
pub mod stations;
pub mod validate;
