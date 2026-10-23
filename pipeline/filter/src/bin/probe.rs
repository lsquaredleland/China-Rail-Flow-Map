// probe — forensic check: does the source PBF contain railway=rail ways
// in a bbox, and did those way ids survive into china-rail.osm?
// Usage: probe <lat_min> <lon_min> <lat_max> <lon_max>
use osmpbf::{Element, ElementReader};
use std::collections::{HashMap, HashSet};
use std::env;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    let (la0, lo0, la1, lo1): (f64, f64, f64, f64) = (
        args[1].parse()?,
        args[2].parse()?,
        args[3].parse()?,
        args[4].parse()?,
    );
    let input = "data/osm/china-latest.osm.pbf";
    // pass 1: node ids inside the bbox
    let mut inside: HashSet<i64> = HashSet::new();
    let reader = ElementReader::from_path(input)?;
    reader.for_each(|el| {
        let (id, lat, lon) = match el {
            Element::Node(n) => (n.id(), n.lat(), n.lon()),
            Element::DenseNode(n) => (n.id(), n.lat(), n.lon()),
            _ => return,
        };
        if lat >= la0 && lat <= la1 && lon >= lo0 && lon <= lo1 {
            inside.insert(id);
        }
    })?;
    println!("nodes in bbox: {}", inside.len());
    // pass 2: rail ways touching those nodes
    let mut ways: Vec<(i64, usize, String)> = Vec::new();
    let reader = ElementReader::from_path(input)?;
    reader.for_each(|el| {
        if let Element::Way(w) = el {
            let mut is_rail = false;
            let mut name = String::new();
            for (k, v) in w.tags() {
                if k == "railway" && v == "rail" {
                    is_rail = true;
                }
                if k == "name" {
                    name = v.to_string();
                }
            }
            if is_rail {
                let hits = w.refs().filter(|r| inside.contains(r)).count();
                if hits >= 2 {
                    ways.push((w.id(), hits, name));
                }
            }
        }
    })?;
    println!("rail ways in PBF touching bbox (>=2 nodes): {}", ways.len());
    // which of those way ids are present in the extract XML?
    let xml = std::fs::read_to_string("data/osm/china-rail.osm")?;
    let mut idset: HashSet<i64> = HashSet::new();
    for (id, _, _) in &ways {
        idset.insert(*id);
    }
    let mut present: HashMap<i64, bool> = HashMap::new();
    for line in xml.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("<way id=\"") {
            if let Some(end) = rest.find('"') {
                if let Ok(id) = rest[..end].parse::<i64>() {
                    if idset.contains(&id) {
                        present.insert(id, true);
                    }
                }
            }
        }
    }
    let mut missing = 0;
    for (id, hits, name) in &ways {
        let p = present.contains_key(id);
        if !p {
            missing += 1;
        }
        println!(
            "way {} ({} bbox nodes) name={:?} in_extract={}",
            id, hits, name, p
        );
    }
    println!("PBF rail ways missing from extract: {}", missing);
    Ok(())
}
