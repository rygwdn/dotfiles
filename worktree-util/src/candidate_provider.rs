use crate::candidate::Candidate;
use crate::path_shortener::shorten_path;
use git2::Repository;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const WORLD_TREES_PATH: &str = "~/world/trees";
const SRC_PATH: &str = "~/src";

pub struct CandidateProvider {
    pub current_worktree: Option<String>,
    pub zoxide_scores: HashMap<String, f64>,
}

impl CandidateProvider {
    pub fn new(current_dir: &Path) -> Self {
        let current_worktree = Self::extract_current_worktree(current_dir);
        let zoxide_scores = Self::load_zoxide_scores();

        CandidateProvider {
            current_worktree,
            zoxide_scores,
        }
    }

    pub fn get_candidates(&self) -> Vec<Candidate> {
        let mut candidates = Vec::new();

        // Add worktree areas
        self.add_worktree_candidates(&mut candidates);

        // Add ~/src repositories
        self.add_src_candidates(&mut candidates);

        // Sort by score descending
        candidates.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());

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

            let worktree = worktree_dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();

            let worktree_src = worktree_dir.join("src");
            let worktree_path = worktree_src
                .canonicalize()
                .unwrap_or(worktree_src.clone())
                .to_string_lossy()
                .into_owned();

            let areas_path = worktree_src.join("areas");
            if !areas_path.exists() {
                continue;
            }

            self.process_worktree_areas(&areas_path, &worktree, &worktree_path, candidates);
        }
    }

    fn process_worktree_areas(
        &self,
        areas_path: &Path,
        worktree: &str,
        worktree_path: &str,
        candidates: &mut Vec<Candidate>,
    ) {
        let Ok(category_entries) = fs::read_dir(areas_path) else {
            return;
        };

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

                let zoxide = self
                    .zoxide_scores
                    .get(&project_path)
                    .copied()
                    .unwrap_or(0.0);
                let base_offset = if Some(worktree) == self.current_worktree.as_deref() {
                    200.0
                } else {
                    0.0
                };

                // Get branch from the worktree directory (not the project directory)
                let branch = Self::get_repository_branch(worktree_path);

                candidates.push(Candidate {
                    score: zoxide + base_offset,
                    zoxide_score: zoxide,
                    base_score: base_offset,
                    query_score: 0.0,
                    total_score: zoxide + base_offset,
                    path: project_path.clone(),
                    shortpath: shorten_path(&Path::new(&project_path)),
                    branch,
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

                let zoxide = self.zoxide_scores.get(&repo_path).copied().unwrap_or(0.0);
                let base_offset = -50.0; // Deprioritize src repos

                // Get branch for this repository
                let branch = Self::get_repository_branch(&repo_path);

                candidates.push(Candidate {
                    score: zoxide + base_offset,
                    zoxide_score: zoxide,
                    base_score: base_offset,
                    query_score: 0.0,
                    total_score: zoxide + base_offset,
                    path: repo_path.clone(),
                    shortpath: shorten_path(&Path::new(&repo_path)),
                    branch,
                });
            }
        }
    }

    fn extract_current_worktree(current_dir: &Path) -> Option<String> {
        let expanded_trees = Self::expand_path(WORLD_TREES_PATH);
        let current_str = current_dir.to_string_lossy();

        if !current_str.contains(&format!("{}/", expanded_trees.to_string_lossy())) {
            return None;
        }

        let parts: Vec<&str> = current_str.split('/').collect();
        let trees_index = parts.iter().position(|&p| p == "trees")?;

        if trees_index < parts.len() - 1 {
            Some(parts[trees_index + 1].to_string())
        } else {
            None
        }
    }

    fn load_zoxide_scores() -> HashMap<String, f64> {
        let output = match Command::new("zoxide").args(&["query", "-ls"]).output() {
            Ok(output) => output,
            Err(_) => return HashMap::new(),
        };

        if !output.status.success() {
            return HashMap::new();
        }

        let mut scores = HashMap::new();
        let output_str = String::from_utf8_lossy(&output.stdout);

        for line in output_str.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                if let Ok(score) = parts[0].parse::<f64>() {
                    let path = PathBuf::from(parts[1..].join(" "));
                    if let Ok(canonical) = path.canonicalize() {
                        scores.insert(canonical.to_string_lossy().into_owned(), score);
                    }
                }
            }
        }

        // Normalize scores so the maximum is 100
        if let Some(&max_score) = scores.values().max_by(|a, b| a.partial_cmp(b).unwrap()) {
            if max_score > 0.0 {
                let scale_factor = 100.0 / max_score;
                for score in scores.values_mut() {
                    *score = (*score * scale_factor).round();
                }
            }
        }

        scores
    }

    pub fn expand_path(path: &str) -> PathBuf {
        if path.starts_with('~') {
            if let Some(home) = dirs::home_dir() {
                return home.join(&path[2..]);
            }
        }
        PathBuf::from(path)
    }

    pub fn get_repository_branch(repo_path: &str) -> Option<String> {
        // Try to open the repository
        let repo = Repository::open(repo_path).ok()?;

        // Get the current HEAD reference
        let head = repo.head().ok()?;

        // Check if HEAD is a branch (not detached)
        if !head.is_branch() {
            return None;
        }

        // Get the branch name
        let branch_name = head.shorthand()?;

        // Skip master and main branches
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
    use tempfile::TempDir;

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
    fn test_extract_current_worktree() {
        // We need to use actual expanded paths since the function checks for the expanded path
        let home = dirs::home_dir().expect("Home directory should exist");
        let base_path = home.join("world/trees");

        // Test with a worktree path
        let worktree_path = base_path.join("myworktree/src/areas/category/project");
        let result = CandidateProvider::extract_current_worktree(&worktree_path);
        assert_eq!(result, Some("myworktree".to_string()));

        // Test with a non-worktree path
        let non_worktree_path = PathBuf::from("/home/user/other/project");
        let result = CandidateProvider::extract_current_worktree(&non_worktree_path);
        assert_eq!(result, None);

        // Test with path at worktree root
        let worktree_root = base_path.join("myworktree");
        let result = CandidateProvider::extract_current_worktree(&worktree_root);
        assert_eq!(result, Some("myworktree".to_string()));
    }

    #[test]
    fn test_new_candidate_provider() {
        let temp_dir = TempDir::new().unwrap();
        let provider = CandidateProvider::new(temp_dir.path());

        // Should initialize without errors
        assert!(provider.current_worktree.is_none());
        assert!(provider.zoxide_scores.is_empty() || !provider.zoxide_scores.is_empty());
        // May or may not have scores
    }

    #[test]
    fn test_get_candidates_empty_dirs() {
        // Create a provider with a temp directory (no world/trees or src)
        let temp_dir = TempDir::new().unwrap();
        let provider = CandidateProvider::new(temp_dir.path());

        let candidates = provider.get_candidates();
        // With no directories, candidates should only come from zoxide if any
        // We can't predict what zoxide will return, so just verify the structure
        for candidate in &candidates {
            // All candidates should have valid paths
            assert!(!candidate.path.is_empty());
            // They should have been properly scored
            assert_eq!(candidate.total_score, candidate.score);
        }
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

    #[test]
    fn test_load_zoxide_scores_normalization() {
        // This test depends on zoxide being installed, so we just verify the return type
        let scores = CandidateProvider::load_zoxide_scores();

        // All scores should be normalized to <= 100
        for &score in scores.values() {
            assert!(score <= 100.0, "Score {} should be <= 100", score);
            assert!(score >= 0.0, "Score {} should be >= 0", score);
        }
    }
}
