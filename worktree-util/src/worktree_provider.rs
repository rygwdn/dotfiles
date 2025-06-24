use crate::candidate::Candidate;
use crate::path_shortener::shorten_path;
use crate::provider::Provider;
use crate::utils::{expand_path, get_repository_branch};
use std::fs;
use std::path::Path;

const WORLD_TREES_PATH: &str = "~/world/trees";

/// Provider for worktree-based candidates from ~/world/trees
pub struct WorktreeProvider;

impl Default for WorktreeProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl WorktreeProvider {
    pub fn new() -> Self {
        WorktreeProvider
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
        let world_trees_path = expand_path(WORLD_TREES_PATH);
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

    #[test]
    fn test_worktree_provider_creation() {
        let provider = WorktreeProvider::new();
        let mut candidates = Vec::new();
        // This should not panic
        provider.add_candidates(&mut candidates);
    }
} 