use crate::candidate::Candidate;
use crate::candidate_provider::CandidateProvider;
use crate::scorer::OptimalScorer;
use atty;
use crossbeam_channel::Sender;
use skim::prelude::*;
use skim::{reader::CommandCollector, Skim};
use std::cell::RefCell;
use std::env;
use std::rc::Rc;
use std::sync::{atomic::AtomicUsize, Arc};

// Custom CommandCollector for dynamic filtering
struct WorktreeCollector {
    candidates: Vec<Candidate>,
    scorer: OptimalScorer,
}

impl WorktreeCollector {
    fn new(candidates: Vec<Candidate>) -> Self {
        Self {
            candidates,
            scorer: OptimalScorer::new(),
        }
    }

    fn filter_and_score(&self, query: &str) -> Vec<Arc<dyn SkimItem>> {
        if query.is_empty() {
            // Return all candidates without scoring
            self.candidates
                .iter()
                .map(|c| Arc::new(c.clone()) as Arc<dyn SkimItem>)
                .collect()
        } else {
            // Filter and score candidates
            let mut scored: Vec<Candidate> = self
                .candidates
                .iter()
                .filter_map(|candidate| {
                    let score = self.scorer.score_candidate(candidate, query);
                    if score > 0.0 {
                        let mut new_candidate = candidate.clone();
                        new_candidate.query_score = score;
                        new_candidate.total_score = candidate.score + score;
                        Some(new_candidate)
                    } else {
                        None
                    }
                })
                .collect();

            // Sort by total score (highest first)
            scored.sort_by(|a, b| b.total_score.partial_cmp(&a.total_score).unwrap());

            scored
                .into_iter()
                .map(|c| Arc::new(c) as Arc<dyn SkimItem>)
                .collect()
        }
    }
}

impl CommandCollector for WorktreeCollector {
    fn invoke(
        &mut self,
        cmd: &str,
        _components_to_stop: Arc<AtomicUsize>,
    ) -> (SkimItemReceiver, Sender<i32>) {
        let (tx, rx) = unbounded();
        let (tx_interrupt, _rx_interrupt) = unbounded();

        let items = self.filter_and_score(cmd);
        for item in items {
            tx.send(item).unwrap();
        }

        (rx, tx_interrupt)
    }
}

pub struct WorktreeNavigator {
    candidate_provider: CandidateProvider,
    scorer: OptimalScorer,
}

impl WorktreeNavigator {
    pub fn new() -> Self {
        let current_dir = env::current_dir().unwrap_or_default();
        let candidate_provider = CandidateProvider::new(&current_dir);

        WorktreeNavigator {
            candidate_provider,
            scorer: OptimalScorer::new(),
        }
    }

    pub fn get_candidates(&self) -> Vec<Candidate> {
        self.candidate_provider.get_candidates()
    }

    pub fn filter_and_score(&self, candidates: &[Candidate], query: &str) -> Vec<Candidate> {
        if query.is_empty() {
            return candidates.to_vec();
        }

        let mut scored: Vec<Candidate> = candidates
            .iter()
            .filter_map(|candidate| {
                let score = self.scorer.score_candidate(candidate, query);
                if score > 0.0 {
                    let mut new_candidate = candidate.clone();
                    new_candidate.query_score = score;
                    new_candidate.total_score = candidate.score + score;
                    Some(new_candidate)
                } else {
                    None
                }
            })
            .collect();

        scored.sort_by(|a, b| b.total_score.partial_cmp(&a.total_score).unwrap());
        scored
    }

    pub fn clean_for_list(match_string: &str) -> String {
        // Remove leading symbols and clean up for tab completion
        match_string
            .trim_start_matches(|c: char| {
                matches!(c, '\u{f484}' | '\u{e0a0}' | '\u{ea84}' | '~' | '/')
            })
            .trim_start()
            .split(" [")
            .next()
            .unwrap_or("")
            .replace("//", "/")
    }

