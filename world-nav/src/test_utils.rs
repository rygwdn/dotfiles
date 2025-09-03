#![allow(clippy::unwrap_used)]
#![allow(clippy::expect_used)]

#[cfg(test)]
pub mod scorer_test_utils {
    use crate::candidate::Candidate;
    use crate::path_shortener::shorten_path;
    use std::path::Path;

    pub fn candidate(pattern: &str) -> Candidate {
        let text = pattern.replace("[", "").replace("]", "").replace("🌍 ", "");

        if !text.contains("//") {
            let home_path = format!("/home/user/{text}");
            return Candidate {
                path: home_path.clone(),
                shortpath: shorten_path(Path::new(&home_path)),
                branch: None,
            };
        }

        let (worktree, rest): (&str, &str) = text
            .split_once("//")
            .expect("Test pattern should contain '//' for worktree paths");
        let (project, branch): (&str, &str) = rest.split_once(" ").unwrap_or((rest, ""));
        let path = format!("/world/trees/{worktree}/src/areas/category/{project}");

        Candidate {
            path: path.clone(),
            shortpath: shorten_path(Path::new(&path)),
            branch: if branch.is_empty() {
                None
            } else {
                Some(branch.to_string())
            },
        }
    }

    pub fn add_brackets_to_match_text(match_text: &str, positions: &[usize]) -> String {
        let chars: Vec<char> = match_text.chars().collect();
        let mut result = String::new();
        let position_set: std::collections::HashSet<usize> = positions.iter().copied().collect();

        for (i, ch) in chars.iter().enumerate() {
            if position_set.contains(&i) {
                // Check if previous char was also matched (to avoid double brackets)
                if i == 0 || !position_set.contains(&(i - 1)) {
                    result.push('[');
                }
                result.push(*ch);
                // Check if next char is also matched
                if i == chars.len() - 1 || !position_set.contains(&(i + 1)) {
                    result.push(']');
                }
            } else {
                result.push(*ch);
            }
        }

        result
    }
}

pub mod test_env {
    use git2;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    pub struct TestEnvironment {
        pub temp_dir: TempDir,
        pub world_path: PathBuf,
        pub src_path: PathBuf,
        pub config_path: PathBuf,
        pub frecency_db_path: PathBuf,
    }

    impl Default for TestEnvironment {
        fn default() -> Self {
            Self::new()
        }
    }

    impl TestEnvironment {
        /// Creates a new test environment with basic structure
        pub fn new() -> Self {
            let temp_dir = TempDir::new().expect("Failed to create temp dir");
            let temp_path = temp_dir.path();

            let world_path = temp_path.join("world/trees");
            let src_path = temp_path.join("src");
            let config_path = temp_path.join("config.json");
            let frecency_db_path = temp_path.join("frecency.db");

            fs::create_dir_all(&world_path).expect("Failed to create world path");
            fs::create_dir_all(&src_path).expect("Failed to create src path");

            TestEnvironment {
                temp_dir,
                world_path,
                src_path,
                config_path,
                frecency_db_path,
            }
        }

        /// Creates a git repository in the src directory with actual git init
        pub fn create_git_repo(&self, name: &str) -> PathBuf {
            let repo_path = self.src_path.join(name);
            fs::create_dir_all(&repo_path).expect("Failed to create repo dir");

            // Use git2 to initialize repository
            git2::Repository::init(&repo_path).expect("Failed to init git repo");

            repo_path
        }

        /// Creates a nested git repository
        pub fn create_nested_git_repo(&self, path: &str) -> PathBuf {
            let full_path = self.src_path.join(path);
            fs::create_dir_all(&full_path).expect("Failed to create nested repo dir");

            // Use git2 to initialize repository
            git2::Repository::init(&full_path).expect("Failed to init git repo");

            full_path
        }

        /// Creates a worktree project structure
        pub fn create_worktree_project(
            &self,
            worktree: &str,
            category: &str,
            project: &str,
        ) -> PathBuf {
            let project_path = self
                .world_path
                .join(worktree)
                .join("src/areas")
                .join(category)
                .join(project);
            fs::create_dir_all(&project_path).expect("Failed to create worktree project");
            project_path
        }

        /// Writes a config file with the test paths
        pub fn write_config(&self, custom_config: Option<&str>) {
            let config_content = match custom_config {
                Some(config) => config.to_string(),
                None => format!(
                    r#"{{
  "world_path": "{}",
  "src_paths": ["{}"],
  "depth_limit": 3,
  "frecency_db_path": "{}"
}}"#,
                    self.world_path.to_string_lossy(),
                    self.src_path.to_string_lossy(),
                    self.frecency_db_path.to_string_lossy()
                ),
            };

            fs::write(&self.config_path, config_content).expect("Failed to write config");
        }

        /// Sets the WORLD_NAV_CONFIG environment variable to point to this test config
        pub fn set_config_env(&self) {
            std::env::set_var("WORLD_NAV_CONFIG", self.config_path.to_str().unwrap());
        }

        /// Cleans up the environment variable
        pub fn cleanup(&self) {
            std::env::remove_var("WORLD_NAV_CONFIG");
        }
    }

    impl Drop for TestEnvironment {
        fn drop(&mut self) {
            // Automatically clean up environment variable when test environment is dropped
            self.cleanup();
        }
    }
}
