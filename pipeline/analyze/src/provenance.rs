//! Build provenance: which code and which input files produced a pack.
//!
//! `atlas` computes the block and writes it into the v1 JSON; `atlaspack`
//! copies it to `shared.build`; `audit` prints it. The client ignores it.
//!
//! ```json
//! { "commit": "<git HEAD, +dirty if tracked files are modified>",
//!   "osm_sha256": "...", "leg_paths_sha256": "...",
//!   "pair_paths_sha256": "...", "overrides_sha256": "..." }
//! ```
//!
//! `pair_paths_sha256` hashes the pair-path files concatenated in priority
//! order (`ATLAS_PAIR_PATHS`). A hash is `null` when its input is absent.
//! `CRFM_BUILD_COMMIT` overrides the commit (builds outside a git checkout).

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

/// The code revision: `CRFM_BUILD_COMMIT`, else `git rev-parse HEAD` in the
/// working directory (suffixed `+dirty` when tracked files are modified),
/// else `"unknown"`.
pub fn commit() -> String {
    if let Ok(c) = std::env::var("CRFM_BUILD_COMMIT") {
        return c;
    }
    match git(&["rev-parse", "HEAD"]) {
        Some(h)
            if git(&["status", "--porcelain", "--untracked-files=no"])
                .is_some_and(|s| s.is_empty()) =>
        {
            h
        }
        Some(h) => format!("{h}+dirty"),
        None => "unknown".to_string(),
    }
}

/// The `build` block for the inputs this run read.
pub fn build_block(inp: &Inputs) -> Value {
    let leg = leg_paths_file(&inp.paths.data_dir);
    let pair = pair_path_files(&inp.paths.data_dir);
    json!({
        "commit": commit(),
        "osm_sha256": sha256_hex(&inp.osm_data),
        "leg_paths_sha256": sha256_files(&[leg]),
        "pair_paths_sha256": sha256_files(&pair),
        "overrides_sha256": sha256_files(std::slice::from_ref(&inp.paths.overrides_path)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
