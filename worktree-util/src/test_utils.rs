#[cfg(test)]
pub mod scorer_test_utils {
    use crate::candidate::Candidate;
    use crate::path_shortener::shorten_path;
    use std::path::Path;

    pub fn candidate(pattern: &str) -> Candidate {
        let text = pattern.replace("[", "").replace("]", "").replace("🌍 ", "");

        if !text.contains("//") {
            let home_path = format!("/home/user/{}", text);
            return Candidate {
                path: home_path.clone(),
                shortpath: shorten_path(&Path::new(&home_path)),
                branch: None,
            };
        }

        let (worktree, rest): (&str, &str) = text.split_once("//").unwrap();
        let (project, branch): (&str, &str) = rest.split_once(" ").unwrap_or((rest, ""));
        let path = format!("/world/trees/{}/src/areas/category/{}", worktree, project);

        return Candidate {
            path: path.clone(),
            shortpath: shorten_path(&Path::new(&path)),
            branch: if branch.is_empty() {
                None
            } else {
                Some(branch.to_string())
            },
        };
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
