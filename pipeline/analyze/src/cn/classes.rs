//! China-specific train-class letters (G D C S Z T K, else plain).

pub fn class_idx(c: &str) -> usize {
    match c {
        "G" => 0,
        "D" => 1,
        "C" => 2,
        "S" => 3,
        "Z" => 4,
        "T" => 5,
        "K" => 6,
        _ => 7,
    }
}