    pub fn navigate(&self, query: &str) -> Option<String> {
        let candidates = self.get_candidates();

        // Check if we're running in a TTY - if not, output filtered list instead
        if !atty::is(atty::Stream::Stdin) {
            // Non-interactive mode: filter and output list
            let filtered = self.filter_and_score(&candidates, query);

            for candidate in filtered {
                println!("{}\t{}", candidate.display(), candidate.path);
            }

            // Return None since we're not selecting a single item
            return None;
        }

        // If we have a query, try to find matches
        if !query.is_empty() {
            let matched = self.filter_and_score(&candidates, query);

            // If there's exactly one match or a clear best match, jump directly to it
            if matched.len() == 1
                || (matched.len() > 1 && matched[0].total_score > matched[1].total_score + 200.0)
            {
                return Some(matched[0].path.clone());
            }
        }

        let cmd_collector = WorktreeCollector::new(candidates.clone());

        let options = SkimOptionsBuilder::default()
            .ansi(true)
            .height("40%".to_string())
            .reverse(true)
            .multi(false)
            .query(if query.is_empty() {
                None
            } else {
                Some(query.to_string())
            })
            .cmd_collector(Rc::from(RefCell::from(cmd_collector)))
            .cmd(Some("{}".to_string()))
            .build()
            .unwrap();

        let selected_items = Skim::run_with(&options, None)
            .filter(|out| !out.is_abort)
            .map(|out| out.selected_items)
            .unwrap_or_default();

        if let Some(item) = selected_items.first() {
            Some(item.output().into_owned())
        } else {
            None
        }
    }
}

impl Default for WorktreeNavigator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path_shortener::shorten_path;
    use std::path::Path;

    fn create_test_candidate(name: &str, base_score: f64) -> Candidate {
        // Create a proper path based on the name pattern
        let path = if name.starts_with('+') {
            // World tree pattern: +worktree//project
            let parts: Vec<&str> = name[1..].split("//").collect();
            let worktree_name = parts.get(0).unwrap_or(&"root");
            let project_name = parts.get(1).unwrap_or(&"project");
            format!(
                "/world/trees/{}/src/areas/category/{}",
                worktree_name, project_name
            )
        } else if name.starts_with('~') {
            // GitHub pattern: ~github.com/owner/repo
            let parts: Vec<&str> = name[1..].split('/').collect();
            let site = parts.get(0).unwrap_or(&"github.com");
            let owner = parts.get(1).unwrap_or(&"owner");
            let repo = parts.get(2).unwrap_or(&"repo");
            format!("/home/user/src/{}/{}/{}", site, owner, repo)
        } else {
            // Regular path
            format!("/path/to/{}", name)
        };

        Candidate {
            score: base_score,
            zoxide_score: 0.0,
            base_score,
            query_score: 0.0,
            total_score: base_score,
            path: path.clone(),
            shortpath: shorten_path(&Path::new(&path)),
            branch: None,
        }
    }

    #[test]
    fn test_filter_and_score() {
        let test_candidates = vec![
            create_test_candidate("+root//web-frontend", 200.0),
            create_test_candidate("+other//web-frontend", 0.0),
            create_test_candidate("+random-fixes//platform", 0.0),
            create_test_candidate("~github.com/Platform/web-frontend", -50.0),
            create_test_candidate("~github.com/rygwdn/gt-mcp", -50.0),
            create_test_candidate("+root//platform", 200.0),
            create_test_candidate("+random-stuff//core", 0.0),
            create_test_candidate("+root//analytics", 200.0),
        ];

        let navigator = WorktreeNavigator::new();

        // Test 'wf' query
        let filtered = navigator.filter_and_score(&test_candidates, "wf");
        assert!(!filtered.is_empty(), "Should find matches for 'wf'");
        assert!(
            filtered
                .iter()
                .any(|c| c.get_match_text().contains("web-frontend")),
            "Should match web-frontend for 'wf'"
        );

        // Test 'frontend' query
        let filtered = navigator.filter_and_score(&test_candidates, "frontend");
        assert_eq!(filtered.len(), 3, "Should find all web-frontend entries");
        assert!(
            filtered
                .iter()
                .all(|c| c.get_match_text().contains("frontend")),
            "All results should contain 'frontend'"
        );

        // Test 'plat' query
        let filtered = navigator.filter_and_score(&test_candidates, "plat");
        assert!(
            filtered
                .iter()
                .any(|c| c.get_match_text().contains("platform")
                    || c.get_match_text().contains("Platform")),
            "Should match platform (case insensitive)"
        );

        // Test no matches
        let filtered = navigator.filter_and_score(&test_candidates, "xyz");
        assert_eq!(filtered.len(), 0, "Should return empty for no matches");
    }

    #[test]
    fn test_clean_for_list() {
        // Test removing leading symbols
        assert_eq!(
            WorktreeNavigator::clean_for_list("\u{f484}world//project"),
            "world/project"
        );
        assert_eq!(
            WorktreeNavigator::clean_for_list("~github.com/owner/repo"),
            "github.com/owner/repo"
        );

        // Test removing branch info
        assert_eq!(
            WorktreeNavigator::clean_for_list("project [main]"),
            "project"
        );

        // Test double slash conversion
        assert_eq!(
            WorktreeNavigator::clean_for_list("worktree//project"),
            "worktree/project"
        );
    }
}
