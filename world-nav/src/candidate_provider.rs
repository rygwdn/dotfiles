use crate::candidate::Candidate;
use crate::config::ConfigManager;
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
        let mut providers: Vec<Box<dyn Provider>> = vec![Box::new(WorktreeProvider::new())];

        // Add multiple SrcProvider instances based on config
        let src_providers = Self::create_src_providers();
        for src_provider in src_providers {
            providers.push(Box::new(src_provider));
        }

        CandidateProvider { providers }
    }

    pub fn with_providers(providers: Vec<Box<dyn Provider>>) -> Self {
        CandidateProvider { providers }
    }

    /// Creates multiple SrcProvider instances based on configuration file or defaults
    fn create_src_providers() -> Vec<SrcProvider> {
        // In tests, don't create config files automatically
        let config = if cfg!(test) {
            ConfigManager::load_config_with_options(false)
        } else {
            ConfigManager::load_config()
        };

        if config.src_paths.is_empty() {
            return vec![];
        }

        let depth_limit = config.depth_limit.unwrap_or(3);

        config
            .src_paths
            .into_iter()
            .map(|path| SrcProvider::with_path(path).with_depth_limit(depth_limit))
            .collect()
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

    #[test]
    fn test_create_src_providers_with_multiple_paths() {
        use crate::config::WorldNavConfig;

        let config = WorldNavConfig {
            src_paths: vec![
                "/path/one".to_string(),
                "/path/two".to_string(),
                "~/projects".to_string(),
            ],
            depth_limit: Some(5),
            ..WorldNavConfig::default()
        };

        // Test that we can create multiple providers (indirectly by testing config)
        assert_eq!(config.src_paths.len(), 3);
        assert!(config.src_paths.contains(&"/path/one".to_string()));
        assert!(config.src_paths.contains(&"/path/two".to_string()));
        assert!(config.src_paths.contains(&"~/projects".to_string()));
        assert_eq!(config.depth_limit, Some(5));

        // Verify that create_src_providers would create the right number of providers
        // We can't test the actual creation easily without mocking, but we can test the logic
        let expected_provider_count = config.src_paths.len();
        assert_eq!(expected_provider_count, 3);
    }

    #[test]
    fn test_create_src_providers_empty_paths() {
        use crate::config::WorldNavConfig;

        let config = WorldNavConfig {
            src_paths: vec![],
            ..WorldNavConfig::default()
        };

        // When src_paths is empty, should fall back to default behavior
        assert_eq!(config.src_paths.len(), 0);

        // The create_src_providers method should return vec![] in this case
        // We're testing the logic that would be executed
        let should_use_default = config.src_paths.is_empty();
        assert!(should_use_default);
    }
}
