//! Reading what the pipeline needs from an OSM XML extract (`osmium`-style
//! `<node .../>` / `<way>` elements, one attribute set per element): node
//! coordinates for a known id set, and the highspeed/conventional class and
//! line name of every rail edge. Language- and country-neutral, so it also works on an
//! arbitrary OSM rail network.

use crate::legs::{LegPathMap, PathMap};
use std::collections::{HashMap, HashSet};

/// Every node id the routed geometry touches: the pair paths plus, when
/// loaded, the per-leg router paths. The router (#cv3) leg paths run over
/// nodes outside the pair paths; without their coordinates those stretches
/// carry no flow and become chords.
pub fn needed_nodes(path_map: &PathMap, leg_paths: Option<&LegPathMap>) -> HashSet<i64> {
    let mut needed: HashSet<i64> = HashSet::new();
    for (_, segs) in path_map.values() {
        for s in segs {
            for id in s {
                needed.insert(*id);
            }
        }
    }
    for (segs, _) in leg_paths.into_iter().flat_map(|m| m.values()) {
        for s in segs {
            needed.extend(s.iter().copied());
        }
    }
    needed
}

/// `[lon, lat]` of every node in `needed`, by a byte scan for `<node `
/// elements (no XML parse: the extract is ~500 MB).
pub fn node_coords(data: &[u8], needed: &HashSet<i64>) -> HashMap<i64, [f64; 2]> {
    let mut coords: HashMap<i64, [f64; 2]> = HashMap::with_capacity(needed.len());
    let needle = b"<node ";
    let mut i = 0usize;
    let n = data.len();
    while i + 6 < n {
        if &data[i..i + 6] == needle {
            // tag ends at next '>'
            let mut end = i + 6;
            while end < n && data[end] != b'>' {
                end += 1;
            }
            let tag = &data[i..end];
            // Attribute value by name. The scan is anchored on the space
            // before the name (` id="`), so `uid="` or `xlat="` never match.
            let get_f64 = |key: &[u8]| -> Option<f64> {
                let mut k = 0;
                while k + key.len() + 3 <= tag.len() {
                    if tag[k] == b' '
                        && &tag[k + 1..k + 1 + key.len()] == key
                        && tag[k + 1 + key.len()] == b'='
                        && tag[k + 2 + key.len()] == b'"'
                    {
                        let start = k + key.len() + 3;
                        let len = tag[start..].iter().position(|&b| b == b'"')?;
                        return std::str::from_utf8(&tag[start..start + len])
                            .ok()?
                            .parse()
                            .ok();
                    }
                    k += 1;
                }
                None
            };
            if let (Some(idf), Some(lat), Some(lon)) =
                (get_f64(b"id"), get_f64(b"lat"), get_f64(b"lon"))
            {
                let id = idf as i64;
                if needed.contains(&id) {
                    coords.insert(id, [lon, lat]);
                }
            }
            i = end + 1;
        } else {
            i += 1;
        }
    }
    coords
}

/// Rail edges split by speed class, from the `<way>` elements.
pub struct WayClasses {
    /// Edges (sorted node-id pair) of ways tagged `highspeed=yes` or `maxspeed >= 200`.
    pub hsr_edges: HashSet<(i64, i64)>,
    /// Edges of every other `railway=rail|ferry` way.
    pub conv_edges: HashSet<(i64, i64)>,
    /// Nodes on any high-speed way.
    pub hsr_nodes: HashSet<i64>,
    /// Edge -> index into `lines`: the `name` of the first non-`service`
    /// rail way (file order) that runs over the edge.
    pub edge_line: HashMap<(i64, i64), u32>,
    /// Line names `(name, name:en)`, in order of first appearance; the
    /// English name is the one most of that name's ways carry ("" if none).
    pub lines: Vec<(String, String)>,
}

