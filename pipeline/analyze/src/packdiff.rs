//! Diff of two v2 packs (`secdiff --packs <old_dir> <new_dir>`), rendered as
//! Markdown for a PR comment.
//!
//! Section ids are renumbered per pack, so everything is matched through the
//! section's polyline (`g`): a flow row is `(origin city, polyline)`, a train
//! path is the list of polylines it runs over. Trains are matched by
//! `(code, n-th occurrence of that code)` in `train_table`. The `shared.build`
//! provenance block is reported separately and ignored by the comparison.

use crate::pack;
use crate::polyline::decode_poly4;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::path::Path;

/// The six files the client loads, in load order.
pub const FILES: [&str; 6] = [
    "atlas-v2-shared.json",
    "atlas-v2-out-map.json",
    "atlas-v2-out-tables.json",
    "atlas-v2-in-map.json",
    "atlas-v2-in-tables.json",
    "atlas-v2-schedules.json",
];

pub struct PackFile {
    /// The `.br` bytes, when the pack was read from `.json.br`.
    pub br: Option<Vec<u8>>,
    /// Length of the decoded JSON text.
    pub raw_len: usize,
    pub json: Value,
}

pub struct Pack {
    pub files: BTreeMap<String, PackFile>,
}

/// Read every pack file in `dir` (`.json.br` preferred, else `.json`).
pub fn load(dir: &Path) -> Pack {
    let mut files = BTreeMap::new();
    for name in FILES {
        let br = std::fs::read(dir.join(format!("{name}.br"))).ok();
        let text = pack::read_text(dir, name);
        let json = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("parse {name} in {}: {e}", dir.display()));
        files.insert(
            name.to_string(),
            PackFile {
                br,
                raw_len: text.len(),
                json,
            },
        );
    }
    Pack { files }
}

impl Pack {
    fn j(&self, name: &str) -> &Value {
        &self.files[name].json
    }
}

/// Are all files byte-identical (as `.br` when both sides have it, else decoded)?
pub fn unchanged(a: &Pack, b: &Pack) -> bool {
    FILES.iter().all(|n| {
        let (x, y) = (&a.files[*n], &b.files[*n]);
        match (&x.br, &y.br) {
            (Some(p), Some(q)) => p == q,
            _ => x.json == y.json,
        }
    })
}

fn ints(v: &Value) -> Vec<i64> {
    v.as_array()
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}

fn len(v: &Value) -> usize {
    v.as_array().map_or(0, Vec::len)
}

/// Unique key per section: its polyline, `#k` for the k-th repeat.
fn sec_keys(list: &Value) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    list.as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            let g = s["g"].as_str().unwrap_or("").to_string();
            let n = seen.entry(g.clone()).or_insert(0);
            *n += 1;
            if *n == 1 {
                g
            } else {
                format!("{g}#{n}")
            }
        })
        .collect()
}

/// Per-train key: `code#occurrence`.
fn train_keys(shared: &Value) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    shared["train_table"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| {
            let c = t["code"].as_str().unwrap_or("").to_string();
            let n = seen.entry(c.clone()).or_insert(0);
            *n += 1;
            format!("{c}#{n}")
        })
        .collect()
}

type FlowKey = (String, String);

/// Origin city names, in origin order, from the out-map file.
fn origin_names(out_map: &Value) -> Vec<String> {
    out_map["origins"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|o| o["zh"].as_str().unwrap_or("").to_string())
        .collect()
}

/// `(origin zh, section key) -> [total, 8 class counts]` for one direction.
fn flow_rows(
    map: &Value,
    flows_key: &str,
    secs: &[String],
    names: &[String],
) -> HashMap<FlowKey, Vec<i64>> {
    let mut out = HashMap::new();
    for (oi, o) in map["origins"].as_array().into_iter().flatten().enumerate() {
        // in-map origins carry no identity fields: use the out-map's names
        let zh = o["zh"]
            .as_str()
            .map(String::from)
            .or_else(|| names.get(oi).cloned())
            .unwrap_or_default();
        let mut id = 0i64;
        for r in o[flows_key].as_array().into_iter().flatten() {
            let r = ints(r);
            if r.len() < 2 {
                continue;
            }
            id += r[0];
            let mut v = r[1..].to_vec();
            v.resize(9, 0);
            if let Some(k) = secs.get(id as usize) {
                out.insert((zh.clone(), k.clone()), v);
            }
        }
    }
    out
}

