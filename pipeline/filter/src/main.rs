use osmpbf::{Element, ElementReader};
use rustc_hash::FxHashSet;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::time::Instant;

const INPUT: &str = "data/osm/china-latest.osm.pbf";
const OUTPUT: &str = "data/osm/china-rail.osm";

fn has_railway_tag(mut tags: impl Iterator<Item = (impl AsRef<str>, impl AsRef<str>)>) -> bool {
    tags.any(|(k, _)| k.as_ref() == "railway")
}

fn is_rail_relation(tags: impl Iterator<Item = (impl AsRef<str>, impl AsRef<str>)>) -> bool {
    let mut rail = false;
    let mut route = false;
    for (k, v) in tags {
        let (k, v) = (k.as_ref(), v.as_ref());
        if k == "railway" {
            rail = true;
        }
        if k == "railway" {
            rail = true;
        }
        if k == "route"
            && matches!(
                v,
                "train" | "subway" | "light_rail" | "tram" | "monorail" | "railway"
            )
        {
            route = true;
        }
    }
    rail || route
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            _ => o.push(c),
        }
    }
    o
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // optional args: filter [input.pbf] [output.osm] (defaults: the consts)
    let argv: Vec<String> = std::env::args().collect();
    let input: String = argv.get(1).cloned().unwrap_or_else(|| INPUT.to_string());
    let output: String = argv.get(2).cloned().unwrap_or_else(|| OUTPUT.to_string());
    let t0 = Instant::now();

    // ---- Pass 1: ways -> kept ways + referenced node ids; relations -> kept rels ----
    let mut kept_ways: FxHashSet<i64> = FxHashSet::default();
    let mut extra_ways: FxHashSet<i64> = FxHashSet::default(); // relation members
    let mut kept_rels: FxHashSet<i64> = FxHashSet::default();
    let mut node_ids: Vec<i64> = Vec::new();
    let mut n_ways = 0u64;
    let mut n_rels = 0u64;

    let reader = ElementReader::from_path(&input)?;
    reader.for_each(|el| match el {
        Element::Way(w) => {
            if has_railway_tag(w.tags()) {
                kept_ways.insert(w.id());
                node_ids.extend(w.refs());
                n_ways += 1;
            }
        }
        Element::Relation(r) if is_rail_relation(r.tags()) => {
            kept_rels.insert(r.id());
            for m in r.members() {
                use osmpbf::RelMemberType;
                match m.member_type {
                    RelMemberType::Way => {
                        extra_ways.insert(m.member_id);
                    }
                    RelMemberType::Node => {
                        node_ids.push(m.member_id);
                    }
                    RelMemberType::Relation => {}
                }
            }
            n_rels += 1;
        }
        _ => {}
    })?;
    // remove already-kept ways from the extra set
    for id in kept_ways.iter() {
        extra_ways.remove(id);
    }
    println!(
        "pass1: kept {} railway ways, {} rail relations, {} extra member ways ({:.1}s)",
        n_ways,
        n_rels,
        extra_ways.len(),
        t0.elapsed().as_secs_f64()
    );

    // ---- Pass 2: resolve node ids for extra member ways ----
    let t1 = Instant::now();
    if !extra_ways.is_empty() {
        let reader = ElementReader::from_path(&input)?;
        reader.for_each(|el| {
            if let Element::Way(w) = el {
                if extra_ways.contains(&w.id()) {
                    node_ids.extend(w.refs());
                }
            }
        })?;
    }
    kept_ways.extend(extra_ways.iter().copied());
    println!(
        "pass2: resolved member-way nodes ({:.1}s)",
        t1.elapsed().as_secs_f64()
    );

    // sort + dedup node ids for binary search (memory-light)
    let t2 = Instant::now();
    node_ids.sort_unstable();
    node_ids.dedup();
    println!(
        "node index: {} unique node ids ({:.1}s)",
        node_ids.len(),
        t2.elapsed().as_secs_f64()
    );

    // ---- Pass 3: write filtered OSM XML ----
    let t3 = Instant::now();
    let out = File::create(&output)?;
    let mut w = BufWriter::new(out);
    writeln!(w, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>")?;
    writeln!(w, "<osm version=\"0.6\" generator=\"china-rail-filter\">")?;

    let mut c_nodes = 0u64;
    let mut c_ways = 0u64;
    let mut c_rels = 0u64;
    let reader = ElementReader::from_path(&input)?;
    reader.for_each(|el| match el {
        Element::Node(n) => {
            let keep = node_ids.binary_search(&n.id()).is_ok() || has_railway_tag(n.tags());
            if keep {
                write!(
                    w,
                    "  <node id=\"{}\" lat=\"{:.7}\" lon=\"{:.7}\"",
                    n.id(),
                    n.lat(),
                    n.lon()
                )
                .unwrap();
                let tags: Vec<_> = n.tags().collect();
                if tags.is_empty() {
                    writeln!(w, "/>").unwrap();
                } else {
                    writeln!(w, ">").unwrap();
                    for (k, v) in tags {
                        writeln!(w, "    <tag k=\"{}\" v=\"{}\"/>", esc(k), esc(v)).unwrap();
                    }
                    writeln!(w, "  </node>").unwrap();
                }
                c_nodes += 1;
            }
        }
        Element::DenseNode(n) => {
            let keep = node_ids.binary_search(&n.id()).is_ok() || has_railway_tag(n.tags());
            if keep {
                write!(
                    w,
                    "  <node id=\"{}\" lat=\"{:.7}\" lon=\"{:.7}\"",
                    n.id(),
                    n.lat(),
                    n.lon()
                )
                .unwrap();
                let tags: Vec<_> = n.tags().collect();
                if tags.is_empty() {
                    writeln!(w, "/>").unwrap();
                } else {
                    writeln!(w, ">").unwrap();
                    for (k, v) in tags {
                        writeln!(w, "    <tag k=\"{}\" v=\"{}\"/>", esc(k), esc(v)).unwrap();
                    }
                    writeln!(w, "  </node>").unwrap();
                }
                c_nodes += 1;
            }
        }
        Element::Way(way) => {
            if kept_ways.contains(&way.id()) {
                write!(w, "  <way id=\"{}\">", way.id()).unwrap();
                let tags: Vec<_> = way.tags().collect();
                if way.refs().next().is_none() && tags.is_empty() {
                    writeln!(w, "/>").unwrap();
                } else {
                    writeln!(w).unwrap();
                    for r in way.refs() {
                        writeln!(w, "    <nd ref=\"{}\"/>", r).unwrap();
                    }
                    for (k, v) in tags {
                        writeln!(w, "    <tag k=\"{}\" v=\"{}\"/>", esc(k), esc(v)).unwrap();
                    }
                    writeln!(w, "  </way>").unwrap();
                }
                c_ways += 1;
            }
        }
        Element::Relation(r) => {
            if kept_rels.contains(&r.id()) {
                writeln!(w, "  <relation id=\"{}\">", r.id()).unwrap();
                for m in r.members() {
                    let t = match m.member_type {
                        osmpbf::RelMemberType::Node => "node",
                        osmpbf::RelMemberType::Way => "way",
                        osmpbf::RelMemberType::Relation => "relation",
                    };
                    writeln!(
                        w,
                        "    <member type=\"{}\" ref=\"{}\" role=\"{}\"/>",
                        t,
                        m.member_id,
                        esc(m.role().unwrap_or(""))
                    )
                    .unwrap();
                }
                for (k, v) in r.tags() {
                    writeln!(w, "    <tag k=\"{}\" v=\"{}\"/>", esc(k), esc(v)).unwrap();
                }
                writeln!(w, "  </relation>").unwrap();
                c_rels += 1;
            }
        }
    })?;
    writeln!(w, "</osm>")?;
    w.flush()?;
    println!(
        "pass3: wrote {} nodes, {} ways, {} relations ({:.1}s)",
        c_nodes,
        c_ways,
        c_rels,
        t3.elapsed().as_secs_f64()
    );
    println!("TOTAL {:.1}s", t0.elapsed().as_secs_f64());
    Ok(())
}
