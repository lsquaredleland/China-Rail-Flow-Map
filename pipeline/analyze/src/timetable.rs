//! Timetable schema (the `china-rail-*.json` deliverables) and clock arithmetic.

use serde::Deserialize;

#[derive(Deserialize)]
pub struct Deliverable {
    // Part of the timetable file schema; not read by this builder.
    #[allow(dead_code)]
    pub date: Option<String>,
    pub trains: Vec<Train>,
}

#[derive(Deserialize, Clone)]
pub struct Train {
    #[serde(default)]
    pub train_no: String,
    pub code: String,
    #[serde(rename = "class")]
    pub train_class: String,
    pub stops: Vec<Stop>,
}

#[derive(Deserialize, Clone)]
pub struct Stop {
    pub name: String,
    pub arrive: String,
    pub depart: String,
}

pub fn mins(s: &str) -> Option<i64> {
    let t = s.trim();
    if t == "----" || t.is_empty() {
        return None;
    }
    let mut it = t.split(':');
    let h: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    Some(h * 60 + m)
}

/// Travel minutes from departing stop `from` to arriving at stop `to`,
/// advancing the clock by whole days whenever a stop time wraps past midnight.
#[allow(clippy::needless_range_loop)]
pub fn travel_time(stops: &[Stop], from: usize, to: usize) -> Option<i64> {
    let start = mins(&stops[from].depart)?;
    let mut clock = start;
    let mut prev_tod = start;
    for j in (from + 1)..=to {
        let arr = match mins(&stops[j].arrive) {
            Some(a) => a,
            None => continue,
        };
        let mut abs = clock - prev_tod + arr;
        while abs < clock {
            abs += 1440;
        }
        clock = abs;
        prev_tod = arr;
        if j == to {
            return Some(clock - start);
        }
        if let Some(dep) = mins(&stops[j].depart) {
            let mut dabs = clock - prev_tod + dep;
            while dabs < clock {
                dabs += 1440;
            }
            clock = dabs;
            prev_tod = dep;
        }
    }
    None
}
