//! Optional baseline ("production") geometry the router improves on.
//!
//! Per unordered station pair: the production chord / track / status
//! records and the production path as OSM node-id segments. Decisions
//! keep this geometry unless the evidence is decisive. A network with no
//! baseline uses `Baseline::default()`: every pair is then routed from
//! scratch (`filled` / `chord` decisions only). `china::load_baseline`
//! reads the analyzer's pair_distances.json / pair_paths.json.
use crate::legs::Key;
use std::collections::HashMap;

/// One production pair record (directed, as pair_distances stores it).
pub struct PairRec {
    pub chord: f64,
    pub track: Option<f64>,
    pub status: String,
    pub gap: Option<f64>,
}

/// Base geometry: unordered pair -> (status, OSM node-id segments in
/// key.0 -> key.1 direction).
pub type BasePaths = HashMap<Key, (String, Vec<Vec<u64>>)>;

#[derive(Default)]
pub struct Baseline {
    /// Unordered name pair -> production records (one per direction; two
    /// different chords mean the names denote two different station pairs).
    pub pairs: HashMap<Key, Vec<PairRec>>,
    pub paths: BasePaths,
}
