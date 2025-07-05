use crate::candidate::Candidate;
use crate::path_shortener::shorten_path;
use crate::provider::Provider;
use crate::utils::{expand_path, get_repository_branch};

use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const DEFAULT_SRC_PATH: &str = "~/src";
const DEFAULT_DEPTH_LIMIT: usize = 3;

/// Provider for source code repositories with configurable path and recursive scanning
pub struct SrcProvider {
    /// Base path to scan for repositories
    base_path: PathBuf,
    /// Maximum depth to recursively scan (0 = only scan base path, 1 = one level deep, etc.)
    depth_limit: usize,
}

impl Default for SrcProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl SrcProvider {
    /// Create a new SrcProvider with the default ~/src path and depth limit
    pub fn new() -> Self {
        SrcProvider {
            base_path: expand_path(DEFAULT_SRC_PATH),
            depth_limit: DEFAULT_DEPTH_LIMIT,
        }
    }

    /// Create a new SrcProvider with a custom base path
    pub fn with_path<P: AsRef<Path>>(path: P) -> Self {
        SrcProvider {
            base_path: expand_path(path.as_ref().to_string_lossy().as_ref()),
            depth_limit: DEFAULT_DEPTH_LIMIT,
        }
    }

    /// Set the maximum depth for recursive scanning
    pub fn with_depth_limit(mut self, depth_limit: usize) -> Self {
        self.depth_limit = depth_limit;
        self
    }

    /// Check if a directory is hidden (dot or underscore prefixed)
    fn is_hidden(entry: &walkdir::DirEntry) -> bool {
        if let Some(name) = entry.file_name().to_str() {
            name.starts_with('.') || name.starts_with('_')
        } else {
            false
        }
    }

    /// Check if a directory is inside a git repository
    fn is_in_git_repo(entry: &walkdir::DirEntry) -> bool {
        entry
            .path()
            .parent()
            .map(|parent| parent.join(".git").exists())
            .unwrap_or(false)
    }

    /// Scan for git repositories using walkdir
    fn scan_repositories(&self, candidates: &mut Vec<Candidate>) {
        for entry in WalkDir::new(&self.base_path)
            .max_depth(self.depth_limit)
            .into_iter()
            .filter_entry(|e| {
                // Always allow the base path
                if e.depth() == 0 {
                    return true;
                }

                // Skip hidden directories and directories inside git repositories
                !Self::is_hidden(e) && !Self::is_in_git_repo(e)
            })
            .filter_map(Result::ok)
        {
            let path = entry.path();

            // Check if this directory is a git repository
            if path.join(".git").exists() {
                let repo_path = path.to_string_lossy().into_owned();
                let branch = get_repository_branch(&repo_path);

                candidates.push(Candidate {
                    path: repo_path,
                    shortpath: shorten_path(path),
                    branch,
                });
            }
        }
    }
}

impl Provider for SrcProvider {
    fn add_candidates(&self, candidates: &mut Vec<Candidate>) {
        if !self.base_path.exists() {
            return;
        }

        self.scan_repositories(candidates);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    #![allow(clippy::expect_used)]
    use super::*;
    use crate::test_utils::test_env::TestEnvironment;

    #[test]
    fn test_src_provider_creation() {
        let provider = SrcProvider::new();
        assert_eq!(provider.depth_limit, DEFAULT_DEPTH_LIMIT);
    }

    #[test]
    fn test_src_provider_with_custom_path() {
        let provider = SrcProvider::with_path("/custom/path");
        assert!(provider.base_path.to_string_lossy().contains("custom/path"));
    }

    #[test]
    fn test_src_provider_with_depth_limit() {
        let provider = SrcProvider::new().with_depth_limit(5);
        assert_eq!(provider.depth_limit, 5);
    }

    #[test]
    fn test_recursive_git_discovery() {
        let env = TestEnvironment::new();

        // Create a nested structure with git repos
        env.create_git_repo("repo1");
        env.create_nested_git_repo("level1/repo2");
        env.create_nested_git_repo("level1/level2/repo3");

        // Test with depth 2 - should find repo1 and repo2, but not repo3
        let provider = SrcProvider::with_path(&env.src_path).with_depth_limit(2);
        let mut candidates = Vec::new();
        provider.add_candidates(&mut candidates);

        assert_eq!(candidates.len(), 2);

        let paths: Vec<&str> = candidates.iter().map(|c| c.path.as_str()).collect();
        assert!(paths.iter().any(|p| p.contains("repo1")));
        assert!(paths.iter().any(|p| p.contains("repo2")));
        assert!(!paths.iter().any(|p| p.contains("repo3")));

        // Test with depth 3 - should find all three
        let provider3 = SrcProvider::with_path(&env.src_path).with_depth_limit(3);
        let mut candidates3 = Vec::new();
        provider3.add_candidates(&mut candidates3);

        assert_eq!(candidates3.len(), 3);
        let paths3: Vec<&str> = candidates3.iter().map(|c| c.path.as_str()).collect();
        assert!(paths3.iter().any(|p| p.contains("repo3")));
    }

    #[test]
    fn test_depth_limit_zero() {
        let env = TestEnvironment::new();
        let base_path = env.temp_dir.path();

        // Create a git repo at the base level and one nested
        std::fs::create_dir(base_path.join(".git")).unwrap(); // This makes base_path itself a git repo
        env.create_nested_git_repo("nested/repo");

        let provider = SrcProvider::with_path(base_path).with_depth_limit(0);
        let mut candidates = Vec::new();
        provider.add_candidates(&mut candidates);

        // Should only find the base repo
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0]
            .path
            .contains(&base_path.to_string_lossy().to_string()));
    }
}
