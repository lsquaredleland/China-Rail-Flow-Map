//! Service classes: how a train's class string maps to running speed,
//! high-speed-line access and routing group.
//!
//! This table is China's (G/D/C/S/Z/T/K). It is compile-time because the
//! class count sizes per-candidate arrays (`Cand::run_min`) and the
//! `pred_min` columns of `candidates.json`. Another network with other
//! classes edits this file: names, caps, conventional flags, groups and
//! `class_index` (the schedule source's class string -> index).
use crate::graph::Metric;

pub const NCLASS: usize = 7;
pub const CLASS_NAMES: [&str; NCLASS] = ["G", "D", "C", "S", "Z", "T", "K"];
/// Top running speed (km/h) per class.
pub const CAP: [f64; NCLASS] = [350.0, 250.0, 350.0, 200.0, 160.0, 140.0, 120.0];
/// Classes barred from dedicated high-speed lines.
pub const CONVENTIONAL: [bool; NCLASS] = [false, false, false, false, true, true, true];

/// Routing groups for the demonstrated-corridor prior: classes the
/// operator routes alike (350 EMU, 250 EMU, intercity S, conventional).
pub const NGROUP: usize = 4;

pub fn class_group(c: usize) -> usize {
    match c {
        0 | 2 => 0,
        1 => 1,
        3 => 2,
        _ => 3,
    }
}

pub fn class_index(class: &str) -> usize {
    match class {
        "G" => 0,
        "D" => 1,
        "C" => 2,
        "S" => 3,
        "Z" => 4,
        "T" => 5,
        _ => 6, // K, Y, plain numbered trains
    }
}

/// Search metric for the fastest route of class `c`.
pub fn class_metric(c: usize) -> Metric {
    Metric::Time {
        cap: CAP[c],
        hsr_mult: if CONVENTIONAL[c] { 8.0 } else { 1.0 },
    }
}
