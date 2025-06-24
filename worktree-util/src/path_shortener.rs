use git2::Repository;
use regex::Regex;
use serde::Serialize;
use std::path::Path;
use std::sync::OnceLock;

// Symbol constants
pub const SYMBOL_WORLD: &str = "\u{f484} "; // nf-oct-globe
pub const SYMBOL_GIT: &str = "\u{e0a0} "; // nf-pl-branch
pub const SYMBOL_GITHUB: &str = "\u{ea84} "; // nf-cod-github
pub const SYMBOL_GITHUB_INVERTED: &str = "\u{f09b} "; // nf-fab-github (filled version)
pub const SYMBOL_HOME: &str = "~";
pub const SYMBOL_ROOT: &str = "/";

// Lazy static regex for world trees pattern
static WORLD_TREES_RE: OnceLock<Regex> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum PathType {
    WorldTree { worktree: String, project: String },
    GitHub { owner: String, repo: String },
    GitHubRemote { owner: String, repo: String },
    Git { repo_name: String },
    Home,
    Regular,
}

/// Builder for path components that tracks the current part type
struct ComponentBuilder {
    components: Vec<(ShortPathPart, ComponentType, String)>,
    current_part: ShortPathPart,
}

impl ComponentBuilder {
    fn new() -> Self {
        Self {
            components: Vec::new(),
            current_part: Prefix,
        }
    }

    fn add(&mut self, component_type: ComponentType, text: String) {
        self.components
            .push((self.current_part, component_type, text));
    }

    fn set_part(&mut self, part: ShortPathPart) {
        self.current_part = part;
    }

