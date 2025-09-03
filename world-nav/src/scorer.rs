use crate::candidate::{Candidate, MatchSegment};
use crate::path_shortener::ComponentType;
use crate::path_shortener::{shorten_path, PathType};
use std::path::Path;

// Scoring constants
const BASE_CHAR_SCORE: f64 = 50.0;
const WORD_BOUNDARY_SCORE: f64 = 200.0;
const CONSECUTIVE_MULTIPLIER: f64 = 2.0;
const MAX_CONSECUTIVE_MULTIPLIER: f64 = 8.0;
const WORD_BOUNDARY_MULTIPLIER: f64 = 1.3;
const MAX_WORD_BOUNDARY_MULTIPLIER: f64 = 2.5;

// Section boost multipliers
const PROJECT_REPO_SLASH_BOOST: f64 = 1.5;
const WORKTREE_OWNER_SLASH_BOOST: f64 = 1.2;
const WORKTREE_OWNER_NO_SLASH_PENALTY: f64 = 0.7;
const BRANCH_SPACE_BOOST: f64 = 1.1;
const BRANCH_NO_SPACE_PENALTY: f64 = 0.5;

// Match bonuses
const PERFECT_MATCH_BONUS: f64 = 300.0;
const ALL_WORD_BOUNDARIES_BONUS: f64 = 50.0;
const ALL_CONSECUTIVE_BONUS: f64 = 150.0;
const EXACT_MATCH_BONUS: f64 = 500.0;
const PREFIX_MATCH_BONUS: f64 = 50.0;
const WORKTREE_PROXIMITY_BONUS: f64 = 200.0;

// Penalties
const SPAN_PENALTY: f64 = 10.0;
const DISTANCE_FROM_START_PENALTY: f64 = 0.5;
const NON_WORKTREE_PENALTY: f64 = -50.0;

/// Optimal path scoring algorithm
/// Finds the best possible character matches in paths and scores them intelligently
///
/// Scoring algorithm:
/// 1. Base score: Each matched character starts with BASE_CHAR_SCORE (50.0)
/// 2. Word boundary bonus: Characters at word boundaries get WORD_BOUNDARY_SCORE (200.0)
/// 3. Section-aware scoring:
///    - Project/Repo: 1.5x boost with '/', normal otherwise
///    - Worktree/Owner: 1.2x boost with '/', 0.7x penalty without '/'
///    - Branch: 1.1x boost with ' ', 0.5x penalty without ' '
/// 4. Consecutive multiplier: Each consecutive char doubles the score (max 8x)
/// 5. Word boundary multiplier: Consecutive word boundary matches get 1.5x multiplier (max 4x)
///    - Example: 'chwe' in [ch]eckout-[we]b gets bonuses for consecutive chars AND consecutive boundaries
/// 6. Match type bonuses:
///    - Perfect match (all word boundaries + consecutive): +300 per char
///    - All word boundaries: +50 per char
///    - All consecutive: +100 per char
///    - Exact match: +500
///    - Prefix match: +50
/// 7. Penalties:
///    - Span penalty: -10 per character in match span
///    - Distance penalty: -0.5 per character from main content start (after worktree/owner)
/// 8. Worktree adjustments:
///    - Same worktree bonus: +200 if candidate is in the same worktree as current directory
///    - Non-worktree penalty: -50 if candidate is not a worktree project
pub struct OptimalScorer {
    current_dir_worktree: Option<String>,
}

impl OptimalScorer {
    pub fn new(current_dir: String) -> Self {
        let current_dir_worktree = match shorten_path(Path::new(&current_dir)).path_type {
            PathType::WorldTree { worktree, .. } => Some(worktree),
            _ => None,
        };

        OptimalScorer {
            current_dir_worktree,
        }
    }

    /// Returns combined worktree proximity bonus and non-worktree penalty
    pub fn worktree_adjustment(&self, candidate: &Candidate) -> f64 {
        match &candidate.shortpath.path_type {
            PathType::WorldTree { worktree, .. } => match &self.current_dir_worktree {
                Some(current_wt) if current_wt == worktree => WORKTREE_PROXIMITY_BONUS,
                _ => 0.0,
            },
            _ => NON_WORKTREE_PENALTY,
        }
    }

