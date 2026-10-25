//! Station-name text helpers (language-neutral).

pub fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

pub fn nchars(s: &str) -> usize {
    s.chars().count()
}

pub fn drop_last(s: &str) -> String {
    let mut v: Vec<char> = s.chars().collect();
    v.pop();
    v.into_iter().collect()
}
