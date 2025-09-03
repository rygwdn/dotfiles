use crate::candidate::Candidate;
use crate::config::ConfigManager;
use crate::path_shortener::shorten_path;
use crate::provider::Provider;
use crate::utils::{expand_path, get_repository_branch};
use std::fs;
use std::path::Path;

/// Provider for worktree-based candidates from ~/world/trees
pub struct WorktreeProvider {
    world_trees_path: Option<String>,
}

impl Default for WorktreeProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl WorktreeProvider {
    pub fn new() -> Self {
        // In tests, don't create config files automatically
        let config = if cfg!(test) {
            ConfigManager::load_config_with_options(false)
        } else {
            ConfigManager::load_config()
        };
        WorktreeProvider {
            world_trees_path: config.world_path,
        }
    }

    pub fn with_path(path: String) -> Self {
        WorktreeProvider {
            world_trees_path: Some(path),
        }
    }

    fn process_worktree_areas(&self, areas_path: &Path, candidates: &mut Vec<Candidate>) {
        let Ok(category_entries) = fs::read_dir(areas_path) else {
            return;
        };
        let branch = areas_path.to_str().and_then(get_repository_branch);

        for category_entry in category_entries.filter_map(Result::ok) {
            let category_dir = category_entry.path();
            if !category_dir.is_dir() {
                continue;
            }

            let Ok(project_entries) = fs::read_dir(&category_dir) else {
                continue;
            };

            for project_entry in project_entries.filter_map(Result::ok) {
                let project_dir = project_entry.path();
                if !project_dir.is_dir() {
                    continue;
                }

                let project_path = project_dir
                    .canonicalize()
                    .unwrap_or(project_dir.clone())
                    .to_string_lossy()
                    .into_owned();

                candidates.push(Candidate {
                    path: project_path.clone(),
                    shortpath: shorten_path(Path::new(&project_path)),
                    branch: branch.clone(),
                });
            }
        }
    }
}

impl Provider for WorktreeProvider {
    fn add_candidates(&self, candidates: &mut Vec<Candidate>) {
        // If no world path is configured, don't add any candidates
        let Some(world_path) = &self.world_trees_path else {
            return;
        };

        let world_trees_path = expand_path(world_path);
        if !world_trees_path.exists() {
            return;
        }

        let Ok(entries) = fs::read_dir(&world_trees_path) else {
            return;
        };

        for entry in entries.filter_map(Result::ok) {
            let worktree_dir = entry.path();
            if !worktree_dir.is_dir() {
                continue;
            }

            let areas_path = worktree_dir.join("src/areas");
            if !areas_path.exists() {
                continue;
            }

            self.process_worktree_areas(&areas_path, candidates);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::test_env::TestEnvironment;

    #[test]
    fn test_worktree_provider_creation() {
        let provider = WorktreeProvider::new();
        let mut candidates = Vec::new();
        // This should not panic
        provider.add_candidates(&mut candidates);
    }

    #[test]
    fn test_worktree_provider_with_custom_path() {
        let env = TestEnvironment::new();
        let provider =
            WorktreeProvider::with_path(env.temp_dir.path().to_string_lossy().to_string());
        let mut candidates = Vec::new();
        // Should not find any candidates in empty temp dir
        provider.add_candidates(&mut candidates);
        assert_eq!(candidates.len(), 0);
    }

    #[test]
    fn test_worktree_provider_with_projects() {
        let env = TestEnvironment::new();

        // Create some worktree projects
        env.create_worktree_project("main", "analytics", "dashboard");
        env.create_worktree_project("main", "analytics", "reporting");
        env.create_worktree_project("test", "core", "checkout");

        let provider = WorktreeProvider::with_path(env.world_path.to_string_lossy().to_string());
        let mut candidates = Vec::new();
        provider.add_candidates(&mut candidates);

        // Should find all three projects
        assert_eq!(candidates.len(), 3);

        let paths: Vec<&str> = candidates.iter().map(|c| c.path.as_str()).collect();
        assert!(paths.iter().any(|p| p.contains("dashboard")));
        assert!(paths.iter().any(|p| p.contains("reporting")));
        assert!(paths.iter().any(|p| p.contains("checkout")));
    }
}
