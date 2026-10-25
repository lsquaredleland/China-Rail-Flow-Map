//! Schedule seam: trains, their stops and times, in a format-free shape.
//!
//! A `ScheduleSource` turns some timetable dataset into `Train`s. The
//! router never sees the file format: station names arrive normalised
//! (`stations::normalize_name`) so they match the station index, and
//! times arrive as minutes after midnight (`None` = not given, e.g. an
//! origin's arrival). `china::TimetableJson` is the current source.

/// One call of a train.
#[derive(Clone, Debug)]
pub struct Stop {
    /// Normalised station name (the key into `stations::Stations`).
    pub name: String,
    /// Minutes after midnight, local clock; may wrap past midnight
    /// between stops (handled by `travel_time`).
    pub arrive: Option<i64>,
    pub depart: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Train {
    /// Operator's internal id (written to outputs; may be empty).
    pub train_no: String,
    /// Display code (e.g. "G1").
    pub code: String,
    /// Service class string, mapped by `classes::class_index`.
    pub class: String,
    pub stops: Vec<Stop>,
}

/// A timetable dataset.
pub trait ScheduleSource {
    /// Every train, in a stable order (outputs follow it).
    fn load(&self) -> Vec<Train>;
}

/// Minutes after midnight of an "HH:MM" clock string; None for "----",
/// empty or malformed values.
pub fn parse_hhmm(s: &str) -> Option<i64> {
    let t = s.trim();
    if t == "----" || t.is_empty() {
        return None;
    }
    let mut it = t.split(':');
    let h: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    Some(h * 60 + m)
}

/// Minutes from departing stop `from` to arriving at stop `to`, with the
/// whole-day wrap logic used by atlas.rs / legclass.rs.
pub fn travel_time(stops: &[Stop], from: usize, to: usize) -> Option<i64> {
    let start = stops[from].depart?;
    let mut clock = start;
    let mut prev = start;
    for (j, s) in stops.iter().enumerate().take(to + 1).skip(from + 1) {
        let Some(arr) = s.arrive else {
            continue;
        };
        let mut abs = clock - prev + arr;
        while abs < clock {
            abs += 1440;
        }
        clock = abs;
        prev = arr;
        if j == to {
            return Some(clock - start);
        }
        if let Some(dep) = s.depart {
            let mut d = clock - prev + dep;
            while d < clock {
                d += 1440;
            }
            clock = d;
            prev = dep;
        }
    }
    None
}

/// Dwell minutes at stop `i` (0 when either time is missing).
pub fn dwell(stops: &[Stop], i: usize) -> i64 {
    match (stops[i].arrive, stops[i].depart) {
        (Some(a), Some(d)) => (d - a).rem_euclid(1440),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(name: &str, arrive: &str, depart: &str) -> Stop {
        Stop {
            name: name.into(),
            arrive: parse_hhmm(arrive),
            depart: parse_hhmm(depart),
        }
    }

    #[test]
    fn travel_time_wraps_midnight() {
        let s = vec![
            st("a", "----", "23:30"),
            st("b", "00:40", "00:45"),
            st("c", "02:00", "02:00"),
        ];
        assert_eq!(travel_time(&s, 0, 1), Some(70));
        assert_eq!(travel_time(&s, 0, 2), Some(150));
        assert_eq!(travel_time(&s, 1, 2), Some(75));
        assert_eq!(dwell(&s, 1), 5);
    }

    #[test]
    fn clock_strings_parse() {
        assert_eq!(parse_hhmm("07:05"), Some(425));
        assert_eq!(parse_hhmm(" 23:59 "), Some(1439));
        assert_eq!(parse_hhmm("----"), None);
        assert_eq!(parse_hhmm(""), None);
        assert_eq!(parse_hhmm("x"), None);
    }
}
