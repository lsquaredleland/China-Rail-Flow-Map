//! The decision policy: given one leg's candidates, emissions and
//! posterior, which corridor to draw and why. Pure: no globals, no I/O.
//!
//! With a baseline (production) candidate, in this order:
//!
//! 1. no candidate is feasible: `infeasible-keep` (keep the baseline);
//! 2. another candidate is decisive (post >= switch_post and the
//!    baseline's post <= base_max): `switched`;
//! 3. a feasible candidate shrinks the baseline's bridged gap by more
//!    than bridge_gap_gain_km, or closes it: `bridge-fix` (smallest gap,
//!    then highest posterior);
//! 4. else `ambiguous-keep` when the argmax is another candidate,
//!    `production` when it is the baseline.
//!
//! Without a baseline candidate the argmax is drawn (`filled`) when it is
//! feasible and its posterior >= fill_post, or >= fill_near_post with a
//! gap < fill_near_gap_km; otherwise the leg stays a straight `chord`.
use crate::config::DecideConfig;
use crate::model::LegObs;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Outcome {
    /// The leg's pair was not routed (unknown station, duplicate names).
    NotRouted,
    /// The pair was routed but has no candidate.
    NoCandidates,
    InfeasibleKeep,
    Switched,
    BridgeFix,
    AmbiguousKeep,
    Production,
    Filled,
    Chord,
}

