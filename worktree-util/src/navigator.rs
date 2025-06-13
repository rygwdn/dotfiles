use crate::candidate::Candidate;
use crate::candidate_provider::CandidateProvider;
use crate::scorer::OptimalScorer;
use crate::zoxide_scores::ZoxideScores;
use atty;
use crossbeam_channel::Sender;
use skim::prelude::*;
use skim::{reader::CommandCollector, Skim};
use std::cell::RefCell;
use std::env;
use std::rc::Rc;
use std::sync::{atomic::AtomicUsize, Arc};

struct CandidateItem {
    pub candidate: Candidate,
    pub score: f64,
    pub zoxide_score: f64,
    pub worktree_adjustment: f64,
}

impl CandidateItem {
    fn total_score(&self) -> f64 {
        self.score + self.zoxide_score + self.worktree_adjustment
    }
}

impl SkimItem for CandidateItem {
    fn text(&self) -> Cow<str> {
        Cow::Owned(self.candidate.get_match_text())
    }

    fn display<'a>(&'a self, _context: DisplayContext<'a>) -> AnsiString<'a> {
        AnsiString::parse(self.candidate.display().as_str())
    }

    fn preview(&self, _context: PreviewContext) -> ItemPreview {
        ItemPreview::Text(self.candidate.path.clone())
    }

    fn output(&self) -> Cow<str> {
        Cow::Borrowed(&self.candidate.path)
    }
}

struct WorktreeCollector {
    candidates: Vec<Candidate>,
    scorer: OptimalScorer,
    zoxide_scores: ZoxideScores,
}

impl WorktreeCollector {
    fn new() -> Self {
        Self {
            candidates: CandidateProvider::new().get_candidates(),
            scorer: OptimalScorer::new(
                env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
            ),
            zoxide_scores: ZoxideScores::new(),
        }
    }

    fn filter_and_score(&self, query: &str) -> Vec<Arc<CandidateItem>> {
        let mut items: Vec<CandidateItem> = self
            .candidates
            .iter()
            .filter_map(|candidate| {
                let score = self.scorer.score_candidate(candidate, query);
                if score > 0.0 || query.is_empty() {
                    Some(CandidateItem {
                        candidate: candidate.clone(),
                        score,
                        zoxide_score: self.zoxide_scores.get_score(&candidate.path),
                        worktree_adjustment: self.scorer.worktree_adjustment(candidate),
                    })
                } else {
                    None
                }
            })
            .collect();

        items.sort_by(|a, b| {
            b.total_score()
                .partial_cmp(&a.total_score())
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        items.into_iter().map(Arc::new).collect()
    }
}

impl CommandCollector for WorktreeCollector {
    fn invoke(
        &mut self,
        cmd: &str,
        _components_to_stop: Arc<AtomicUsize>,
    ) -> (SkimItemReceiver, Sender<i32>) {
        let (tx, rx) = unbounded::<Arc<dyn SkimItem>>();
        let (tx_interrupt, _rx_interrupt) = unbounded();

        let items = self.filter_and_score(cmd);
        for item in items {
            let _ = tx.send(item);
        }

        (rx, tx_interrupt)
    }
}

// TODO: split navigator and worktree collector into separate modules
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
