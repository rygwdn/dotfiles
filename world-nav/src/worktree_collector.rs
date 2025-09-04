use crate::candidate::Candidate;
use crate::candidate_provider::CandidateProvider;
use crate::frecency::FrecencyDb;
use crate::scorer::OptimalScorer;
use crossbeam_channel::Sender;
use skim::prelude::*;
use skim::reader::CommandCollector;
use std::env;
use std::sync::{atomic::AtomicUsize, Arc};

pub struct CandidateItem {
    pub candidate: Candidate,
    pub score: f64,
    pub frecency_score: f64,
    pub worktree_adjustment: f64,
    pub show_scores: bool,
    pub index: usize,
}

impl CandidateItem {
    pub fn total_score(&self) -> f64 {
        self.score + self.frecency_score + self.worktree_adjustment
    }
}

impl SkimItem for CandidateItem {
    fn text(&self) -> Cow<'_, str> {
        Cow::Owned(self.candidate.get_match_text())
    }

    fn display<'a>(&'a self, _context: DisplayContext<'a>) -> AnsiString<'a> {
        let display_str = if self.show_scores {
            format!(
                "{} \x1b[2m({:.2})\x1b[0m",
                self.candidate.display(),
                self.total_score()
            )
        } else {
            self.candidate.display()
        };

        AnsiString::parse(display_str.as_str())
    }

    fn preview(&self, _context: PreviewContext) -> ItemPreview {
        ItemPreview::Text(self.candidate.path.clone())
    }

    fn output(&self) -> Cow<'_, str> {
        Cow::Borrowed(&self.candidate.path)
    }
    fn get_index(&self) -> usize {
        self.index
    }
    fn set_index(&mut self, index: usize) {
        self.index = index;
    }
}

pub struct WorktreeCollector {
    candidates: Vec<Candidate>,
    scorer: OptimalScorer,
    frecency_db: FrecencyDb,
    show_scores: bool,
}

impl WorktreeCollector {
    pub fn new(show_scores: bool) -> Self {
        Self {
            candidates: CandidateProvider::new().get_candidates(),
            scorer: OptimalScorer::new(
                env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
            ),
            frecency_db: FrecencyDb::new(),
            show_scores,
        }
    }

    pub fn filter_and_score(&self, query: &str) -> Vec<Arc<CandidateItem>> {
        let mut items: Vec<CandidateItem> = self
            .candidates
            .iter()
            .filter_map(|candidate| {
                let score = self.scorer.score_candidate(candidate, query);
                if score > 0.0 || query.is_empty() {
                    let frecency_score = self.frecency_db.get_score(&candidate.path);

                    Some(CandidateItem {
                        candidate: candidate.clone(),
                        score,
                        frecency_score,
                        worktree_adjustment: self.scorer.worktree_adjustment(candidate),
                        show_scores: self.show_scores,
                        index: 0,
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

        items
            .into_iter()
            .enumerate()
            .map(|(i, mut item)| {
                item.set_index(i);
                Arc::new(item)
            })
            .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_candidate_item_total_score() {
        use crate::path_shortener::shorten_path;
        use std::path::Path;

        let candidate = Candidate {
            path: "/test/path".to_string(),
            shortpath: shorten_path(Path::new("/test/path")),
            branch: None,
        };

        let item = CandidateItem {
            candidate,
            score: 50.0,
            frecency_score: 30.0,
            worktree_adjustment: 20.0,
            show_scores: false,
            index: 0,
        };

        assert_eq!(item.total_score(), 100.0);
    }

    #[test]
    fn test_candidate_item_display() {
        use crate::path_shortener::shorten_path;
        use std::path::Path;

        let candidate = Candidate {
            path: "/test/path".to_string(),
            shortpath: shorten_path(Path::new("/test/path")),
            branch: Some("feature".to_string()),
        };

        let item = CandidateItem {
            candidate: candidate.clone(),
            score: 50.0,
            frecency_score: 30.0,
            worktree_adjustment: 20.0,
            show_scores: false,
            index: 0,
        };

        // Test text method
        assert_eq!(item.text().as_ref(), candidate.get_match_text());

        // Test that scores are included in total_score calculation
        let item_with_scores = CandidateItem {
            candidate: candidate.clone(),
            score: 50.0,
            frecency_score: 30.0,
            worktree_adjustment: 20.0,
            show_scores: true,
            index: 0,
        };

        assert_eq!(item_with_scores.total_score(), 100.0);
    }
}