    fn finish(self) -> Vec<(ShortPathPart, ComponentType, String)> {
        self.components
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShortPath {
    pub path_type: PathType,
    pub segments: Vec<String>, // All path segments after the prefix (unshortened)
}

use ComponentType::*;
use ShortPathPart::*;

impl ShortPath {
    pub fn build(&self, max_segments: usize, target_types: &[ShortPathPart]) -> String {
        self.components(max_segments, None)
            .into_iter()
            .filter_map(|(segment_type, _, text)| {
                if target_types.contains(&segment_type) {
                    Some(text)
                } else {
                    None
                }
            })
            .collect()
    }

    pub fn components(
        &self,
        max_segments: usize,
        branch: Option<String>,
    ) -> Vec<(ShortPathPart, ComponentType, String)> {
        let mut builder = ComponentBuilder::new();

        // Add prefix components
        match &self.path_type {
            PathType::WorldTree { worktree, project } => {
                builder.add(Icon, SYMBOL_WORLD.to_string());
                builder.add(Worktree, worktree.clone());
                builder.add(Separator, "//".to_string());
                builder.add(Project, project.clone());
            }
            PathType::GitHub { owner, repo } => {
                builder.add(Icon, SYMBOL_GITHUB.to_string());
                builder.add(Owner, owner.clone());
                builder.add(Separator, "/".to_string());
                builder.add(Repo, repo.clone());
            }
            PathType::GitHubRemote { owner, repo } => {
                builder.add(Icon, SYMBOL_GITHUB_INVERTED.to_string());
                builder.add(Owner, owner.clone());
                builder.add(Separator, "/".to_string());
                builder.add(Repo, repo.clone());
            }
            PathType::Git { repo_name } => {
                builder.add(Icon, SYMBOL_GIT.to_string());
                builder.add(Repo, repo_name.clone());
            }
            PathType::Home => {
                builder.add(Icon, SYMBOL_HOME.to_string());
            }
            PathType::Regular => {
                builder.add(Icon, SYMBOL_ROOT.to_string());
            }
        }

        let shorten_count = self.segments.len().saturating_sub(max_segments);

        builder.set_part(Infix);
        for (i, segment) in self.segments.iter().enumerate() {
            if i >= shorten_count {
                builder.set_part(Suffix);
            }

            // Add separator before segments (for Regular paths, the root "/" is the icon)
            // For other types, we need a separator before the first segment
            let needs_separator = i > 0 || (i == 0 && !matches!(self.path_type, PathType::Regular));
            if needs_separator {
                builder.add(Separator, "/".to_string());
            }
            if i < shorten_count {
                builder.add(
                    Shortened,
                    segment.chars().next().unwrap_or_default().to_string(),
                );
            } else {
                builder.add(Path, segment.clone());
            }
        }

        if let Some(branch) = branch {
            builder.set_part(BranchPart);
            builder.add(Separator, " ".to_string());
            builder.add(Branch, branch.clone());
        }

        builder.finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ComponentType {
    Icon,
    Worktree,
    Project,
    Owner,
    Repo,
    Separator,
    Shortened,
    Path,
    Branch,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ShortPathPart {
    Prefix,
    Infix,
    Suffix,
    BranchPart,
}

pub fn shorten_path(path: &Path) -> ShortPath {
    let path_str = path.to_string_lossy().into_owned();

    // Check for world trees paths (highest priority)
    if let Some(world_path) = check_world_tree_path(&path_str) {
        return world_path;
    }

    // Check for git repository (second priority)
    if let Some(git_path) = check_git_path(path) {
        return git_path;
    }

    // Check for home directory (third priority)
    if let Some(home_path) = check_home_path(&path_str) {
        return home_path;
    }

    // Regular path (lowest priority)
    create_regular_path(&path_str)
}

fn check_world_tree_path(path_str: &str) -> Option<ShortPath> {
    // Use lazy static regex to avoid recompiling
    let re = WORLD_TREES_RE.get_or_init(|| {
        #[allow(clippy::expect_used)] // Static regex should always compile
        Regex::new(r"/world/trees/([^/]+)(?:/src/areas/[^/]+/([^/]+))?(?:/(.*))?")
            .expect("Invalid world trees regex")
    });

    if let Some(caps) = re.captures(path_str) {
        let project = caps.get(1)?.as_str();
        let component = caps.get(2).map_or("", |m| m.as_str());
        let remaining = caps.get(3).map_or("", |m| m.as_str());

        // Split remaining into segments
        let segments: Vec<String> = if remaining.is_empty() {
            Vec::new()
        } else {
            remaining
                .split('/')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        };

        return Some(ShortPath {
            path_type: PathType::WorldTree {
                worktree: project.to_string(),
                project: component.to_string(),
            },
            segments,
        });
    }

    None
}

fn extract_github_info(input: &str) -> Option<(String, String)> {
    #[allow(clippy::expect_used)] // Static regex should always compile
    let re = Regex::new(r"github\.com[/:@]([^/]+)/([^/\.]+)(?:\.git)?")
        .expect("Invalid GitHub regex");
    
    if let Some(caps) = re.captures(input) {
        let owner = caps.get(1)?.as_str();
        let repo = caps.get(2)?.as_str();
        Some((owner.to_string(), repo.to_string()))
    } else {
        None
    }
}

fn check_git_path(path: &Path) -> Option<ShortPath> {
    // Try to open a git repository at the given path or any parent
    let repo = Repository::discover(path).ok()?;
    let repo_path = repo.workdir().unwrap_or_else(|| repo.path());
    let repo_path_str = repo_path.to_string_lossy();

    // Get relative path within the repository
    let rel_path = path.strip_prefix(repo_path).ok()?;
    let rel_path_str = rel_path.to_string_lossy();

    // Split into segments for the remaining path
    let segments: Vec<String> = if rel_path_str.is_empty() || rel_path_str == "." {
        Vec::new()
    } else {
        rel_path_str
            .split('/')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect()
    };

    // Check if this is a GitHub repository path (highest priority for GitHub type)
    if let Some((owner, repo)) = extract_github_info(&repo_path_str) {
        return Some(ShortPath {
            path_type: PathType::GitHub { owner, repo },
            segments,
        });
    }

    // Check if the remote origin is a GitHub repository (second priority)
    if let Ok(remote) = repo.find_remote("origin") {
        if let Some(url) = remote.url() {
            if let Some((owner, repo_name)) = extract_github_info(url) {
                return Some(ShortPath {
                    path_type: PathType::GitHubRemote { owner, repo: repo_name },
                    segments,
                });
            }
        }
    }

    // Regular git repository (fallback)
    let repo_name = repo_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();

    Some(ShortPath {
        path_type: PathType::Git { repo_name },
        segments,
    })
}

fn check_home_path(path_str: &str) -> Option<ShortPath> {
    let home_dir = dirs::home_dir()?;
    let home_str = home_dir.to_string_lossy();

    if path_str.starts_with(&*home_str) {
        let rel_path = path_str.strip_prefix(&*home_str)?;
        let rel_path = rel_path.strip_prefix('/').unwrap_or(rel_path);

        let segments: Vec<String> = if rel_path.is_empty() {
            Vec::new()
        } else {
            rel_path
                .split('/')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        };

        return Some(ShortPath {
            path_type: PathType::Home,
            segments,
        });
    }

    None
}

fn create_regular_path(path_str: &str) -> ShortPath {
    let segments: Vec<String> = path_str
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    ShortPath {
        path_type: PathType::Regular,
        segments,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_regular_path() {
        let path = "/usr/local/share/man/man1/bash.1";
        let result = create_regular_path(path);
        assert_eq!(result.build(1, &[Prefix]), "/");
        assert_eq!(result.build(1, &[Infix]), "u/l/s/m/m");
        assert_eq!(result.build(1, &[Suffix]), "/bash.1");
        assert_eq!(
            result.build(1, &[Prefix, Infix, Suffix]),
            "/u/l/s/m/m/bash.1"
        );

        // Test with more preserved segments
        let result = create_regular_path(path);
        assert_eq!(result.build(2, &[Prefix]), "/");
        assert_eq!(result.build(2, &[Infix]), "u/l/s/m");
        assert_eq!(result.build(2, &[Suffix]), "/man1/bash.1");
        assert_eq!(
            result.build(2, &[Prefix, Infix, Suffix]),
            "/u/l/s/m/man1/bash.1"
        );
    }

    #[test]
    fn test_home_path() {
        // This test is a bit tricky since it depends on the home directory
        // We can only check the structure of the output
        if let Some(home_dir) = dirs::home_dir() {
            let test_path = home_dir.join("Documents/projects/notes/todo.txt");
            if let Some(result) = check_home_path(&test_path.to_string_lossy()) {
                assert_eq!(result.build(1, &[Prefix]), "~");
                // The shortened and normal parts will depend on the actual path
                assert!(
                    result.build(1, &[Infix]).len() > 0 || result.build(1, &[Suffix]).len() > 0
                );
            }
        }
    }

    #[test]
    fn test_world_tree_path() {
        let path = "/Users/username/world/trees/project-name/src/areas/clients/some-web/components";
        let result = check_world_tree_path(path);
        assert!(result.is_some());

        let result = result.unwrap();
        assert_eq!(
            result.build(1, &[Prefix]),
            format!("{}project-name//some-web", SYMBOL_WORLD)
        );
        assert_eq!(result.build(1, &[Infix]), "");
        assert_eq!(result.build(1, &[Suffix]), "/components");
        assert_eq!(
            result.build(1, &[Prefix, Infix, Suffix]),
            format!("{}project-name//some-web/components", SYMBOL_WORLD)
        );
    }

    #[test]
    fn test_create_regular_path_root() {
        let result = create_regular_path("/");
        assert_eq!(result.build(1, &[Prefix]), "/");
        assert_eq!(result.build(1, &[Infix]), "");
        assert_eq!(result.build(1, &[Suffix]), "");
        assert_eq!(result.build(1, &[Prefix, Infix, Suffix]), "/");
    }

    #[test]
    fn test_create_regular_path_with_max_segments() {
        let path = "/a/b/c/d/e";

        // Test with max_segments = 1 (default)
        let result = create_regular_path(path);
        assert_eq!(result.build(1, &[Prefix]), "/");
        assert_eq!(result.build(1, &[Infix]), "a/b/c/d");
        assert_eq!(result.build(1, &[Suffix]), "/e");
        assert_eq!(result.build(1, &[Prefix, Infix, Suffix]), "/a/b/c/d/e");

        // Test with max_segments = 2
        let result = create_regular_path(path);
        assert_eq!(result.build(2, &[Prefix]), "/");
        assert_eq!(result.build(2, &[Infix]), "a/b/c");
        assert_eq!(result.build(2, &[Suffix]), "/d/e");
        assert_eq!(result.build(2, &[Prefix, Infix, Suffix]), "/a/b/c/d/e");

        // Test with max_segments > number of segments
        let result = create_regular_path(path);
        assert_eq!(result.build(10, &[Prefix]), "/");
        assert_eq!(result.build(10, &[Infix]), "");
        assert_eq!(result.build(10, &[Suffix]), "a/b/c/d/e");
        assert_eq!(result.build(10, &[Prefix, Infix, Suffix]), "/a/b/c/d/e");
    }

    #[test]
    fn test_extract_github_info() {
        // Test file path extraction
        assert_eq!(
            extract_github_info("/home/user/github.com/owner/repo"),
            Some(("owner".to_string(), "repo".to_string()))
        );

        assert_eq!(
            extract_github_info("/Users/user/work/github.com/myorg/myproject"),
            Some(("myorg".to_string(), "myproject".to_string()))
        );

        assert_eq!(
            extract_github_info("/some/deeply/nested/path/github.com/foo/bar"),
            Some(("foo".to_string(), "bar".to_string()))
        );

        // Test with trailing slash
        assert_eq!(
            extract_github_info("/path/github.com/owner/repo/"),
            Some(("owner".to_string(), "repo".to_string()))
        );

        // Test SSH format
        assert_eq!(
            extract_github_info("git@github.com:owner/repo.git"),
            Some(("owner".to_string(), "repo".to_string()))
        );

        // Test SSH format without .git suffix
        assert_eq!(
            extract_github_info("git@github.com:owner/repo"),
            Some(("owner".to_string(), "repo".to_string()))
        );

        // Test HTTPS format
        assert_eq!(
            extract_github_info("https://github.com/owner/repo.git"),
            Some(("owner".to_string(), "repo".to_string()))
        );

        // Test HTTPS format without .git suffix
        assert_eq!(
            extract_github_info("https://github.com/owner/repo"),
            Some(("owner".to_string(), "repo".to_string()))
        );

        // Test with longer paths - extracts the first owner/repo after github.com
        assert_eq!(
            extract_github_info("/some/path/to/github.com/too/many/parts/"),
            Some(("too".to_string(), "many".to_string()))
        );

        assert_eq!(
            extract_github_info("/path/github.com/owner/repo/subdir"),
            Some(("owner".to_string(), "repo".to_string()))
        );

        // Test failures - too few parts
        assert_eq!(extract_github_info("/path/github.com/onlyowner"), None);

        assert_eq!(extract_github_info("/path/github.com/"), None);

        // Test failures - not GitHub URLs
        assert_eq!(extract_github_info("/path/gitlab.com/owner/repo"), None);

        assert_eq!(
            extract_github_info("git@gitlab.com:owner/repo.git"),
            None
        );

        assert_eq!(
            extract_github_info("https://bitbucket.org/owner/repo.git"),
            None
        );

        // Test failures - invalid formats
        assert_eq!(extract_github_info("git@github.com:owner"), None);

        assert_eq!(extract_github_info("https://github.com/owner"), None);
    }
}
