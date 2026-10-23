// chainfill — corridor inference for nonstop legs, as a post-pass over
// pair_distances.json.
//
// A pair (A,B) that some train runs nonstop can be mis-routed by
// distance-only A* when parallel corridors exist (the Chengdu–Chongqing
// nonstops via Suiyu-vs-Chengyu problem). Heuristic: the fastest service
// that DOES stop between A and B reveals the corridor the fast trains use.
// Sum that service's consecutive sub-pair track distances (each already
// routed and audited) to get the pair's track distance.
//
// A chain is applied when it passes sanity checks (ratio vs chord,
// implied speed vs the fastest nonstop timing, stopping-service duration
// vs nonstop duration) and either repairs a flagged/unroutable pair or
// disagrees with the direct A* distance by >4%. Applied pairs get
// status "via_chain" with the evidence recorded in chain_* fields; the
// original status is kept in prev_status.
use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

#[derive(Deserialize)]
struct TrainRec {
    code: String,
    stops: Vec<RawStop>,
}
#[derive(Deserialize)]
struct RawStop {
    station_name: String,
    arrive_time: String,
    start_time: String,
}

fn to_min(t: &str) -> Option<i64> {
    if t.is_empty() || t == "----" {
        return None;
    }
    let mut it = t.split(':');
    let h: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    Some(h * 60 + m)
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}
fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

struct Chain {
    duration_min: i64,
    train: String,
    via: Vec<String>,            // intermediate stop names
    subs: Vec<(String, String)>, // consecutive sub-pair name keys
}

