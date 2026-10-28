//! Build provenance: which code and which input files produced a pack.
//!
//! `atlas` computes the block and writes it into the v1 JSON; `atlaspack`
//! copies it to `shared.build`; `audit` prints it. The client ignores it.
//!
//! ```json
//! { "pipeline_tree": "<tree hash of pipeline/ at HEAD>", "dirty": true,
//!   "osm_sha256": "...", "leg_paths_sha256": "...",
//!   "pair_paths_sha256": "...", "overrides_sha256": "..." }
//! ```
//!
//! `pair_paths_sha256` hashes the pair-path files concatenated in priority
//! order (`ATLAS_PAIR_PATHS`). A hash is `null` when its input is absent.
//! A build from a train export (`CRFM_SCHEDULE`) adds `schedule_sha256`:
//! the export, then its supplements, concatenated.
//!
//! `pipeline_tree` is `HEAD:pipeline`'s tree hash, so it changes only when
//! pipeline code does (a docs-only commit leaves the pack bytes alone).
//! `dirty: true` is present only when `pipeline/` has uncommitted changes
//! (tracked or untracked, not ignored); the key is omitted when clean.
//! `CRFM_PIPELINE_TREE` overrides the tree (builds outside a git checkout).
//!
//! `shared.about` (train-export builds, next to `shared.calendar`; optional,
//! packs without it still load) is a pack fact for the page footer:
//! `{ "source": "<sentence naming the source and the window>", "from":
//! "YYYY-MM-DD", "to": "YYYY-MM-DD" }`, derived from the calendar by
//! [`about_block`]. `atlaspack` writes it and `audit` recomputes it.

use crate::inputs::{pair_path_files, Inputs};
use crate::legs::leg_paths_file;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;

/// Lower-case hex SHA-256.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 of the files' bytes concatenated in order; `None` if any is missing.
pub fn sha256_files(paths: &[PathBuf]) -> Option<String> {
    let mut h = Sha256::new();
    for p in paths {
        h.update(std::fs::read(p).ok()?);
    }
    Some(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Tree hash of `pipeline/` at HEAD (`CRFM_PIPELINE_TREE` overrides), or
/// `"unknown"`.
pub fn pipeline_tree() -> String {
    if let Ok(c) = std::env::var("CRFM_PIPELINE_TREE") {
        return c;
    }
    git(&["rev-parse", "HEAD:pipeline"]).unwrap_or_else(|| "unknown".to_string())
}

/// Does `pipeline/` have uncommitted changes? (`:/pipeline` is relative to
/// the repository root, so the working directory does not matter.)
pub fn pipeline_dirty() -> bool {
    git(&["status", "--porcelain", "--", ":/pipeline"]).is_some_and(|s| !s.is_empty())
}

/// The `build` block for the inputs this run read.
pub fn build_block(inp: &Inputs) -> Value {
    let leg = leg_paths_file(&inp.paths.data_dir);
    let pair = pair_path_files(&inp.paths.data_dir);
    let mut b = json!({
        "pipeline_tree": pipeline_tree(),
        "osm_sha256": sha256_hex(&inp.osm_data),
        "leg_paths_sha256": sha256_files(&[leg]),
        "pair_paths_sha256": sha256_files(&pair),
        "overrides_sha256": sha256_files(std::slice::from_ref(&inp.paths.overrides_path)),
    });
    let closeups = inp.paths.data_dir.join("closeup_stations.json");
    if closeups.exists() {
        b["closeups_sha256"] = json!(sha256_files(&[closeups]));
    }
    if let Ok(p) = std::env::var("CRFM_SCHEDULE") {
        let mut files = vec![PathBuf::from(p)];
        if let Ok(v) = std::env::var("CRFM_SCHEDULE_SUPPLEMENTS") {
            files.extend(v.split(',').map(PathBuf::from));
        }
        b["schedule_sha256"] = json!(sha256_files(&files));
    }
    if pipeline_dirty() {
        b["dirty"] = json!(true);
    }
    b
}

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// "23 October" (no year) or "23 October 2026" of an ISO date.
fn long_date(iso: &str, year: bool) -> Option<String> {
    let mut it = iso.split('-');
    let y: u32 = it.next()?.parse().ok()?;
    let m: usize = it.next()?.parse().ok()?;
    let d: u32 = it.next()?.parse().ok()?;
    let month = MONTHS.get(m.checked_sub(1)?)?;
    Some(if year {
        format!("{d} {month} {y}")
    } else {
        format!("{d} {month}")
    })
}

/// `shared.about` for a train-export pack: the timetable source sentence and
/// the schedule window, both derived from `calendar` (ISO dates in order).
/// `None` for an empty or malformed calendar.
pub fn about_block(calendar: &[String]) -> Option<Value> {
    let (from, to) = (calendar.first()?, calendar.last()?);
    let same_year = from.get(..4) == to.get(..4);
    let window = if from == to {
        format!("on {}", long_date(from, true)?)
    } else {
        format!(
            "from {} to {}",
            long_date(from, !same_year)?,
            long_date(to, true)?
        )
    };
    Some(json!({
        "source": format!(
            "Timetable data is sourced from China Railway (12306), covering the passenger trains listed as running on at least one date {window}."
        ),
        "from": from,
        "to": to,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cal(a: &str, b: &str) -> Vec<String> {
        vec![a.to_string(), "2026-10-24".to_string(), b.to_string()]
    }

    #[test]
    fn about_block_names_the_window() {
        let a = about_block(&cal("2026-10-23", "2026-11-06")).unwrap();
        assert_eq!(
            a["source"],
            "Timetable data is sourced from China Railway (12306), covering the passenger trains listed as running on at least one date from 23 October to 6 November 2026."
        );
        assert_eq!(a["from"], "2026-10-23");
        assert_eq!(a["to"], "2026-11-06");
        let a = about_block(&cal("2026-12-30", "2027-01-02")).unwrap();
        assert!(a["source"]
            .as_str()
            .unwrap()
            .ends_with("from 30 December 2026 to 2 January 2027."));
        let a = about_block(&["2026-10-23".to_string()]).unwrap();
        assert!(a["source"]
            .as_str()
            .unwrap()
            .ends_with("date on 23 October 2026."));
        assert!(about_block(&[]).is_none());
        assert!(about_block(&["x".to_string()]).is_none());
    }

    #[test]
    fn sha256_matches_the_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_files_concatenates_in_order_and_needs_every_file() {
        let d = std::env::temp_dir().join(format!("prov-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let (a, b) = (d.join("a"), d.join("b"));
        std::fs::write(&a, "ab").unwrap();
        std::fs::write(&b, "c").unwrap();
        assert_eq!(
            sha256_files(&[a.clone(), b.clone()]),
            Some(sha256_hex(b"abc"))
        );
        assert_ne!(
            sha256_files(&[b.clone(), a.clone()]),
            Some(sha256_hex(b"abc"))
        );
        assert_eq!(sha256_files(&[a, d.join("missing")]), None);
        std::fs::remove_dir_all(&d).ok();
    }
}
