//! A train's whole path, joined from a head (its first stop to a boarding
//! stop `b`) and a tail (from `b` to its terminus), in the out-tables path
//! encoding (fmt 6): signed refs in travel order, `!id` = walked against the
//! piece's stored order. The national trains file (P2.2 data source) joins a
//! train's inbound-only stretch (head) to its out-tables path (tail), keeping
//! the tail verbatim so the whole path ends with exactly the out-tables row.

/// One stretch of a train's path: entries, stop positions, chord legs.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct PathPart {
    /// Path entries in travel order.
    pub secs: Vec<i64>,
    /// One per stop after the part's first stop, in stop order: the number
    /// of entries before that stop (its last stop sits at `secs.len()`).
    pub stop_pos: Vec<usize>,
    /// `[stop, s0, s1]` per leg without usable track geometry: the leg
    /// departs stop `stop` of the train and owns entries `s0..s1`.
    pub chord_legs: Vec<[usize; 3]>,
}

/// What happened where head and tail meet.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Seam {
    /// Head's last entry was tail's first (the same piece on both sides of
    /// the boarding stop); head's copy was dropped.
    pub dup_dropped: bool,
    /// After that, head's last flow entry equals tail's first flow entry
    /// with only non-flow entries (throats) between: one pass over a section
    /// split by the stop.
    pub flow_repeat: bool,
    /// Head's last flow entry is tail's first flow entry reversed, with only
    /// throats between: the train reverses at the boarding stop.
    pub reversal: bool,
}

/// Join `head` and `tail` at the stop where `head` ends and `tail` starts.
/// `tail` is kept verbatim (its positions shift by head's length); `head`
/// loses its last entry when that entry is also tail's first. `is_flow`
/// tells flow sections from geometry-only entries.
pub fn join(
    mut head: PathPart,
    tail: &PathPart,
    is_flow: impl Fn(i64) -> bool,
) -> (PathPart, Seam) {
    let mut seam = Seam::default();
    if head
        .secs
        .last()
        .is_some_and(|v| tail.secs.first() == Some(v))
    {
        head.secs.pop();
        let len = head.secs.len();
        for p in head.stop_pos.iter_mut() {
            *p = (*p).min(len);
        }
        for l in head.chord_legs.iter_mut() {
            l[1] = l[1].min(len);
            l[2] = l[2].min(len);
        }
        seam.dup_dropped = true;
    }
    let last_flow = head.secs.iter().rev().find(|&&v| is_flow(v));
    let first_flow = tail.secs.iter().find(|&&v| is_flow(v));
    if let (Some(&a), Some(&b)) = (last_flow, first_flow) {
        seam.flow_repeat = a == b;
        seam.reversal = a == !b;
    }
    let off = head.secs.len();
    head.secs.extend_from_slice(&tail.secs);
    head.stop_pos.extend(tail.stop_pos.iter().map(|p| p + off));
    head.chord_legs.extend(
        tail.chord_legs
            .iter()
            .map(|l| [l[0], l[1] + off, l[2] + off]),
    );
    (head, seam)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ids below 10 are flow sections, 10 and up throats.
    fn flow(v: i64) -> bool {
        (if v >= 0 { v } else { !v }) < 10
    }

    fn part(secs: &[i64], stop_pos: &[usize], chord_legs: &[[usize; 3]]) -> PathPart {
        PathPart {
            secs: secs.to_vec(),
            stop_pos: stop_pos.to_vec(),
            chord_legs: chord_legs.to_vec(),
        }
    }

    #[test]
    fn join_shifts_the_tail_and_keeps_it_verbatim() {
        let head = part(&[1, 10, 2], &[2, 3], &[[0, 0, 1]]);
        let tail = part(&[11, 3, !4], &[1, 3], &[[3, 2, 3]]);
        let (w, seam) = join(head, &tail, flow);
        assert_eq!(w.secs, vec![1, 10, 2, 11, 3, !4]);
        assert_eq!(w.stop_pos, vec![2, 3, 4, 6]);
        assert_eq!(w.chord_legs, vec![[0, 0, 1], [3, 5, 6]]);
        assert_eq!(&w.secs[3..], &tail.secs[..]);
        assert_eq!(seam, Seam::default());
    }

    #[test]
    fn join_drops_heads_copy_of_a_piece_on_both_sides() {
        // section 2 runs through the boarding stop: head ends on it, tail starts on it
        let head = part(&[1, 2], &[1, 2], &[[1, 1, 2]]);
        let tail = part(&[2, 3], &[2], &[]);
        let (w, seam) = join(head, &tail, flow);
        assert_eq!(w.secs, vec![1, 2, 3]);
        assert_eq!(w.stop_pos, vec![1, 1, 3]);
        assert_eq!(w.chord_legs, vec![[1, 1, 1]]);
        assert!(seam.dup_dropped && !seam.flow_repeat && !seam.reversal);
    }

    #[test]
    fn join_reports_repeats_and_reversals_across_throats() {
        let (_, s) = join(part(&[1, 10], &[2], &[]), &part(&[11, 1], &[2], &[]), flow);
        assert!(s.flow_repeat && !s.reversal && !s.dup_dropped);
        let (w, s) = join(
            part(&[1, 10], &[2], &[]),
            &part(&[!10, !1], &[2], &[]),
            flow,
        );
        assert!(s.reversal && !s.flow_repeat);
        assert_eq!(w.secs, vec![1, 10, !10, !1]);
    }

    #[test]
    fn join_with_an_empty_part_is_the_other_part() {
        let tail = part(&[1, 2], &[1, 2], &[]);
        let (w, _) = join(PathPart::default(), &tail, flow);
        assert_eq!(w, tail);
        let head = part(&[1, 2], &[2], &[]);
        let (w, _) = join(head.clone(), &PathPart::default(), flow);
        assert_eq!(w, head);
    }
}
