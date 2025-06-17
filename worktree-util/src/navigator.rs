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
                    "(total:{:.2}, score:{:.2}, zoxide:{:.2}, worktree:{:.2}) {}",
                    item.total_score(),
                    item.score,
                    item.zoxide_score,
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

        let options = SkimOptionsBuilder::default()
            .ansi(true)
            .height("40%".to_string())
            .reverse(true)
            .multi(multi)
            .interactive(true)
            .cmd_prompt(prompt.to_string())
            .select_1(!multi)
            .cmd_query(Some(query.to_string()))
            .cmd_collector(Rc::from(RefCell::from(cmd_collector)))
            .cmd(Some("{}".to_string()))
            .no_sort(true)
            .build()
            .expect("Failed to build skim options");

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