    /// Score a candidate against a query using structured data
    pub fn score_candidate(&self, candidate: &Candidate, query: &str) -> f64 {
        let (score, _) = self.score_candidate_with_positions(candidate, query);
        score
    }

    /// Score a candidate against a query and return both score and match positions
    pub fn score_candidate_with_positions(
        &self,
        candidate: &Candidate,
        query: &str,
    ) -> (f64, Vec<usize>) {
        if query.is_empty() {
            return (0.0, Vec::new());
        }

        let segments = candidate.get_segments();
        let text = candidate.get_match_text();
        let query_has_slash = query.contains('/');
        let query_has_space = query.contains(' ');
        let query_trimmed = query.trim_end();
        let query_lower = query_trimmed.to_lowercase();
        let text_lower = text.to_lowercase();
        let query_chars: Vec<char> = query_lower.chars().collect();

        // Find ALL possible ways to match the query in the text
        let all_matches = Self::find_all_matches(&text_lower, &query_chars, 0, Vec::new());
        if all_matches.is_empty() {
            return (0.0, Vec::new());
        }

        // Score each possible match and return the best
        let mut best_score = 0.0;
        let mut best_positions = Vec::new();

        for positions in all_matches {
            let mut score = self.score_match(
                &text,
                &positions,
                &query_chars,
                query_has_slash,
                query_has_space,
                &segments,
            );
            // Apply worktree adjustment (bonus or penalty)
            score += self.worktree_adjustment(candidate);
            if score > best_score {
                best_score = score;
                best_positions = positions;
            }
        }

        (best_score, best_positions)
    }

    /// Recursively find all possible ways to match query_chars in text
    fn find_all_matches(
        text: &str,
        query_chars: &[char],
        start_pos: usize,
        current_match: Vec<usize>,
    ) -> Vec<Vec<usize>> {
        // Base case: matched all characters
        if query_chars.is_empty() {
            return vec![current_match];
        }

        let char_to_find = query_chars[0];
        let remaining_chars = &query_chars[1..];
        let mut all_matches = Vec::new();

        // Find all positions of the next character
        let text_chars: Vec<char> = text.chars().collect();
        for (idx, ch) in text_chars.iter().enumerate().skip(start_pos) {
            if *ch == char_to_find {
                // Try matching from this position
                let mut new_match = current_match.clone();
                new_match.push(idx);
                let sub_matches = Self::find_all_matches(text, remaining_chars, idx + 1, new_match);
                all_matches.extend(sub_matches);
            }
        }

        all_matches
    }

    /// Score a specific match based on character positions
    fn score_match(
        &self,
        text: &str,
        positions: &[usize],
        query_chars: &[char],
        query_has_slash: bool,
        query_has_space: bool,
        segments: &[MatchSegment],
    ) -> f64 {
        // Cache text as chars to avoid repeated conversions
        let text_chars: Vec<char> = text.chars().collect();

        // Score individual character matches
        let (base_score, word_boundary_count) = self.score_character_matches(
            &text_chars,
            positions,
            query_has_slash,
            query_has_space,
            segments,
        );

        // Apply match bonuses
        let score_with_bonuses =
            self.apply_match_bonuses(base_score, positions, query_chars, word_boundary_count);

        // Apply penalties
        let score_with_penalties = self.apply_penalties(score_with_bonuses, positions, segments);

        // Check for special bonuses (exact match, prefix match)
        self.check_special_bonuses(score_with_penalties, positions, &text_chars, segments)
    }

