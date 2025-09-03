use crate::path_shortener::{ComponentType, ShortPath, ShortPathPart};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq)]
pub struct MatchSegment {
    pub part: ShortPathPart,
    pub component_type: ComponentType,
    pub text: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub path: String,
    pub shortpath: ShortPath,
    pub branch: Option<String>,
}

impl Candidate {
    pub fn display(&self) -> String {
        self.shortpath.display(self.branch.clone())
    }

    pub fn get_match_text(&self) -> String {
        self.shortpath
            .components(1, self.branch.clone())
            .into_iter()
            .filter_map(|(_, component_type, text)| {
                // Exclude icon components from match text as we never want to match on them
                if component_type == ComponentType::Icon {
                    None
                } else {
                    Some(text)
                }
            })
            .collect()
    }

    /// Get the segments that make up the match string
    pub fn get_segments(&self) -> Vec<MatchSegment> {
        let mut cursor = 0;
        let mut segments = Vec::new();

        for (part, component_type, text) in self.shortpath.components(1, self.branch.clone()) {
            // Skip icon components to match get_match_text behavior
            if component_type == ComponentType::Icon {
                continue;
            }

            let char_count = text.chars().count();
            segments.push(MatchSegment {
                part,
                component_type,
                text: text.clone(),
                start: cursor,
                end: cursor + char_count,
            });
            cursor += char_count;
        }
        segments
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path_shortener::shorten_path;
    use std::path::Path;

    fn create_test_candidate(
        worktree: Option<&str>,
        project: Option<&str>,
        owner: Option<&str>,
        repo: Option<&str>,
        branch: Option<&str>,
    ) -> Candidate {
        let path = if let (Some(wt), Some(proj)) = (worktree, project) {
            format!("/world/trees/{wt}/src/areas/category/{proj}")
        } else if let (Some(own), Some(rp)) = (owner, repo) {
            format!("/home/user/src/github.com/{own}/{rp}")
        } else {
            "/path/to/project".to_string()
        };

        Candidate {
            path: path.clone(),
            shortpath: shorten_path(Path::new(&path)),
            branch: branch.map(String::from),
        }
    }

    #[test]
    fn test_display_without_branch() {
        let candidate = create_test_candidate(Some("root"), Some("analytics"), None, None, None);
        let display = candidate.display();

        // Should contain colorized shortpath but no branch
        // The shortpath might contain [ in color codes, so be more specific
        assert!(
            !display.contains(" ["),
            "Should not contain branch brackets with space before"
        );
        assert!(display.contains("\x1b["), "Should contain ANSI color codes");
    }

    #[test]
    fn test_display_with_branch() {
        let candidate = create_test_candidate(
            Some("root"),
            Some("analytics"),
            None,
            None,
            Some("feature-branch"),
        );
        let display = candidate.display();

        // Should contain both colorized shortpath and branch
        assert!(
            display.contains("[feature-branch]"),
            "Should contain branch in brackets"
        );
        assert!(display.contains("\x1b[2m["), "Branch should be dimmed");
    }

    #[test]
    fn test_match_string_without_branch() {
        let candidate = create_test_candidate(Some("root"), Some("analytics"), None, None, None);
        let match_str = candidate.get_match_text();

        // Should be the shortpath without the icon
        assert_eq!(match_str, "root//analytics");
        assert!(
            !match_str.contains("["),
            "Should not contain branch brackets"
        );
    }

    #[test]
    fn test_match_string_with_branch() {
        let candidate = create_test_candidate(
            Some("root"),
            Some("analytics"),
            None,
            None,
            Some("feature-branch"),
        );
        let match_str = candidate.get_match_text();

        // Should include branch in simplified format (no brackets)
        assert!(
            match_str.contains("feature-branch"),
            "get_match_text should contain branch name"
        );
        assert!(
            !match_str.contains("[feature-branch]"),
            "get_match_text should not contain brackets around branch"
        );
    }

    #[test]
    fn test_segments_with_multibyte_chars() {
        // Test that segment positions are character-based, not byte-based
        let candidate = create_test_candidate(Some("root"), Some("api"), None, None, None);
        let segments = candidate.get_segments();

        // Now that icons are excluded, segments should be: "root" (4 chars), "//" (2 chars), "api" (3 chars)
        assert_eq!(segments[0].text, "root");
        assert_eq!(segments[0].start, 0);
        assert_eq!(segments[0].end, 4);

        assert_eq!(segments[1].text, "//");
        assert_eq!(segments[1].start, 4);
        assert_eq!(segments[1].end, 6);

        assert_eq!(segments[2].text, "api");
        assert_eq!(segments[2].start, 6);
        assert_eq!(segments[2].end, 9);
    }

    #[test]
    fn test_match_string_segments() {
        // Test world tree pattern
        let candidate = create_test_candidate(Some("root"), Some("analytics"), None, None, None);
        let segments = candidate.get_segments();

        // The segments should represent the full match string
        assert!(!segments.is_empty(), "Should have some segments");

        // Reconstruct the full string from segments
        let full_string: String = segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(full_string, candidate.get_match_text());

        // Test with branch
        let candidate =
            create_test_candidate(Some("root"), Some("shopify"), None, None, Some("feature"));
        let segments = candidate.get_segments();

        // Should have a branch segment
        assert!(segments
            .iter()
            .any(|s| s.component_type == ComponentType::Branch));

        // The full string should include the branch
        let full_string: String = segments.iter().map(|s| s.text.as_str()).collect();
        assert!(full_string.contains("feature"));
        assert!(
            !full_string.contains("[feature]"),
            "Should not have brackets"
        );

        // Test segment positions
        let mut expected_end = 0;
        for segment in &segments {
            assert_eq!(
                segment.start, expected_end,
                "Segment should start where previous ended"
            );
            expected_end = segment.end;
            assert_eq!(
                segment.end - segment.start,
                segment.text.chars().count(),
                "Segment length should match text character count"
            );
        }
    }
}
