use crate::candidate::Candidate;

/// Trait for candidate providers that can contribute candidates to the collection
pub trait Provider {
    fn add_candidates(&self, candidates: &mut Vec<Candidate>);
}
