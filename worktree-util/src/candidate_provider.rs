use crate::candidate::Candidate;
use crate::path_shortener::shorten_path;
use git2::Repository;
use std::fs;
use std::path::{Path, PathBuf};

const WORLD_TREES_PATH: &str = "~/world/trees";
const SRC_PATH: &str = "~/src";

#[derive(Default)]
pub struct CandidateProvider;

impl CandidateProvider {
    pub fn new() -> Self {
        CandidateProvider {}
    }

    pub fn get_candidates(&self) -> Vec<Candidate> {
        let mut candidates = Vec::new();
        self.add_worktree_candidates(&mut candidates);
        self.add_src_candidates(&mut candidates);
        candidates
    }

    fn add_worktree_candidates(&self, candidates: &mut Vec<Candidate>) {
        let world_trees_path = Self::expand_path(WORLD_TREES_PATH);
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

    fn process_worktree_areas(&self, areas_path: &Path, candidates: &mut Vec<Candidate>) {
        let Ok(category_entries) = fs::read_dir(areas_path) else {
            return;
        };
        let branch = areas_path.to_str().and_then(Self::get_repository_branch);

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

    fn add_src_candidates(&self, candidates: &mut Vec<Candidate>) {
        let src_path = Self::expand_path(SRC_PATH);
        if !src_path.exists() {
            return;
        }

        let Ok(site_entries) = fs::read_dir(&src_path) else {
            return;
        };

        for site_entry in site_entries.filter_map(Result::ok) {
            let site_dir = site_entry.path();
            if !site_dir.is_dir() {
                continue;
            }

            self.process_site_directory(&site_dir, candidates);
        }
    }

    fn process_site_directory(&self, site_dir: &Path, candidates: &mut Vec<Candidate>) {
        let Ok(owner_entries) = fs::read_dir(site_dir) else {
            return;
        };

        for owner_entry in owner_entries.filter_map(Result::ok) {
            let owner_dir = owner_entry.path();
            if !owner_dir.is_dir() {
                continue;
            }

            let Ok(repo_entries) = fs::read_dir(&owner_dir) else {
                continue;
            };

            for repo_entry in repo_entries.filter_map(Result::ok) {
                let repo_dir = repo_entry.path();
                if !repo_dir.is_dir() || !repo_dir.join(".git").exists() {
                    continue;
                }

                let repo_path = repo_dir
                    .canonicalize()
                    .unwrap_or(repo_dir.clone())
                    .to_string_lossy()
                    .into_owned();

                // Get branch for this repository
                let branch = Self::get_repository_branch(&repo_path);

                candidates.push(Candidate {
                    path: repo_path.clone(),
                    shortpath: shorten_path(Path::new(&repo_path)),
                    branch,
                });
            }
        }
    }

    pub fn expand_path(path: &str) -> PathBuf {
        if path.starts_with('~') {
            if let Some(home) = dirs::home_dir() {
                home.join(&path[2..])
            } else {
                PathBuf::from(path)
            }
        } else {
            PathBuf::from(path)
        }
    }

    pub fn get_repository_branch(repo_path: &str) -> Option<String> {
        let repo = Repository::open_ext(
            repo_path,
            git2::RepositoryOpenFlags::empty(),
            vec![WORLD_TREES_PATH, SRC_PATH],
        )
        .ok()?;
        let head = repo.head().ok()?;

        if !head.is_branch() {
            return None;
        }

        let branch_name = head.shorthand()?;
        if branch_name == "master" || branch_name == "main" {
            return None;
        }

        Some(branch_name.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_expand_path_with_home() {
        let home_dir = dirs::home_dir().expect("Home directory should exist");

        // Test expanding ~
        let expanded = CandidateProvider::expand_path("~/test");
        assert_eq!(expanded, home_dir.join("test"));

        // Test expanding ~/sub/path
        let expanded = CandidateProvider::expand_path("~/sub/path");
        assert_eq!(expanded, home_dir.join("sub/path"));
    }

    #[test]
    fn test_expand_path_without_home() {
        // Test regular path
        let expanded = CandidateProvider::expand_path("/absolute/path");
        assert_eq!(expanded, PathBuf::from("/absolute/path"));

        // Test relative path
        let expanded = CandidateProvider::expand_path("relative/path");
        assert_eq!(expanded, PathBuf::from("relative/path"));
    }

    #[test]
    fn test_repository_branch_detection() {
        // This test would require creating actual git repos, so we'll test the None cases

        // Test with non-existent path
        let result = CandidateProvider::get_repository_branch("/non/existent/path");
        assert_eq!(result, None);

        // Test with current directory (may or may not be a git repo)
        if let Ok(current_dir) = env::current_dir() {
            let result = CandidateProvider::get_repository_branch(&current_dir.to_string_lossy());
            // If it returns Some, it should not be master or main
            if let Some(branch) = result {
                assert_ne!(branch, "master");
                assert_ne!(branch, "main");
            }
        }
    }
}