    /// Score individual character matches with word boundary and section bonuses
    fn score_character_matches(
        &self,
        text_chars: &[char],
        positions: &[usize],
        query_has_slash: bool,
        query_has_space: bool,
        segments: &[MatchSegment],
    ) -> (f64, usize) {
        let mut score = 0.0;
        let mut multiplier = 1.0;
        let mut word_boundary_multiplier = 1.0;
        let mut word_boundary_count = 0;
        let mut last_was_boundary = false;

        for (i, &pos) in positions.iter().enumerate() {
            // Base score
            let mut char_score = BASE_CHAR_SCORE;

            // Word boundary detection and bonus
            let is_boundary = is_word_boundary(text_chars, pos);
            if is_boundary {
                char_score = WORD_BOUNDARY_SCORE;
                word_boundary_count += 1;

                // Apply word boundary multiplier for consecutive boundary matches
                if i > 0 && last_was_boundary {
                    word_boundary_multiplier = (word_boundary_multiplier
                        * WORD_BOUNDARY_MULTIPLIER)
                        .min(MAX_WORD_BOUNDARY_MULTIPLIER);
                } else {
                    word_boundary_multiplier = 1.0;
                }
                char_score *= word_boundary_multiplier;
            }
            last_was_boundary = is_boundary;

            let section_type = get_section_type(pos, segments);
            let section_boost = match (section_type, query_has_slash, query_has_space) {
                (ComponentType::Project | ComponentType::Repo, true, _) => PROJECT_REPO_SLASH_BOOST,
                (ComponentType::Worktree | ComponentType::Owner, true, _) => {
                    WORKTREE_OWNER_SLASH_BOOST
                }
                (ComponentType::Worktree | ComponentType::Owner, false, _) => {
                    WORKTREE_OWNER_NO_SLASH_PENALTY
                }
                (ComponentType::Branch, _, true) => BRANCH_SPACE_BOOST,
                (ComponentType::Branch, _, _) => BRANCH_NO_SPACE_PENALTY,
                _ => 1.0,
            };
            char_score *= section_boost;

            // Consecutive character multiplier
            if i > 0 && positions[i - 1] == pos - 1 {
                multiplier = (multiplier * CONSECUTIVE_MULTIPLIER).min(MAX_CONSECUTIVE_MULTIPLIER);
            } else {
                multiplier = 1.0;
            }

            score += char_score * multiplier;
        }

        (score, word_boundary_count)
    }

    /// Apply bonuses for match quality (perfect, all word boundaries, all consecutive)
    fn apply_match_bonuses(
        &self,
        score: f64,
        positions: &[usize],
        query_chars: &[char],
        word_boundary_count: usize,
    ) -> f64 {
        let mut score = score;
        let all_consecutive = positions.windows(2).all(|w| w[1] == w[0] + 1);

        if word_boundary_count == query_chars.len() && all_consecutive {
            score += PERFECT_MATCH_BONUS * query_chars.len() as f64;
        } else if word_boundary_count == query_chars.len() {
            score += ALL_WORD_BOUNDARIES_BONUS * query_chars.len() as f64;
        } else if all_consecutive {
            score += ALL_CONSECUTIVE_BONUS * query_chars.len() as f64;
        }

        score
    }

    /// Apply penalties for match span and distance from main content
    fn apply_penalties(&self, score: f64, positions: &[usize], segments: &[MatchSegment]) -> f64 {
        let mut score = score;

        // Span penalty
        let span = match (positions.first(), positions.last()) {
            (Some(first), Some(last)) => last - first + 1,
            _ => return score, // No valid span
        };
        score -= span as f64 * SPAN_PENALTY;

        // Distance penalty relative to main content start
        let main_content_start = get_main_content_start(segments);
        let first_match_pos = match positions.first() {
            Some(&pos) => pos,
            None => return score,
        };
        if first_match_pos > main_content_start {
            let distance_from_main = first_match_pos - main_content_start;
            score -= distance_from_main as f64 * DISTANCE_FROM_START_PENALTY;
        }

        score
    }

    /// Check for special bonuses (exact component match, prefix match)
    fn check_special_bonuses(
        &self,
        score: f64,
        positions: &[usize],
        text_chars: &[char],
        segments: &[MatchSegment],
    ) -> f64 {
        let mut score = score;

        // Build matched text
        let matched_text: String = positions
            .iter()
            .map(|&pos| text_chars.get(pos).copied().unwrap_or_default())
            .collect::<String>()
            .to_lowercase();

        // Check for exact component match
        let exact_component_match = segments
            .iter()
            .filter(|s| {
                !matches!(
                    s.component_type,
                    ComponentType::Icon | ComponentType::Separator
                )
            })
            .any(|segment| {
                segment.text.to_lowercase() == matched_text
                    && positions
                        .first()
                        .is_some_and(|&p| p >= segment.start && p < segment.end)
                    && positions
                        .last()
                        .is_some_and(|&p| p >= segment.start && p < segment.end)
            });

        if exact_component_match {
            score += EXACT_MATCH_BONUS;
        } else {
            // Check if it's a prefix match within a component
            let all_consecutive = positions.windows(2).all(|w| w[1] == w[0] + 1);
            if all_consecutive {
                for segment in segments {
                    if let Some(&first_pos) = positions.first() {
                        if first_pos == segment.start
                            && positions
                                .iter()
                                .all(|&p| p >= segment.start && p < segment.end)
                        {
                            score += PREFIX_MATCH_BONUS;
                            break;
                        }
                    }
                }
            }
        }

        score
    }
}

