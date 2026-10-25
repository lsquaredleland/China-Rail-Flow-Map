//! Shared library for the analyze pipeline binaries (`atlas`, `audit`, ...).
//!
//! Layout, generic first:
//! - `names`, `geo`, `polyline`: text, geometry and codec helpers.
//! - `timetable`: the timetable schema and clock arithmetic.
//! - `legs`: pair paths / router leg paths / overrides -> leg geometry.
//! - `osm`: reading node coordinates and way classes from an OSM XML extract.
//! - `inputs`: the recipe's input files (env-driven paths) loaded in one place.
//! - `chains`: station-chain canonicalization.
//! - `flows`: the static-flow counting rule (per-train edge sets) and the
//!   national per-section table.
//! - `trainpath`: joining a train's path stretches into its whole path.
//! - `pack`, `packdiff`: reading the v2 pack files and diffing two packs.
//! - `provenance`: the build block (`shared.build`) recorded in the pack.
//! - `model`: output row types.
//! - `cn`: China-specific data (gazetteer, corrections, train classes).

pub mod chains;
pub mod cn;
pub mod flows;
pub mod geo;
pub mod inputs;
pub mod legs;
pub mod model;
pub mod names;
pub mod osm;
pub mod pack;
pub mod packdiff;
pub mod polyline;
pub mod provenance;
pub mod timetable;
pub mod trainpath;
