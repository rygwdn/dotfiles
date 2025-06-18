use crate::candidate::Candidate;
use crate::provider::Provider;
use crate::src_provider::SrcProvider;
use crate::worktree_provider::WorktreeProvider;

/// Main candidate provider that aggregates candidates from multiple sources
pub struct CandidateProvider {
    providers: Vec<Box<dyn Provider>>,
}

impl Default for CandidateProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl CandidateProvider {
    pub fn new() -> Self {
        let providers: Vec<Box<dyn Provider>> = vec![
            Box::new(WorktreeProvider::new()),
            Box::new(SrcProvider::new()),
        ];
        
        CandidateProvider { providers }
    }

    pub fn with_providers(providers: Vec<Box<dyn Provider>>) -> Self {
        CandidateProvider { providers }
    }

    pub fn get_candidates(&self) -> Vec<Candidate> {
        let mut candidates = Vec::new();
        for provider in &self.providers {
            provider.add_candidates(&mut candidates);
        }
        candidates
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_candidate_provider_aggregation() {
        let provider = CandidateProvider::new();
        let candidates = provider.get_candidates();
        // This test just ensures the aggregation works without panicking
        // The actual content depends on the file system
        // Just verify that we can get candidates without error
        let _count = candidates.len();
    }

    #[test]
    fn test_custom_providers() {
        use crate::path_shortener::shorten_path;
        use std::path::Path;
        
        struct TestProvider;
        impl Provider for TestProvider {
            fn add_candidates(&self, candidates: &mut Vec<Candidate>) {
                let path = "/test/path";
                candidates.push(Candidate {
                    path: path.to_string(),
                    shortpath: shorten_path(Path::new(path)),
                    branch: Some("feature".to_string()),
                });
            }
        }

        let providers: Vec<Box<dyn Provider>> = vec![Box::new(TestProvider)];
        let provider = CandidateProvider::with_providers(providers);
        let candidates = provider.get_candidates();
        
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, "/test/path");
        assert_eq!(candidates[0].branch, Some("feature".to_string()));
        // Don't test the exact shortpath value since it depends on the shortener logic
    }
}