/// Check if a position is at a word boundary
fn is_word_boundary(text_chars: &[char], pos: usize) -> bool {
    if pos == 0 {
        return true;
    }

    if pos >= text_chars.len() {
        return false;
    }

    let prev_char = text_chars[pos - 1];
    !prev_char.is_alphanumeric()
}

/// Get the section type for a character position
fn get_section_type(pos: usize, segments: &[MatchSegment]) -> ComponentType {
    for segment in segments {
        if pos >= segment.start && pos < segment.end {
            return segment.component_type;
        }
    }
    ComponentType::Path
}

/// Get the position where the main content starts (after worktree/owner)
fn get_main_content_start(segments: &[MatchSegment]) -> usize {
    let mut main_start = 0;
    for segment in segments {
        match segment.component_type {
            ComponentType::Icon | ComponentType::Worktree | ComponentType::Owner => {
                main_start = segment.end;
            }
            ComponentType::Separator => {
                // Include separator after worktree/owner
                if main_start > 0 {
                    main_start = segment.end;
                }
            }
            _ => break,
        }
    }
    main_start
}

impl Default for OptimalScorer {
    fn default() -> Self {
        Self::new(String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::scorer_test_utils::*;
    use test_case::test_case;

    #[test]
    fn test_basic_scoring() {
        let scorer = OptimalScorer::new(String::new());

        // Test word boundary matching
        let cand1 = candidate("data-sync");
        let cand2 = candidate("datasync");
        assert!(
            scorer.score_candidate(&cand1, "ds") > scorer.score_candidate(&cand2, "ds"),
            "Word boundary match should score higher"
        );

        // Test consecutive matching
        let cand1 = candidate("portal");
        let cand2 = candidate("p-o-r-tal");
        assert!(
            scorer.score_candidate(&cand1, "por") > scorer.score_candidate(&cand2, "por"),
            "Consecutive match should score higher"
        );

        // Test substring matching - not exact match comparison
        // Since the match_string includes path formatting, we can't test exact match easily
        let cand = candidate("testing");
        assert!(
            scorer.score_candidate(&cand, "test") > 0.0,
            "Should find 'test' in 'testing'"
        );

        // Test no match
        let cand = candidate("hello");
        assert_eq!(
            scorer.score_candidate(&cand, "xyz"),
            0.0,
            "No match should return 0"
        );
    }

    #[test]
    fn test_section_awareness() {
        let scorer = OptimalScorer::new(String::new());

        // Test with separator in query
        let cand1 = candidate("root//[a]nalytics");
        let score_with_sep = scorer.score_candidate(&cand1, "r/s");

        // The section-aware match should score higher
        assert!(score_with_sep > 0.0);
    }

    #[test]
    fn test_branch_matching() {
        let scorer = OptimalScorer::new(String::new());

        // Test branch in square brackets
        let cand1 = candidate("root//[web]-frontend [feat]ure");
        let score = scorer.score_candidate(&cand1, "web feat");
        assert!(
            score > 0.0,
            "Branch should match. candidate: {}, score: {}",
            cand1.path,
            score
        );

        // Should match both in project and branch
        let cand2 = candidate("root//project feature");
        let cand3 = candidate("feature-service");
        let score_branch = scorer.score_candidate(&cand2, "feature");
        let score_name = scorer.score_candidate(&cand3, "feature");
        assert!(score_branch > 0.0);
        assert!(score_name > 0.0);
    }

    #[test]
    fn test_distance_penalty_from_main_content() {
        let scorer = OptimalScorer::new(String::new());

        // Test that matches after worktree have no distance penalty
        let cand1 = candidate("some-worktree//[a]wesome");
        let cand2 = candidate("worktree//[a]wesome");

        // Both should match "awe" in "awesome" with same score (no distance penalty)
        let score1 = scorer.score_candidate(&cand1, "awe");
        let score2 = scorer.score_candidate(&cand2, "awe");
        assert_eq!(
            score1, score2,
            "Distance penalty should be relative to main content start"
        );

        // But matching in the worktree name should have penalty
        let cand3 = candidate("awesome-worktree//[project]");
        let score3 = scorer.score_candidate(&cand3, "awe");
        assert!(
            score3 < score1,
            "Match in worktree name should have lower score than in main content"
        );
    }

    #[test_case("awe", "long-worktree-name-with-[awe]-here//project", "worktree//[awe]some" ; "project match has no distance penalty vs worktree match")]
    #[test_case("ds", "root//[d]ata[s]ync", "root//[d]ata-[s]ync" ; "word boundaries beat infix matches")]
    #[test_case("por", "root//[p]-[o]-[r]tal", "root//[por]tal" ; "consecutive chars beat separated matches")]
    #[test_case("dasb", "root//[da]ta[s]ervice[b]ackend", "root//[da]ta-[s]ervice-[b]ackend" ; "multiple word boundaries with multiplier effect 1")]
    #[test_case("prda", "root//[p]roduct-[r]eview-[d]ata-[a]pi", "root//[p]ost-[r]elease-[d]oc-[a]pp" ; "multiple word boundaries with multiplier effect 2")]
    #[test_case("web", "root//my-[web]-app", "root//[web]-frontend" ; "perfect prefix beats other matches")]
    #[test_case("api", "root//[api]-service", "root//[api]" ; "exact match gets huge bonus")]
    #[test_case("w", "[w]eb-logging//aproject", "aproject//[w]eb-logging" ; "match at start of match text beats worktree penalty")]
    #[test_case("cw", "root//[c]i [w]eb", "root//[c]ommon-[w]eb" ; "word boundaries in branch vs project")]
    #[test_case("abc", "root//[a]lpha-[b]eta-[c]ode", "root//[a]pp-[b]ase-[c]ore" ; "shorter word boundaries beat longer ones")]
    #[test_case("test", "[t]h[e]-wor[s]h[t]//project", "worktree//[test]-project" ; "distance penalty only applies after main content")]
    fn test_scoring_priorities(query: &str, lower_pattern: &str, higher_pattern: &str) {
        let scorer = OptimalScorer::new(String::new());

        let lower_cand = candidate(lower_pattern);
        let higher_cand = candidate(higher_pattern);

        let (lower_score, lower_positions) =
            scorer.score_candidate_with_positions(&lower_cand, query);
        let (higher_score, higher_positions) =
            scorer.score_candidate_with_positions(&higher_cand, query);

        // Verify positions by reconstructing the bracketed pattern
        let lower_match_text = lower_cand.get_match_text();
        let higher_match_text = higher_cand.get_match_text();

        let lower_bracketed = add_brackets_to_match_text(&lower_match_text, &lower_positions);
        let higher_bracketed = add_brackets_to_match_text(&higher_match_text, &higher_positions);

        assert!(
            lower_score < higher_score,
            "Query '{query}': Expected '{lower_pattern}' ('{lower_bracketed}') to score lower than '{higher_pattern}' ('{higher_bracketed}')\nScores: {lower_score} < {higher_score}"
        );

        assert_eq!(
            lower_bracketed, lower_pattern,
            "Query '{query}': Lower pattern mismatch\nExpected: '{lower_pattern}'\nActual:   '{lower_bracketed}'"
        );

        assert_eq!(
            higher_bracketed, higher_pattern,
            "Query '{query}': Higher pattern mismatch\nExpected: '{higher_pattern}'\nActual:   '{higher_bracketed}'"
        );
    }

    #[test]
    fn test_worktree_adjustment() {
        let scorer = OptimalScorer::new("/world/trees/root/src/areas/category/project".to_string());
        let wt = candidate("root//project");
        let other_wt = candidate("otherwt//project");
        let non_wt = candidate("github.com/owner/repo");
        assert_eq!(scorer.worktree_adjustment(&wt), WORKTREE_PROXIMITY_BONUS);
        assert_eq!(scorer.worktree_adjustment(&other_wt), 0.0);
        assert_eq!(scorer.worktree_adjustment(&non_wt), NON_WORKTREE_PENALTY);
    }
}
