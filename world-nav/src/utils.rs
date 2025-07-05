use git2::Repository;
use std::path::PathBuf;

const WORLD_TREES_PATH: &str = "~/world/trees";
const SRC_PATH: &str = "~/src";

/// Utility function to expand paths with ~ notation
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

/// Utility function to get the current branch of a git repository
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_expand_path_with_home() {
        let Some(home_dir) = dirs::home_dir() else {
            eprintln!("WARNING: Home directory not found, skipping test");
            return;
        };

        // Test expanding ~
        let expanded = expand_path("~/test");
        assert_eq!(expanded, home_dir.join("test"));

        // Test expanding ~/sub/path
        let expanded = expand_path("~/sub/path");
        assert_eq!(expanded, home_dir.join("sub/path"));
    }

    #[test]
    fn test_expand_path_without_home() {
        // Test regular path
        let expanded = expand_path("/absolute/path");
        assert_eq!(expanded, PathBuf::from("/absolute/path"));

        // Test relative path
        let expanded = expand_path("relative/path");
        assert_eq!(expanded, PathBuf::from("relative/path"));
    }

    #[test]
    fn test_repository_branch_detection() {
        // This test would require creating actual git repos, so we'll test the None cases

        // Test with non-existent path
        let result = get_repository_branch("/non/existent/path");
        assert_eq!(result, None);

        // Test with current directory (may or may not be a git repo)
        if let Ok(current_dir) = env::current_dir() {
            let result = get_repository_branch(&current_dir.to_string_lossy());
            // If it returns Some, it should not be master or main
            if let Some(branch) = result {
                assert_ne!(branch, "master");
                assert_ne!(branch, "main");
            }
        }
    }
}