fn main() {
    let data_dir = if let Ok(d) = env::var("CRFM_DATA_DIR") {
        PathBuf::from(d)
    } else if PathBuf::from("data").exists() {
        PathBuf::from("data")
    } else {
        PathBuf::from("../data")
    };
    let pairs_path = env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("derived/pair_distances.json"));
    let stops_path = env::args()
        .nth(2)
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("raw/stops.jsonl"));

    let mut doc: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&pairs_path).unwrap()).unwrap();
    let pairs = doc["pairs"].as_array().unwrap().clone();

    // name-key index; skip name keys that map to >1 geographic pair
    let mut idx_of: HashMap<(String, String), usize> = HashMap::new();
    let mut dup_keys: Vec<(String, String)> = Vec::new();
    for (i, p) in pairs.iter().enumerate() {
        let k = (
            p["from"].as_str().unwrap().to_string(),
            p["to"].as_str().unwrap().to_string(),
        );
        if idx_of.insert(k.clone(), i).is_some() {
            dup_keys.push(k);
        }
    }
    for k in &dup_keys {
        idx_of.remove(k);
    }
    let target: std::collections::HashSet<(String, String)> = idx_of.keys().cloned().collect();
    println!(
        "pairs: {} ({} name-keyed targets, {} duplicate name keys skipped)",
        pairs.len(),
        target.len(),
        dup_keys.len()
    );

    // usable track distance for a sub-pair (ok / bridged only)
    let usable = |k: &(String, String)| -> Option<f64> {
        let i = idx_of.get(k)?;
        let p = &pairs[*i];
        match p["status"].as_str()? {
            "ok" | "bridged" | "ferry" => p["track_km"].as_f64(),
            _ => None,
        }
    };

    // ---- scan all trains for the fastest stopping service per target pair ----
    let text = fs::read_to_string(&stops_path).unwrap();
    let mut best_chain: HashMap<(String, String), Chain> = HashMap::new();
    let mut n_trains = 0usize;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let tr: TrainRec = match serde_json::from_str(line) {
            Ok(t) => t,
            Err(_) => continue,
        };
        n_trains += 1;
        // absolute minutes per stop (arrive, depart) with midnight rollover
        let mut abs: Vec<(Option<i64>, Option<i64>)> = Vec::with_capacity(tr.stops.len());
        let mut day = 0i64;
        let mut last_raw: Option<i64> = None;
        for s in &tr.stops {
            let ev = |t: &str, day: &mut i64, last_raw: &mut Option<i64>| -> Option<i64> {
                let raw = to_min(t)?;
                if let Some(l) = *last_raw {
                    if raw < l {
                        *day += 1440;
                    }
                }
                *last_raw = Some(raw);
                Some(raw + *day)
            };
            let arr = ev(&s.arrive_time, &mut day, &mut last_raw);
            let dep = ev(&s.start_time, &mut day, &mut last_raw);
            abs.push((arr, dep));
        }
        let names: Vec<&str> = tr.stops.iter().map(|s| s.station_name.as_str()).collect();
        for i in 0..names.len() {
            let dep_i = match abs[i].1.or(abs[i].0) {
                Some(v) => v,
                None => continue,
            };
            for j in (i + 2)..names.len() {
                let key = (names[i].to_string(), names[j].to_string());
                if !target.contains(&key) {
                    continue;
                }
                let arr_j = match abs[j].0.or(abs[j].1) {
                    Some(v) => v,
                    None => continue,
                };
                let dur = arr_j - dep_i;
                if dur <= 0 {
                    continue;
                }
                let better = best_chain
                    .get(&key)
                    .map(|c| dur < c.duration_min)
                    .unwrap_or(true);
                if better {
                    best_chain.insert(
                        key,
                        Chain {
                            duration_min: dur,
                            train: tr.code.clone(),
                            via: names[i + 1..j].iter().map(|s| s.to_string()).collect(),
                            subs: (i..j)
                                .map(|k| (names[k].to_string(), names[k + 1].to_string()))
                                .collect(),
                        },
                    );
                }
            }
        }
    }
    println!(
        "trains scanned: {}; target pairs with a stopping service: {}",
        n_trains,
        best_chain.len()
    );

    // ---- evaluate chains against direct pair results ----
    let mut applied_repair = 0usize;
    let mut applied_correction = 0usize;
    let mut unusable = 0usize;
    let mut rejected = 0usize;
    let mut corrections: Vec<(f64, String)> = Vec::new();
    let mut updates: Vec<(usize, f64, String, Vec<String>, String, i64)> = Vec::new();
    for (key, ch) in &best_chain {
        let &pi = match idx_of.get(key) {
            Some(i) => i,
            None => continue,
        };
        let p = &pairs[pi];
        // chain sum from usable sub-pairs
        let mut sum = 0.0f64;
        let mut ok_all = true;
        for sk in &ch.subs {
            match usable(sk) {
                Some(d) => sum += d,
                None => {
                    ok_all = false;
                    break;
                }
            }
        }
        if !ok_all {
            unusable += 1;
            continue;
        }
        let chord = p["chord_km"].as_f64().unwrap_or(0.0);
        if chord <= 0.0 {
            continue;
        }
        let chain_ratio = sum / chord;
        // sanity: ratio window
        if !(0.97..=1.45).contains(&chain_ratio) {
            rejected += 1;
            continue;
        }
        // sanity: fastest nonstop over the chain distance must be plausible
        let fastest_nonstop = p["fastest_leg_min"].as_i64();
        if let Some(m) = fastest_nonstop {
            if m > 0 && sum / (m as f64 / 60.0) > 355.0 {
                rejected += 1;
                continue;
            }
            // sanity: stopping service shouldn't be wildly slower than the
            // fastest nonstop (different railway altogether)
            if ch.duration_min > (m as f64 * 1.6) as i64 + 30 {
                rejected += 1;
                continue;
            }
        }
        let status = p["status"].as_str().unwrap_or("").to_string();
        let direct = p["track_km"].as_f64();
        let is_bad = matches!(status.as_str(), "flagged" | "unroutable" | "snap_fail");
        let disagree = match direct {
            Some(d) if d > 0.0 => (sum - d).abs() / d > 0.04,
            _ => false,
        };
        if is_bad || disagree {
            if is_bad {
                applied_repair += 1;
            } else {
                applied_correction += 1;
                let d = direct.unwrap();
                corrections.push((
                    (sum - d).abs() / d,
                    format!(
                        "{} → {}: direct {:.1} km vs chain {:.1} km via {} (train {}, {} min stop-pattern vs fastest nonstop {})",
                        key.0,
                        key.1,
                        d,
                        sum,
                        ch.via.join("·"),
                        ch.train,
                        ch.duration_min,
                        fastest_nonstop
                            .map(|m| format!("{} min", m))
                            .unwrap_or_else(|| "?".to_string())
                    ),
                ));
            }
            updates.push((
                pi,
                sum,
                status,
                ch.via.clone(),
                ch.train.clone(),
                ch.duration_min,
            ));
        }
    }
    corrections.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    println!(
        "chains applied: {} repairs, {} corrections; {} chains unusable (sub-pair not ok/bridged), {} rejected by sanity checks",
        applied_repair, applied_correction, unusable, rejected
    );
    for (d, msg) in corrections.iter().take(12) {
        println!("  correction {:+.1}%  {}", d * 100.0, msg);
    }

    // ---- write back ----
    let pairs_mut = doc["pairs"].as_array_mut().unwrap();
    for (pi, sum, prev_status, via, train, dur) in updates {
        let chord = pairs_mut[pi]["chord_km"].as_f64().unwrap_or(1.0);
        pairs_mut[pi]["prev_status"] = serde_json::json!(prev_status);
        pairs_mut[pi]["status"] = serde_json::json!("via_chain");
        pairs_mut[pi]["track_km"] = serde_json::json!(round1(sum));
        pairs_mut[pi]["ratio"] = serde_json::json!(round3(sum / chord));
        pairs_mut[pi]["chain_via"] = serde_json::json!(via);
        pairs_mut[pi]["chain_train"] = serde_json::json!(train);
        pairs_mut[pi]["chain_min"] = serde_json::json!(dur);
    }
    if let Some(about) = doc["about"].as_str() {
        doc["about"] = serde_json::json!(format!(
            "{} via_chain = distance not from direct A* but summed over the routed sub-pairs of the fastest stopping service between the two stations (its corridor is the one fast trains actually use); prev_status records the pre-chain status.",
            about
        ));
    }
    fs::write(&pairs_path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    println!("updated {}", pairs_path.display());
}