impl Outcome {
    /// The label written to leg_routes.jsonl and summary.json.
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::NotRouted => "not-routed",
            Outcome::NoCandidates => "no-candidates",
            Outcome::InfeasibleKeep => "infeasible-keep",
            Outcome::Switched => "switched",
            Outcome::BridgeFix => "bridge-fix",
            Outcome::AmbiguousKeep => "ambiguous-keep",
            Outcome::Production => "production",
            Outcome::Filled => "filled",
            Outcome::Chord => "chord",
        }
    }

    /// Whether the leg is drawn on a router-chosen corridor (a per-leg
    /// path in leg_paths.json) rather than the pair's shared geometry.
    pub fn draws_own_path(self) -> bool {
        matches!(
            self,
            Outcome::Switched | Outcome::Filled | Outcome::BridgeFix
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    /// Candidate index to draw; None = chord / nothing.
    pub chosen: Option<usize>,
    /// Index of the baseline candidate, if the pair has one.
    pub base: Option<usize>,
    pub outcome: Outcome,
}

/// The switch test, shared with the self-check: `best` is decisive over
/// the baseline `bi`.
pub fn is_decisive(post: &[f64], best: usize, bi: usize, cfg: &DecideConfig) -> bool {
    best != bi && post[best] >= cfg.switch_post && post[bi] <= cfg.base_max
}

/// Decide one leg from its observation (`obs.cands`, `obs.emit`) and its
/// posterior over the candidates.
pub fn decide(obs: &LegObs, post: &[f64], cfg: &DecideConfig) -> Decision {
    let pc = obs.cands;
    let emit = &obs.emit;
    let best = (0..post.len()).max_by(|&a, &b| post[a].total_cmp(&post[b]));
    let base = pc.iter().position(|c| c.is_base);
    let feasible = |i: usize| emit[i] > cfg.feasible_emit_min;
    let any_feasible = (0..pc.len()).any(feasible);
    let bridge_fix = base.and_then(|bi| {
        let bg = pc[bi].gap_km;
        if bg <= 0.0 {
            return None;
        }
        (0..pc.len())
            .filter(|&i| {
                feasible(i)
                    && (pc[i].gap_km < bg - cfg.bridge_gap_gain_km
                        || (pc[i].gap_km == 0.0 && bg > 0.0))
            })
            .min_by(|&a, &b| {
                pc[a]
                    .gap_km
                    .total_cmp(&pc[b].gap_km)
                    .then_with(|| post[b].total_cmp(&post[a]))
            })
    });
    let (chosen, outcome) = match (best, base) {
        (None, _) => (None, Outcome::NoCandidates),
        (Some(_), _) if !any_feasible => (base, Outcome::InfeasibleKeep),
        (Some(b), Some(bi)) => {
            if is_decisive(post, b, bi, cfg) {
                (Some(b), Outcome::Switched)
            } else if let Some(fx) = bridge_fix {
                (Some(fx), Outcome::BridgeFix)
            } else if b != bi {
                (Some(bi), Outcome::AmbiguousKeep)
            } else {
                (Some(bi), Outcome::Production)
            }
        }
        (Some(b), None) => {
            let fill_ok = feasible(b)
                && (post[b] >= cfg.fill_post
                    || (pc[b].gap_km < cfg.fill_near_gap_km && post[b] >= cfg.fill_near_post));
            if fill_ok {
                (Some(b), Outcome::Filled)
            } else {
                (None, Outcome::Chord)
            }
        }
    };
    Decision {
        chosen,
        base,
        outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::classes::NCLASS;
    use crate::model::Cand;

    fn cand(gap_km: f64, is_base: bool) -> Cand {
        Cand {
            nodes: Vec::new(),
            km: 100.0,
            gap_km,
            gaps_at: Vec::new(),
            hsr_km: 0.0,
            run_min: [60.0; NCLASS],
            source: String::new(),
            is_base,
            head_start: 0.0,
            head_end: 0.0,
            lines: Vec::new(),
            reversals: 0,
        }
    }

    fn run(cands: &[Cand], emit: &[f64], post: &[f64]) -> Decision {
        let obs = LegObs {
            cands,
            forward: true,
            emit: emit.to_vec(),
            dwell_end: 0,
        };
        decide(&obs, post, &DecideConfig::default())
    }

    fn outcome(cands: &[Cand], emit: &[f64], post: &[f64]) -> (Option<usize>, Outcome) {
        let d = run(cands, emit, post);
        (d.chosen, d.outcome)
    }

    const OK: f64 = -1.0; // feasible emission
    const BAD: f64 = -30.0; // infeasible emission

    #[test]
    fn no_candidates() {
        let d = run(&[], &[], &[]);
        assert_eq!(d.outcome, Outcome::NoCandidates);
        assert_eq!((d.chosen, d.base), (None, None));
    }

    #[test]
    fn infeasible_keeps_baseline_or_nothing() {
        let c = [cand(0.0, true), cand(0.0, false)];
        assert_eq!(
            outcome(&c, &[BAD, BAD], &[0.01, 0.99]),
            (Some(0), Outcome::InfeasibleKeep)
        );
        let c = [cand(0.0, false), cand(0.0, false)];
        assert_eq!(
            outcome(&c, &[BAD, BAD], &[0.1, 0.9]),
            (None, Outcome::InfeasibleKeep)
        );
    }

    #[test]
    fn feasibility_edge_is_strict() {
        // emission must exceed -29.0: exactly -29.0 is infeasible
        let c = [cand(0.0, true), cand(0.0, false)];
        assert_eq!(
            outcome(&c, &[-29.0, -29.0], &[0.5, 0.5]).1,
            Outcome::InfeasibleKeep
        );
        assert_eq!(
            outcome(&c, &[-29.0, -28.999], &[0.5, 0.5]).1,
            Outcome::AmbiguousKeep
        );
    }

    #[test]
    fn production_when_baseline_is_argmax() {
        let c = [cand(0.0, true), cand(0.0, false)];
        assert_eq!(
            outcome(&c, &[OK, OK], &[0.7, 0.3]),
            (Some(0), Outcome::Production)
        );
    }

    #[test]
    fn switched_at_threshold_edges() {
        let c = [cand(0.0, true), cand(0.0, false)];
        // exactly at both limits: switch
        assert_eq!(
            outcome(&c, &[OK, OK], &[0.05, 0.9]),
            (Some(1), Outcome::Switched)
        );
        // argmax just under switch_post: keep
        assert_eq!(
            outcome(&c, &[OK, OK], &[0.05, 0.8999]),
            (Some(0), Outcome::AmbiguousKeep)
        );
        // baseline just over base_max: keep
        assert_eq!(
            outcome(&c, &[OK, OK, OK], &[0.0501, 0.9, 0.0]),
            (Some(0), Outcome::AmbiguousKeep)
        );
    }

    #[test]
    fn switch_wins_over_bridge_fix() {
        let c = [cand(2.0, true), cand(0.0, false)];
        assert_eq!(
            outcome(&c, &[OK, OK], &[0.01, 0.99]),
            (Some(1), Outcome::Switched)
        );
    }

    #[test]
    fn bridge_fix_needs_gain_or_closure() {
        // baseline gap 2.0: 1.5 is not > 0.5 km better (exactly 0.5)
        let c = [cand(2.0, true), cand(1.5, false)];
        assert_eq!(
            outcome(&c, &[OK, OK], &[0.4, 0.6]),
            (Some(0), Outcome::AmbiguousKeep)
        );
        let c = [cand(2.0, true), cand(1.4, false)];
        assert_eq!(
            outcome(&c, &[OK, OK], &[0.4, 0.6]),
            (Some(1), Outcome::BridgeFix)
        );
        // a closed gap always fixes, even a tiny baseline gap
        let c = [cand(0.1, true), cand(0.0, false)];
        assert_eq!(
            outcome(&c, &[OK, OK], &[0.6, 0.4]),
            (Some(1), Outcome::BridgeFix)
        );
        // infeasible fixes don't count
        let c = [cand(2.0, true), cand(0.0, false)];
        assert_eq!(
            outcome(&c, &[OK, BAD], &[0.6, 0.4]),
            (Some(0), Outcome::Production)
        );
        // gap-free baseline: never a bridge fix
        let c = [cand(0.0, true), cand(0.0, false)];
        assert_eq!(
            outcome(&c, &[OK, OK], &[0.6, 0.4]),
            (Some(0), Outcome::Production)
        );
    }

    #[test]
    fn bridge_fix_picks_smallest_gap_then_posterior() {
        let c = [
            cand(3.0, true),
            cand(1.0, false),
            cand(0.0, false),
            cand(0.0, false),
        ];
        assert_eq!(
            outcome(&c, &[OK, OK, OK, OK], &[0.1, 0.5, 0.15, 0.25]),
            (Some(3), Outcome::BridgeFix)
        );
    }

    #[test]
    fn filled_or_chord_without_baseline() {
        let c = [cand(0.0, false), cand(5.0, false)];
        // fill_post edge
        assert_eq!(
            outcome(&c, &[OK, OK], &[0.2, 0.8]),
            (Some(1), Outcome::Filled)
        );
        assert_eq!(
            outcome(&c, &[OK, OK], &[0.2001, 0.7999]),
            (None, Outcome::Chord)
        );
        // nearly gap-free argmax fills from 0.35
        let c = [cand(0.99, false), cand(5.0, false), cand(5.0, false)];
        assert_eq!(
            outcome(&c, &[OK, OK, OK], &[0.35, 0.33, 0.32]),
            (Some(0), Outcome::Filled)
        );
        assert_eq!(
            outcome(&c, &[OK, OK, OK], &[0.3499, 0.33, 0.3201]),
            (None, Outcome::Chord)
        );
        // gap exactly 1.0 km is not "nearly gap-free"
        let c = [cand(1.0, false), cand(5.0, false), cand(5.0, false)];
        assert_eq!(
            outcome(&c, &[OK, OK, OK], &[0.4, 0.3, 0.3]),
            (None, Outcome::Chord)
        );
        // infeasible argmax: chord even when decisive
        let c = [cand(0.0, false), cand(0.0, false)];
        assert_eq!(
            outcome(&c, &[OK, BAD], &[0.01, 0.99]),
            (None, Outcome::Chord)
        );
    }

    #[test]
    fn ties_take_the_last_maximum() {
        // max_by keeps the last of equal posteriors: the non-baseline
        // candidate is the argmax, so the kept baseline is "ambiguous"
        let c = [cand(0.0, true), cand(0.0, false)];
        assert_eq!(
            outcome(&c, &[OK, OK], &[0.5, 0.5]),
            (Some(0), Outcome::AmbiguousKeep)
        );
    }

    #[test]
    fn labels_and_redraw_set() {
        assert_eq!(Outcome::BridgeFix.as_str(), "bridge-fix");
        assert_eq!(Outcome::InfeasibleKeep.as_str(), "infeasible-keep");
        let own: Vec<_> = [
            Outcome::NotRouted,
            Outcome::NoCandidates,
            Outcome::InfeasibleKeep,
            Outcome::Switched,
            Outcome::BridgeFix,
            Outcome::AmbiguousKeep,
            Outcome::Production,
            Outcome::Filled,
            Outcome::Chord,
        ]
        .into_iter()
        .filter(|o| o.draws_own_path())
        .map(|o| o.as_str())
        .collect();
        assert_eq!(own, ["switched", "bridge-fix", "filled"]);
    }
}
