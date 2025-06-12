pub mod candidate;
pub mod candidate_provider;
pub mod navigator;
pub mod path_shortener;
pub mod scorer;
pub mod shell_init;

#[cfg(test)]
pub mod test_utils;

pub use candidate::Candidate;
pub use candidate_provider::CandidateProvider;
pub use navigator::WorktreeNavigator;
pub use path_shortener::{shorten_path, ShortPath};
pub use scorer::OptimalScorer;

// Re-export clean_for_list as a standalone function
pub fn clean_for_list(match_string: &str) -> String {
    navigator::WorktreeNavigator::clean_for_list(match_string)
}
