//! Shared library for the analyze pipeline binaries (`atlas`, `audit`, ...).
//!
//! Layout, generic first:
//! - `names`, `geo`, `polyline`: text, geometry and codec helpers.
//! - `timetable`: the timetable schema and clock arithmetic.
//! - `legs`: pair paths / router leg paths / overrides -> leg geometry.
//! - `osm`: reading node coordinates and way classes from an OSM XML extract.
//! - `inputs`: the recipe's input files (env-driven paths) loaded in one place.
//! - `chains`: station-chain canonicalization.
//! - `model`: output row types.
//! - `cn`: China-specific data (gazetteer, corrections, train classes).

pub mod chains;
pub mod cn;
pub mod geo;
pub mod inputs;
pub mod legs;
pub mod model;
pub mod names;
pub mod osm;
pub mod polyline;
pub mod timetable;