pub struct Top {
    pub origin: String,
    pub mid: [f64; 2],
    pub old: i64,
    pub new: i64,
}

#[derive(Default)]
pub struct FlowDiff {
    pub rows_old: usize,
    pub rows_new: usize,
    pub added: usize,
    pub removed: usize,
    pub changed: usize,
    /// Same total, different class split.
    pub class_changed: usize,
    pub sum_old: i64,
    pub sum_new: i64,
    pub sum_abs_delta: i64,
    pub top: Vec<Top>,
}

fn diff_flows(
    old: &HashMap<FlowKey, Vec<i64>>,
    new: &HashMap<FlowKey, Vec<i64>>,
    top_n: usize,
) -> FlowDiff {
    let mut d = FlowDiff {
        rows_old: old.len(),
        rows_new: new.len(),
        ..Default::default()
    };
    let mut keys: Vec<&FlowKey> = old.keys().chain(new.keys()).collect();
    keys.sort();
    keys.dedup();
    let mut tops: Vec<(i64, &FlowKey, i64, i64)> = Vec::new();
    for k in keys {
        let (o, n) = (old.get(k), new.get(k));
        let (ot, nt) = (o.map_or(0, |v| v[0]), n.map_or(0, |v| v[0]));
        d.sum_old += ot;
        d.sum_new += nt;
        match (o, n) {
            (None, Some(_)) => d.added += 1,
            (Some(_), None) => d.removed += 1,
            (Some(a), Some(b)) if a != b => {
                if ot != nt {
                    d.changed += 1;
                } else {
                    d.class_changed += 1;
                }
            }
            _ => {}
        }
        if ot != nt {
            d.sum_abs_delta += (nt - ot).abs();
            tops.push(((nt - ot).abs(), k, ot, nt));
        }
    }
    tops.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
    d.top = tops
        .into_iter()
        .take(top_n)
        .map(|(_, k, ot, nt)| {
            let g = k.1.split('#').next().unwrap_or("");
            let p = decode_poly4(g);
            let mid = p.get(p.len() / 2).copied().unwrap_or([0.0, 0.0]);
            Top {
                origin: k.0.clone(),
                mid,
                old: ot,
                new: nt,
            }
        })
        .collect();
    d
}

/// Per train: the polylines (and direction) its longest path runs over.
fn path_keys(
    tables: &Value,
    shared: &Value,
    secs_key: &str,
) -> HashMap<String, Vec<(String, bool)>> {
    let secs = sec_keys(&shared[secs_key]);
    let throats: Vec<&str> = shared["throats"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| t.as_str().unwrap_or(""))
        .collect();
    let n = secs.len() as i64;
    let tk = train_keys(shared);
    let mut out = HashMap::new();
    for (t, p) in tables["paths"].as_array().into_iter().flatten().enumerate() {
        let path: Vec<(String, bool)> = ints(p)
            .into_iter()
            .map(|v| {
                let (s, rev) = if v >= 0 { (v, false) } else { (!v, true) };
                let key = if s < n {
                    secs[s as usize].clone()
                } else {
                    format!("T:{}", throats.get((s - n) as usize).copied().unwrap_or(""))
                };
                (key, rev)
            })
            .collect();
        if let Some(k) = tk.get(t) {
            out.insert(k.clone(), path);
        }
    }
    out
}

#[derive(Default)]
pub struct KeyedDiff {
    pub old: usize,
    pub new: usize,
    pub changed: usize,
    pub only_old: usize,
    pub only_new: usize,
}

fn diff_keyed<T: PartialEq>(old: &HashMap<String, T>, new: &HashMap<String, T>) -> KeyedDiff {
    let mut d = KeyedDiff {
        old: old.len(),
        new: new.len(),
        ..Default::default()
    };
    for (k, v) in old {
        match new.get(k) {
            None => d.only_old += 1,
            Some(w) if w != v => d.changed += 1,
            _ => {}
        }
    }
    d.only_new = new.keys().filter(|k| !old.contains_key(*k)).count();
    d
}

