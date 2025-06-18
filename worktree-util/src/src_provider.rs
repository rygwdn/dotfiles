use crate::candidate::Candidate;
use crate::path_shortener::shorten_path;
use crate::provider::Provider;
use crate::utils::{expand_path, get_repository_branch};
use std::fs;
use std::path::Path;

const SRC_PATH: &str = "~/src";

/// Provider for source code repositories from ~/src
pub struct SrcProvider;

impl SrcProvider {
    pub fn new() -> Self {
        SrcProvider
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
                let branch = get_repository_branch(&repo_path);

                candidates.push(Candidate {
                    path: repo_path.clone(),
                    shortpath: shorten_path(Path::new(&repo_path)),
                    branch,
                });
            }
        }
    }
}

impl Provider for SrcProvider {
    fn add_candidates(&self, candidates: &mut Vec<Candidate>) {
        let src_path = expand_path(SRC_PATH);
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_src_provider_creation() {
        let provider = SrcProvider::new();
        let mut candidates = Vec::new();
        // This should not panic
        provider.add_candidates(&mut candidates);
    }
} 