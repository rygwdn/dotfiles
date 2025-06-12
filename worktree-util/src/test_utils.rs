#[cfg(test)]
pub mod scorer_test_utils {
    use crate::candidate::Candidate;
    use crate::path_shortener::shorten_path;
    use std::path::Path;

    pub fn create_candidate_from_text(text: &str) -> Candidate {
        // Create a simple candidate where the text appears in the match string
        let path = format!("/home/user/{}", text);
        Candidate {
            score: 0.0,
            zoxide_score: 0.0,
            base_score: 0.0,
            query_score: 0.0,
            total_score: 0.0,
            path: path.clone(),
            shortpath: shorten_path(&Path::new(&path)),
            branch: None,
        }
    }

    pub fn create_candidate_with_branch(project: &str, branch: &str) -> Candidate {
        let path = format!("/world/trees/root/src/areas/category/{}", project);
        Candidate {
            score: 0.0,
            zoxide_score: 0.0,
            base_score: 0.0,
            query_score: 0.0,
            total_score: 0.0,
            path: path.clone(),
            shortpath: shorten_path(&Path::new(&path)),
            branch: Some(branch.to_string()),
        }
    }

    pub fn create_worktree_candidate(worktree: &str, project: &str) -> Candidate {
        let path = format!("/world/trees/{}/src/areas/category/{}", worktree, project);
        Candidate {
            score: 0.0,
            zoxide_score: 0.0,
            base_score: 0.0,
            query_score: 0.0,
            total_score: 0.0,
            path: path.clone(),
            shortpath: shorten_path(&Path::new(&path)),
            branch: None,
        }
    }

    pub fn create_candidate_from_pattern(pattern: &str) -> Candidate {
        // Extract the actual text from the pattern (removing brackets)
        let text = pattern.replace("[", "").replace("]", "");

        if text.contains("//") && text.contains("🌍") {
            let parts: Vec<&str> = text.trim_start_matches("🌍 ").splitn(2, "//").collect();
            if parts.len() == 2 {
                let project_branch: Vec<&str> = parts[1].splitn(2, " ").collect();
                if project_branch.len() == 2 {
                    create_candidate_with_branch(project_branch[0], project_branch[1])
                } else {
                    create_worktree_candidate(parts[0], parts[1])
                }
            } else {
                create_candidate_from_text(&text)
            }
        } else {
            create_candidate_from_text(&text)
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

    pub fn normalize_pattern_for_comparison(pattern: &str) -> String {
        // Remove the emoji icon and following space from the pattern
        pattern.replace("🌍 ", "")
    }
}