fn schedules_by_train(p: &Pack) -> HashMap<String, &Value> {
    let tk = train_keys(p.j(FILES[0]));
    p.j(FILES[5])["schedules"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(t, s)| tk.get(t).map(|k| (k.clone(), s)))
        .collect()
}

fn without_build(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(o) = v.as_object_mut() {
        o.remove("build");
    }
    v
}

fn fmt_i(n: i64) -> String {
    let s = n.abs().to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 {
        format!("-{out}")
    } else {
        out
    }
}

fn arrow(a: usize, b: usize) -> String {
    if a == b {
        fmt_i(a as i64)
    } else {
        format!(
            "{} -> {} ({:+})",
            fmt_i(a as i64),
            fmt_i(b as i64),
            b as i64 - a as i64
        )
    }
}

/// Markdown summary of `old` -> `new`; `top_n` biggest flow changes per direction.
pub fn render(old: &Pack, new: &Pack, top_n: usize) -> String {
    let mut s = String::new();
    if unchanged(old, new) {
        let _ = writeln!(
            s,
            "No pack changes: all {} files are byte-identical.",
            FILES.len()
        );
        return s;
    }
    let _ = writeln!(s, "| file | old raw | new raw | old br | new br | result |");
    let _ = writeln!(s, "|---|--:|--:|--:|--:|---|");
    for n in FILES {
        let (a, b) = (&old.files[n], &new.files[n]);
        let same_bytes = match (&a.br, &b.br) {
            (Some(p), Some(q)) => p == q,
            _ => a.json == b.json,
        };
        let decoded_same = if n == FILES[0] {
            without_build(&a.json) == without_build(&b.json)
        } else {
            a.json == b.json
        };
        let result = if same_bytes {
            "identical"
        } else if a.json == b.json {
            "same content, recompressed"
        } else if decoded_same {
            "only `build` provenance differs"
        } else {
            "**changed**"
        };
        let br = |f: &PackFile| {
            f.br.as_ref()
                .map_or("-".to_string(), |v| fmt_i(v.len() as i64))
        };
        let _ = writeln!(
            s,
            "| `{n}` | {} | {} | {} | {} | {result} |",
            fmt_i(a.raw_len as i64),
            fmt_i(b.raw_len as i64),
            br(a),
            br(b)
        );
    }

    let (so, sn) = (old.j(FILES[0]), new.j(FILES[0]));
    if so["fmt"] != sn["fmt"] {
        let _ = writeln!(
            s,
            "\nPack format differs (fmt {} -> {}); the structural comparison is skipped.",
            so["fmt"], sn["fmt"]
        );
        return s;
    }
    let (bo, bn) = (&so["build"], &sn["build"]);
    if bo != bn {
        let _ = writeln!(s, "\n**Build provenance**");
        let keys: std::collections::BTreeSet<&str> = bo
            .as_object()
            .into_iter()
            .chain(bn.as_object())
            .flat_map(|o| o.keys().map(String::as_str))
            .collect();
        for k in keys {
            if bo[k] != bn[k] {
                let short = |v: &Value| match v.as_str() {
                    Some(x) if x.len() > 12 => format!("`{}`", &x[..12]),
                    Some(x) => format!("`{x}`"),
                    None if v.is_null() => "none".to_string(),
                    None => format!("`{v}`"),
                };
                let _ = writeln!(s, "- `{k}`: {} -> {}", short(&bo[k]), short(&bn[k]));
            }
        }
    }

    let _ = writeln!(s, "\n**Shared geometry**\n");
    let _ = writeln!(s, "| | count |\n|---|---|");
    for k in [
        "sections",
        "in_sections",
        "throats",
        "network",
        "train_table",
        "station_table",
        "city_table",
    ] {
        let _ = writeln!(s, "| {k} | {} |", arrow(len(&so[k]), len(&sn[k])));
    }

    for (label, map_file, flows_key, secs_key) in [
        ("Outbound", FILES[1], "flows", "sections"),
        ("Inbound", FILES[3], "in_flows", "in_sections"),
    ] {
        let fo = flow_rows(
            old.j(map_file),
            flows_key,
            &sec_keys(&so[secs_key]),
            &origin_names(old.j(FILES[1])),
        );
        let fnw = flow_rows(
            new.j(map_file),
            flows_key,
            &sec_keys(&sn[secs_key]),
            &origin_names(new.j(FILES[1])),
        );
        let d = diff_flows(&fo, &fnw, top_n);
        let _ = writeln!(
            s,
            "\n**{label} flows**: {} -> {} rows ({} added, {} removed, {} total changed, {} class split only); \
             sum of trains/day {} -> {}, sum |change| {}",
            fmt_i(d.rows_old as i64),
            fmt_i(d.rows_new as i64),
            d.added,
            d.removed,
            d.changed,
            d.class_changed,
            fmt_i(d.sum_old),
            fmt_i(d.sum_new),
            fmt_i(d.sum_abs_delta)
        );
        for t in &d.top {
            let _ = writeln!(
                s,
                "- {} near ({:.3}, {:.3}): {} -> {}",
                t.origin, t.mid[0], t.mid[1], t.old, t.new
            );
        }
    }

    for (label, file, secs_key) in [
        ("Outbound", FILES[2], "sections"),
        ("Inbound", FILES[4], "in_sections"),
    ] {
        let po = path_keys(old.j(file), so, secs_key);
        let pn = path_keys(new.j(file), sn, secs_key);
        let d = diff_keyed(&po, &pn);
        let _ = writeln!(
            s,
            "\n**{label} train paths**: {} -> {} trains; {} changed, {} only in old, {} only in new",
            d.old, d.new, d.changed, d.only_old, d.only_new
        );
    }

    let (sa, sb) = (schedules_by_train(old), schedules_by_train(new));
    let d = diff_keyed(&sa, &sb);
    let _ = writeln!(
        s,
        "\n**Schedules**: {} -> {} trains; {} changed, {} only in old, {} only in new",
        d.old, d.new, d.changed, d.only_old, d.only_new
    );
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file(v: Value) -> PackFile {
        PackFile {
            br: None,
            raw_len: v.to_string().len(),
            json: v,
        }
    }

    /// A one-origin pack: sections `gs`, flows `(section, total)`, build `b`.
    fn mini(gs: &[&str], flows: &[(usize, i64)], build: Value, path: &[i64]) -> Pack {
        let secs: Vec<Value> = gs.iter().map(|g| json!({ "g": g })).collect();
        let mut prev = 0i64;
        let rows: Vec<Value> = flows
            .iter()
            .map(|&(s, t)| {
                let r = json!([s as i64 - prev, t, t]);
                prev = s as i64;
                r
            })
            .collect();
        let mut shared = json!({
            "fmt": 6, "sections": secs, "in_sections": [], "throats": [],
            "network": [], "station_table": [], "city_table": [],
            "train_table": [{"code": "G1", "class": "G"}],
        });
        if !build.is_null() {
            shared["build"] = build;
        }
        let mut files = BTreeMap::new();
        files.insert(FILES[0].to_string(), file(shared));
        files.insert(
            FILES[1].to_string(),
            file(json!({"fmt": 6, "origins": [{"zh": "甲", "flows": rows}]})),
        );
        files.insert(
            FILES[2].to_string(),
            file(json!({"fmt": 6, "paths": [path], "origins": []})),
        );
        files.insert(FILES[3].to_string(), file(json!({"fmt": 6, "origins": []})));
        files.insert(
            FILES[4].to_string(),
            file(json!({"fmt": 6, "paths": [[]], "origins": []})),
        );
        files.insert(
            FILES[5].to_string(),
            file(json!({"schedules": [[[0, 1, 2, 0, 5.0]]]})),
        );
        Pack { files }
    }

    #[test]
    fn identical_packs_say_so_and_nothing_else() {
        let a = mini(&["x", "y"], &[(0, 3), (1, 4)], Value::Null, &[0, 1]);
        let b = mini(&["x", "y"], &[(0, 3), (1, 4)], Value::Null, &[0, 1]);
        assert!(unchanged(&a, &b));
        assert!(render(&a, &b, 5).starts_with("No pack changes"));
    }

    #[test]
    fn section_renumbering_alone_is_not_a_change() {
        // same polylines and flows, sections listed in the other order
        let a = mini(&["x", "y"], &[(0, 3), (1, 4)], Value::Null, &[0, 1]);
        let b = mini(&["y", "x"], &[(0, 4), (1, 3)], Value::Null, &[1, 0]);
        let md = render(&a, &b, 5);
        assert!(md.contains("0 added, 0 removed, 0 total changed"), "{md}");
        assert!(
            md.contains("Outbound train paths**: 1 -> 1 trains; 0 changed"),
            "{md}"
        );
    }

    #[test]
    fn flow_changes_are_counted_and_ranked() {
        let gs = ["??", "_p~iF~ps|U", "_ulLnnqC_mqNvxq`@"];
        let a = mini(&gs, &[(0, 3), (1, 4)], Value::Null, &[0]);
        let b = mini(&gs, &[(0, 10), (2, 1)], Value::Null, &[0]);
        let names = origin_names(a.j(FILES[1]));
        let fo = flow_rows(
            a.j(FILES[1]),
            "flows",
            &sec_keys(&a.j(FILES[0])["sections"]),
            &names,
        );
        let fnw = flow_rows(
            b.j(FILES[1]),
            "flows",
            &sec_keys(&b.j(FILES[0])["sections"]),
            &names,
        );
        let d = diff_flows(&fo, &fnw, 5);
        assert_eq!((d.added, d.removed, d.changed), (1, 1, 1));
        assert_eq!((d.sum_old, d.sum_new, d.sum_abs_delta), (7, 11, 7 + 4 + 1));
        assert_eq!(d.top[0].old, 3);
        assert_eq!(d.top[0].new, 10);
    }

    #[test]
    fn a_changed_path_is_reported() {
        let a = mini(&["x", "y"], &[(0, 3)], Value::Null, &[0, 1]);
        let b = mini(&["x", "y"], &[(0, 3)], Value::Null, &[0, !1]);
        let md = render(&a, &b, 5);
        assert!(
            md.contains("Outbound train paths**: 1 -> 1 trains; 1 changed"),
            "{md}"
        );
    }

    #[test]
    fn build_only_difference_is_labelled() {
        let a = mini(
            &["x"],
            &[(0, 3)],
            json!({"commit": "aaaaaaaaaaaaaaaa"}),
            &[0],
        );
        let b = mini(
            &["x"],
            &[(0, 3)],
            json!({"commit": "bbbbbbbbbbbbbbbb"}),
            &[0],
        );
        let md = render(&a, &b, 5);
        assert!(md.contains("only `build` provenance differs"), "{md}");
        assert!(
            md.contains("`commit`: `aaaaaaaaaaaa` -> `bbbbbbbbbbbb`"),
            "{md}"
        );
        assert!(md.contains("0 added, 0 removed, 0 total changed"), "{md}");
    }

    #[test]
    fn a_format_change_skips_the_structural_diff() {
        let a = mini(&["x"], &[(0, 3)], Value::Null, &[0]);
        let mut b = mini(&["x"], &[(0, 3)], Value::Null, &[0]);
        b.files.get_mut(FILES[0]).unwrap().json["fmt"] = json!(7);
        let md = render(&a, &b, 5);
        assert!(md.contains("Pack format differs (fmt 6 -> 7)"), "{md}");
        assert!(!md.contains("Outbound flows"), "{md}");
    }

    #[test]
    fn in_map_rows_are_attributed_to_the_out_map_origin() {
        let out = json!({"origins": [{"zh": "甲"}, {"zh": "乙"}]});
        let inm = json!({"origins": [{"in_flows": [[0, 5, 5]]}, {"in_flows": [[0, 7, 7]]}]});
        let rows = flow_rows(&inm, "in_flows", &["a".to_string()], &origin_names(&out));
        assert_eq!(rows[&("甲".to_string(), "a".to_string())][0], 5);
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn thousands_separators() {
        assert_eq!(fmt_i(0), "0");
        assert_eq!(fmt_i(1234567), "1,234,567");
        assert_eq!(fmt_i(-4200), "-4,200");
    }
}
