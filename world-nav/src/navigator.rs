use crate::worktree_collector::WorktreeCollector;
use atty;
use skim::prelude::*;
use skim::Skim;
use std::cell::RefCell;
use std::rc::Rc;

pub struct WorktreeNavigator;

impl WorktreeNavigator {
    pub fn new() -> Self {
        WorktreeNavigator {}
    }

    pub fn list(&self, query: &str, show_scores: bool) -> Vec<String> {
        let collector = WorktreeCollector::new(show_scores);
        let items = collector.filter_and_score(query);
        let mut paths = Vec::new();
        for item in items {
            if show_scores {
                paths.push(format!(
                    "(total:{:.2}, score:{:.2}, frecency:{:.2}, worktree:{:.2}) {}",
                    item.total_score(),
                    item.score,
                    item.frecency_score,
                    item.worktree_adjustment,
                    item.candidate.path
                ));
            } else {
                paths.push(item.candidate.path.clone());
            }
        }
        paths
    }

    pub fn navigate(
        &self,
        query: &str,
        show_scores: bool,
        multi: bool,
        prompt: &str,
        height: &str,
    ) -> Vec<String> {
        let cmd_collector = WorktreeCollector::new(show_scores);

        if !atty::is(atty::Stream::Stdin) {
            let filtered = cmd_collector.filter_and_score(query);
            return filtered
                .into_iter()
                .map(|item| item.candidate.path.clone())
                .collect();
        }

        if !multi && !query.is_empty() {
            let filtered = cmd_collector.filter_and_score(query);
            if filtered.len() == 1 {
                return vec![filtered[0].candidate.path.clone()];
            }

            if filtered.len() > 1 {
                let first_score = filtered[0].total_score();
                let second_score = filtered[1].total_score();

                let has_clear_winner =
                    first_score / second_score > 1.5 || first_score - second_score > 100.0;
                if has_clear_winner {
                    return vec![filtered[0].candidate.path.clone()];
                }
            }
        }

        let mut options_builder = SkimOptionsBuilder::default();
        options_builder
            .ansi(true)
            .reverse(true)
            .multi(multi)
            .interactive(true)
            .cmd_prompt(prompt.to_string())
            .select_1(!multi)
            .cmd_query(Some(query.to_string()))
            .cmd_collector(Rc::from(RefCell::from(cmd_collector)))
            .cmd(Some("{}".to_string()))
            .no_sort(true);

        if height != "100%" {
            options_builder
                .no_clear(true)
                .no_clear_start(true)
                .height(height.to_string());
        }

        let options = match options_builder.build() {
            Ok(opts) => opts,
            Err(_) => return Vec::new(), // Return empty if options can't be built
        };

        let selected_items = Skim::run_with(&options, None)
            .filter(|out| !out.is_abort)
            .map(|out| out.selected_items)
            .unwrap_or_default();

        selected_items
            .into_iter()
            .map(|item| item.output().into_owned())
            .collect()
    }
}

impl Default for WorktreeNavigator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    #![allow(clippy::expect_used)]
    use super::*;
    use crate::test_utils::test_env::TestEnvironment;
    use crate::FrecencyDb;

    #[test]
    fn test_navigator_list_without_scores() {
        let navigator = WorktreeNavigator::new();
        let results = navigator.list("", false);

        // Should return paths without score information
        for path in &results {
            assert!(!path.contains("(total:"));
            assert!(!path.contains("frecency:"));
        }
    }

    #[test]
    fn test_navigator_list_with_scores() {
        let navigator = WorktreeNavigator::new();
        let results = navigator.list("", true);

        // Should return paths with score information
        for path in &results {
            assert!(path.contains("(total:"));
            assert!(path.contains("score:"));
            assert!(path.contains("frecency:"));
            assert!(path.contains("worktree:"));
        }
    }

    #[test]
    fn test_navigator_new() {
        let navigator = WorktreeNavigator::new();
        // Just ensure we can create a navigator
        let _ = navigator.list("test", false);
    }

    #[test]
    fn test_frecency_integration() {
        // Create test environment
        let env = TestEnvironment::new();

        // Set up test repositories and worktrees
        let _test_repo = env.create_git_repo("test-repo");
        let _worktree =
            env.create_worktree_project("test-worktree", "test-category", "test-project");

        // Write config and set environment
        env.write_config(None);
        env.set_config_env();

        // Use FrecencyDb directly
        let frecency_db = FrecencyDb::new();

        // Visit a path multiple times - use a simple path
        let simple_path = "/test/simple/path";
        frecency_db.visit(simple_path, 1).unwrap();
        frecency_db.visit(simple_path, 1).unwrap();

        // Use navigator to list paths
        let navigator = WorktreeNavigator::new();
        let paths = navigator.list("", true);

        // Should contain frecency scores in the output
        let output_str = paths.join("\n");

        // Just verify we have the expected format for scores
        if !paths.is_empty() {
            assert!(
                output_str.contains("total:") || output_str.contains("score:"),
                "Expected output to contain 'total:' or 'score:', but got: '{output_str}'"
            );
        }

        // The test environment is dropped here, cleaning up env vars
    }

    #[test]
    fn test_custom_config() {
        use std::fs;

        // Ensure clean environment
        std::env::remove_var("WORLD_NAV_CONFIG");

        // Create test environment
        let env = TestEnvironment::new();

        // Create multiple source paths
        let main_src = env.temp_dir.path().join("main-src");
        let alt_src = env.temp_dir.path().join("alt-src");
        fs::create_dir_all(&main_src).unwrap();
        fs::create_dir_all(&alt_src).unwrap();

        // Create repos in both locations using git2
        let repo1_path = main_src.join("repo1");
        fs::create_dir_all(&repo1_path).unwrap();
        git2::Repository::init(&repo1_path).expect("Failed to init repo1");

        let repo2_path = alt_src.join("repo2");
        fs::create_dir_all(&repo2_path).unwrap();
        git2::Repository::init(&repo2_path).expect("Failed to init repo2");

        // Write custom config with no world path and multiple src paths
        let custom_config = format!(
            r#"{{
  "world_path": null,
  "src_paths": ["{}", "{}"],
  "depth_limit": 2,
  "frecency_db_path": "{}"
}}"#,
            main_src.to_string_lossy(),
            alt_src.to_string_lossy(),
            env.frecency_db_path.to_string_lossy()
        );

        env.write_config(Some(&custom_config));
        env.set_config_env();

        // Use navigator to list paths
        let navigator = WorktreeNavigator::new();
        let paths = navigator.list("", false);
        let output_str = paths.join("\n");

        // Should find both repositories but no worktree paths
        assert!(output_str.contains("repo1"), "Should find repo1");
        assert!(output_str.contains("repo2"), "Should find repo2");
        assert!(
            !output_str.contains("world/trees"),
            "Should not contain world paths"
        );
    }

    // Note: navigate() method tests are omitted because they involve interactive
    // skim UI which can't be properly tested in unit tests. The method accepts
    // a height parameter that configures the UI when height != "100%"
}