/// Classify every rail way of the extract (see [`WayClasses`]).
pub fn scan_ways(data: &[u8]) -> WayClasses {
    use quick_xml::events::{BytesStart, Event};
    use quick_xml::Reader;
    let attr = |e: &BytesStart, key: &[u8]| -> String {
        for a in e.attributes().flatten() {
            if a.key.as_ref() == key {
                return a
                    .unescape_value()
                    .map(|c| c.into_owned())
                    .unwrap_or_default();
            }
        }
        String::new()
    };
    let parse_speed = |v: &str| -> Option<f64> {
        let first = v.split([';', ',']).next()?.trim();
        let num: String = first
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        let x: f64 = num.parse().ok()?;
        let x = if first.ends_with("mph") { x * 1.609 } else { x };
        (5.0..=450.0).contains(&x).then_some(x)
    };
    let mut reader = Reader::from_reader(data);
    let mut buf: Vec<u8> = Vec::with_capacity(1 << 14);
    let mut in_way = false;
    let mut is_rail = false;
    let mut highspeed = false;
    let mut maxspeed: Option<f64> = None;
    let mut is_service = false;
    let mut name = String::new();
    let mut name_en = String::new();
    let mut refs: Vec<i64> = Vec::new();
    let mut edge_line: HashMap<(i64, i64), u32> = HashMap::new();
    let mut line_idx: HashMap<String, u32> = HashMap::new();
    let mut line_en: Vec<HashMap<String, u32>> = Vec::new();
    let mut hsr_edges: HashSet<(i64, i64)> = HashSet::new();
    let mut conv_edges: HashSet<(i64, i64)> = HashSet::new();
    let mut hsr_nodes: HashSet<i64> = HashSet::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if e.name().as_ref() == b"way" => {
                in_way = true;
                is_rail = false;
                highspeed = false;
                maxspeed = None;
                is_service = false;
                name.clear();
                name_en.clear();
                refs.clear();
            }
            Ok(Event::Empty(e)) if in_way && e.name().as_ref() == b"nd" => {
                if let Ok(r) = attr(&e, b"ref").parse::<i64>() {
                    refs.push(r);
                }
            }
            Ok(Event::Empty(e)) if in_way && e.name().as_ref() == b"tag" => {
                let k = attr(&e, b"k");
                let v = attr(&e, b"v");
                match k.as_str() {
                    "railway" if v == "rail" || v == "ferry" => is_rail = true,
                    "highspeed" if v == "yes" => highspeed = true,
                    "maxspeed" => maxspeed = parse_speed(&v),
                    "service" => is_service = true,
                    "name" => name = v.trim().to_string(),
                    "name:en" => name_en = v.trim().to_string(),
                    _ => {}
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"way" => {
                in_way = false;
                if is_rail && refs.len() >= 2 {
                    if !is_service && !name.is_empty() {
                        let li = *line_idx.entry(name.clone()).or_insert_with(|| {
                            line_en.push(HashMap::new());
                            (line_en.len() - 1) as u32
                        });
                        if !name_en.is_empty() {
                            *line_en[li as usize].entry(name_en.clone()).or_insert(0) += 1;
                        }
                        for w in refs.windows(2) {
                            edge_line.entry(edge_key(w[0], w[1])).or_insert(li);
                        }
                    }
                    let is_hsr = highspeed || maxspeed.is_some_and(|s| s >= 200.0);
                    if is_hsr {
                        for &id in &refs {
                            hsr_nodes.insert(id);
                        }
                        for w in refs.windows(2) {
                            let e = if w[0] < w[1] {
                                (w[0], w[1])
                            } else {
                                (w[1], w[0])
                            };
                            hsr_edges.insert(e);
                        }
                    } else {
                        for w in refs.windows(2) {
                            let e = if w[0] < w[1] {
                                (w[0], w[1])
                            } else {
                                (w[1], w[0])
                            };
                            conv_edges.insert(e);
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            // A parse error must not truncate the scan: every later way would
            // silently count as conventional.
            Err(e) => panic!(
                "OSM XML parse error at byte {}: {e}",
                reader.buffer_position()
            ),
            _ => {}
        }
        buf.clear();
    }
    let mut lines: Vec<(String, String)> = vec![Default::default(); line_idx.len()];
    for (nm, li) in line_idx {
        // most ways' English name; ties go to the alphabetically first
        let en = line_en[li as usize]
            .iter()
            .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
            .map(|(e, _)| e.clone())
            .unwrap_or_default();
        lines[li as usize] = (nm, en);
    }
    WayClasses {
        hsr_edges,
        conv_edges,
        hsr_nodes,
        edge_line,
        lines,
    }
}

/// Undirected edge key: the node-id pair, smaller first.
pub fn edge_key(a: i64, b: i64) -> (i64, i64) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6">
  <node id="1" visible="true" lat="30.0" lon="100.0"/>
  <node id="2" lat="31.0" lon="101.0"/>
  <node id="3" lat="32.0" lon="102.0"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/>
    <tag k="railway" v="rail"/><tag k="highspeed" v="yes"/>
    <tag k="name" v="京广高速线"/><tag k="name:en" v="Beijing–Guangzhou HSR"/>
  </way>
  <way id="11">
    <nd ref="2"/><nd ref="3"/>
    <tag k="railway" v="rail"/><tag k="maxspeed" v="120"/>
    <tag k="name" v="京广线"/>
  </way>
  <way id="12">
    <nd ref="3"/><nd ref="1"/>
    <tag k="railway" v="rail"/><tag k="maxspeed" v="250"/>
    <tag k="name" v="站线"/><tag k="service" v="siding"/>
  </way>
  <way id="13">
    <nd ref="1"/><nd ref="3"/>
    <tag k="highway" v="road"/>
  </way>
</osm>
"#;

    #[test]
    fn node_coords_reads_lon_lat_for_needed_ids_only() {
        let needed: HashSet<i64> = [1, 3].into_iter().collect();
        let c = node_coords(XML.as_bytes(), &needed);
        assert_eq!(c.len(), 2);
        assert_eq!(c[&1], [100.0, 30.0]);
        assert_eq!(c[&3], [102.0, 32.0]);
    }

    #[test]
    fn node_coords_does_not_mistake_uid_for_id() {
        // stock OSM exports carry uid="..." (before id= here, to catch a
        // substring match on `id="`)
        let xml = r#"<osm><node uid="9" id="2" lat="31.0" lon="101.0"/>
<node id="5" uid="7" lat="1.0" lon="2.0"/></osm>"#;
        let needed: HashSet<i64> = [2, 5, 9, 7].into_iter().collect();
        let c = node_coords(xml.as_bytes(), &needed);
        assert_eq!(c.len(), 2, "{c:?}");
        assert_eq!(c[&2], [101.0, 31.0]);
        assert_eq!(c[&5], [2.0, 1.0]);
    }

    #[test]
    #[should_panic(expected = "OSM XML parse error")]
    fn scan_ways_panics_on_malformed_xml() {
        let xml = r#"<osm><way id="1"><nd ref="1"/><nd ref="2"/></node><way id="2"/></osm>"#;
        scan_ways(xml.as_bytes());
    }

    #[test]
    fn scan_ways_splits_high_speed_from_conventional() {
        let w = scan_ways(XML.as_bytes());
        assert!(w.hsr_edges.contains(&(1, 2)));
        assert!(w.hsr_edges.contains(&(1, 3)), "maxspeed 250 is high speed");
        assert!(w.conv_edges.contains(&(2, 3)));
        assert!(!w.conv_edges.contains(&(1, 3)), "the road is not rail");
        assert_eq!(w.hsr_nodes.len(), 3);
    }

    #[test]
    fn scan_ways_names_edges_by_line_skipping_service_ways() {
        let w = scan_ways(XML.as_bytes());
        let line = |a, b| {
            w.edge_line
                .get(&edge_key(a, b))
                .map(|&i| w.lines[i as usize].clone())
        };
        assert_eq!(
            line(2, 1),
            Some(("京广高速线".into(), "Beijing–Guangzhou HSR".into()))
        );
        assert_eq!(line(2, 3), Some(("京广线".into(), String::new())));
        assert_eq!(line(1, 3), None, "a siding's name is not a line");
        assert_eq!(w.lines.len(), 2);
    }

    #[test]
    fn needed_nodes_unions_pair_paths_and_leg_paths() {
        let mut pm: PathMap = HashMap::new();
        pm.insert(
            ("a".into(), "b".into()),
            ("ok".into(), vec![vec![1, 2], vec![3]]),
        );
        let mut lp: LegPathMap = HashMap::new();
        lp.insert("x".into(), (vec![vec![4, 5]], 1.0));
        let n = needed_nodes(&pm, Some(&lp));
        assert_eq!(n, [1, 2, 3, 4, 5].into_iter().collect());
        assert_eq!(needed_nodes(&pm, None).len(), 3);
    }
}
