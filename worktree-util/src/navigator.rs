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
        let collector = WorktreeCollector::new();
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

    pub fn navigate(&self, query: &str) -> Option<String> {
        let cmd_collector = WorktreeCollector::new();

        if !atty::is(atty::Stream::Stdin) {
            let filtered = cmd_collector.filter_and_score(query);
            for item in filtered {
                println!("{}", item.candidate.path);
            }
            return None;
        }

        let options = SkimOptionsBuilder::default()
            .ansi(true)
            .height("40%".to_string())
            .reverse(true)
            .multi(false)
            .select_1(true)
            .query(Some(query.to_string()))
            .cmd_collector(Rc::from(RefCell::from(cmd_collector)))
            .cmd(Some("{}".to_string()))
            .build()
            .expect("Failed to build skim options");

        let selected_items = Skim::run_with(&options, None)
            .filter(|out| !out.is_abort)
            .map(|out| out.selected_items)
            .unwrap_or_default();

        selected_items
            .first()
            .map(|item| item.output().into_owned())
    }
}

impl Default for WorktreeNavigator {
    fn default() -> Self {
        Self::new()
    }
}
