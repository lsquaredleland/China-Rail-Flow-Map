//! Reading the v2 pack files (`atlas-v2-*.json`) from a directory, either
//! Brotli-compressed (`.json.br`, what ships in `web/public/assets`) or plain.

use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::Path;

/// Decompress a Brotli stream.
pub fn brotli_decode(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    brotli::Decompressor::new(bytes, 1 << 16)
        .read_to_end(&mut out)
        .expect("brotli decode");
    out
}

/// The text of pack file `name` (e.g. `atlas-v2-shared.json`) in `dir`:
/// `<name>.br` when present (the shipped form), else `<name>`.
pub fn read_text(dir: &Path, name: &str) -> String {
    let br = dir.join(format!("{name}.br"));
    if br.exists() {
        let raw = fs::read(&br).unwrap_or_else(|e| panic!("read {}: {e}", br.display()));
        String::from_utf8(brotli_decode(&raw))
            .unwrap_or_else(|e| panic!("{} is not UTF-8: {e}", br.display()))
    } else {
        let p = dir.join(name);
        fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
    }
}

/// Is pack file `name` in `dir`, as `<name>.br` or `<name>`?
pub fn exists(dir: &Path, name: &str) -> bool {
    dir.join(format!("{name}.br")).exists() || dir.join(name).exists()
}

/// [`read_text`] parsed as JSON.
pub fn read_json(dir: &Path, name: &str) -> Value {
    serde_json::from_str(&read_text(dir, name))
        .unwrap_or_else(|e| panic!("parse {name} in {}: {e}", dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pack-test-{tag}-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn br(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut w = brotli::CompressorWriter::new(&mut out, 4096, 5, 22);
            w.write_all(bytes).unwrap();
        }
        out
    }

    #[test]
    fn reads_brotli_and_plain() {
        let d = tmp("rw");
        fs::write(d.join("a.json.br"), br(br#"{"x":1}"#)).unwrap();
        fs::write(d.join("b.json"), r#"{"y":2}"#).unwrap();
        assert_eq!(read_json(&d, "a.json")["x"], 1);
        assert_eq!(read_json(&d, "b.json")["y"], 2);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn prefers_the_shipped_brotli_form() {
        let d = tmp("pref");
        fs::write(d.join("c.json"), r#"{"v":"plain"}"#).unwrap();
        fs::write(d.join("c.json.br"), br(br#"{"v":"br"}"#)).unwrap();
        assert_eq!(read_json(&d, "c.json")["v"], "br");
        fs::remove_dir_all(&d).ok();
    }
}
