use clap::{Arg, ArgAction, Command};
use git2::Repository;
use regex::Regex;
use std::env;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

// Symbol constants
const SYMBOL_WORLD: &str = "\u{f484}"; // nf-oct-globe
const SYMBOL_GIT: &str = "\u{e0a0}"; // nf-pl-branch
const SYMBOL_GITHUB: &str = "\u{ea84}"; // nf-cod-github
const SYMBOL_HOME: &str = "~";
const SYMBOL_ROOT: &str = "/";

// Lazy static regex for world trees pattern
static WORLD_TREES_RE: OnceLock<Regex> = OnceLock::new();

#[derive(Debug, Clone, PartialEq)]
struct ShortPath {
    prefix: String,
    shortened: String,
    normal: String,
}

impl ShortPath {
    fn full(&self) -> String {
        format!("{}{}{}", self.prefix, self.shortened, self.normal)
    }
}

#[allow(clippy::expect_used)]
fn main() {
    let matches = Command::new("shortpath")
        .version(env!("CARGO_PKG_VERSION"))
        .about("Shortens paths for shell prompts")
        .arg(
            Arg::new("max_segments")
                .short('n')
                .long("max-segments")
                .value_name("MAX_SEGMENTS")
                .help("Number of segments to keep unshortened (default: 1)")
                .default_value("1"),
        )
        .arg(
            Arg::new("section")
                .short('s')
                .long("section")
                .value_name("SECTION")
                .help("Section(s) to output (prefix, shortened, normal, full). Can be comma-separated for multiple sections.")
                .default_value("full"),
        )
        .arg(
            Arg::new("stdin")
                .long("stdin")
                .help("Read paths from stdin (one per line) and output shortened paths")
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("path")
                .value_name("PATH")
                .help("Path to shorten (default: current directory)")
                .default_value(".")
                .action(ArgAction::Set)
                .required(false),
        )
        .get_matches();

    let max_segments = matches
        .get_one::<String>("max_segments")
        .expect("max_segments has a default value")
        .parse::<usize>()
        .unwrap_or(1);
    let section = matches
        .get_one::<String>("section")
        .expect("section has a default value");
    let use_stdin = matches.get_flag("stdin");

    // Parse comma-separated sections
    let sections: Vec<&str> = section.split(',').map(|s| s.trim()).collect();

    // Validate sections
    let valid_sections = ["prefix", "shortened", "normal", "full"];
    for s in &sections {
        if !valid_sections.contains(s) {
            eprintln!("Error: Invalid section '{}'. Valid sections are: prefix, shortened, normal, full", s);
            std::process::exit(1);
        }
    }

    // Validate that multiple sections are only used without stdin
    if use_stdin && sections.len() > 1 {
        eprintln!("Error: Multiple sections are not supported with --stdin");
        std::process::exit(1);
    }

    if use_stdin {
        // Batch mode: read paths from stdin
        let stdin = io::stdin();
        let reader = BufReader::new(stdin);

        for path in reader.lines().map_while(Result::ok) {
            let path_to_shorten = expand_path(&path);
            let short_path = shorten_path(&path_to_shorten, max_segments);

            // stdin mode only supports single section
            match sections[0] {
                "prefix" => println!("{}", short_path.prefix),
                "shortened" => println!("{}", short_path.shortened),
                "normal" => println!("{}", short_path.normal),
                _ => println!("{}", short_path.full()),
            }
        }
    } else {
        // Single path mode
        let path = matches.get_one::<String>("path").expect("path is required");
        let path_to_shorten = expand_path(path);
        let short_path = shorten_path(&path_to_shorten, max_segments);

        for (i, section) in sections.iter().enumerate() {
            match section {
                &"prefix" => print!("{}", short_path.prefix),
                &"shortened" => print!("{}", short_path.shortened),
                &"normal" => print!("{}", short_path.normal),
                _ => print!("{}", short_path.full()),
            }

            // Add newline between sections (but not after the last one)
            if i < sections.len() - 1 {
                println!();
            }
        }

        // Print trailing newline only if multiple sections were requested
        if sections.len() > 1 {
            println!();
        }
    }
}

fn expand_path(path: &str) -> PathBuf {
    let path_buf = if path == "." {
        env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(path)
    };

    if let Ok(canonical) = path_buf.canonicalize() {
        canonical
    } else {
        path_buf
    }
}

fn shorten_path(path: &Path, max_segments: usize) -> ShortPath {
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
    create_regular_path(&path_str, max_segments)
}

fn check_world_tree_path(path_str: &str) -> Option<ShortPath> {
    // Use lazy static regex to avoid recompiling
    let re = WORLD_TREES_RE.get_or_init(|| {
        Regex::new(r"/world/trees/([^/]+)(?:/src/areas/[^/]+/([^/]+))?(?:/(.*))?")
            .expect("Invalid world trees regex")
    });

    if let Some(caps) = re.captures(path_str) {
        let project = caps.get(1)?.as_str();
        let component = caps.get(2).map_or("", |m| m.as_str());
        let remaining = caps.get(3).map_or("", |m| m.as_str());

        let prefix = if component.is_empty() {
            format!("{} {}/", SYMBOL_WORLD, project)
        } else {
            format!(
                "{} {}//{}{}",
                SYMBOL_WORLD,
                project,
                component,
                if !remaining.is_empty() { "/" } else { "" }
            )
        };

        let shortened = String::new(); // No shortened part for world trees
        let normal = remaining.to_string();

        return Some(ShortPath {
            prefix,
            shortened,
            normal,
        });
    }

    None
}

fn extract_github_info(repo_path_str: &str) -> Option<(String, String)> {
    // Check if this is a GitHub repository path
    let github_idx = repo_path_str.find("github.com")?;

    // Extract owner and repo from path like /some/path/github.com/{owner}/{repo}
    let after_github = &repo_path_str[github_idx + "github.com".len()..];
    let parts: Vec<&str> = after_github
        .trim_start_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    // Only return if we have exactly owner and repo (2 parts)
    // More parts means it's a subdirectory, not the repo root
    if parts.len() == 2 {
        Some((parts[0].to_string(), parts[1].to_string()))
    } else {
        None
    }
}

fn check_git_path(path: &Path) -> Option<ShortPath> {
    // Try to open a git repository at the given path or any parent
    let repo = Repository::discover(path).ok()?;
    let repo_path = repo.workdir().unwrap_or_else(|| repo.path());
    let repo_path_str = repo_path.to_string_lossy();

    // Check if this is a GitHub repository path
    let (symbol, repo_display) = if let Some((owner, repo)) = extract_github_info(&repo_path_str) {
        (SYMBOL_GITHUB, format!("{}/{}", owner, repo))
    } else {
        // Regular git repository
        let repo_name = repo_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        (SYMBOL_GIT, repo_name)
    };

    // Get relative path within the repository
    let rel_path = path.strip_prefix(repo_path).ok()?;
    let rel_path_str = rel_path.to_string_lossy();

    // If we're at the repo root, return just the repo name
    if rel_path_str.is_empty() || rel_path_str == "." {
        return Some(ShortPath {
            prefix: format!("{} {}", symbol, repo_display),
            shortened: "".to_string(),
            normal: "".to_string(),
        });
    }

    // Split into components
    let components: Vec<&str> = rel_path_str.split('/').filter(|s| !s.is_empty()).collect();
    let shortened_components: Vec<String> = components
        .iter()
        .take(components.len().saturating_sub(1))
        .map(|comp| comp.chars().next().unwrap_or_default().to_string())
        .collect();

    let normal = components.last().map(|s| s.to_string()).unwrap_or_default();

    Some(ShortPath {
        prefix: format!("{} {}/", symbol, repo_display),
        shortened: if !shortened_components.is_empty() {
            format!("{}/", shortened_components.join("/"))
        } else {
            String::new()
        },
        normal,
    })
}

fn check_home_path(path_str: &str) -> Option<ShortPath> {
    let home_dir = dirs::home_dir()?;
    let home_str = home_dir.to_string_lossy();

    if path_str.starts_with(&*home_str) {
        let rel_path = path_str.strip_prefix(&*home_str)?;
        let rel_path = rel_path.strip_prefix('/').unwrap_or(rel_path);

        if rel_path.is_empty() {
            return Some(ShortPath {
                prefix: SYMBOL_HOME.to_string(),
                shortened: "".to_string(),
                normal: "".to_string(),
            });
        }

        let components: Vec<&str> = rel_path.split('/').filter(|s| !s.is_empty()).collect();
        let component_count = components.len();

        let (shortened_part, normal_part) = if component_count <= 1 {
            (Vec::new(), components.clone())
        } else {
            let (a, b) = components.split_at(component_count - 1);
            (a.to_vec(), b.to_vec())
        };

        let shortened: String = if shortened_part.is_empty() {
            String::new()
        } else {
            let short = shortened_part
                .iter()
                .map(|part| part.chars().next().unwrap_or_default().to_string())
                .collect::<Vec<String>>()
                .join("/");
            format!("{}/", short)
        };

        let normal = normal_part.join("/");

        return Some(ShortPath {
            prefix: format!("{}/", SYMBOL_HOME),
            shortened,
            normal,
        });
    }

    None
}

fn create_regular_path(path_str: &str, max_segments: usize) -> ShortPath {
    let components: Vec<&str> = path_str.split('/').filter(|s| !s.is_empty()).collect();
    let component_count = components.len();

    // For empty or root path
    if component_count == 0 {
        return ShortPath {
            prefix: SYMBOL_ROOT.to_string(),
            shortened: "".to_string(),
            normal: "".to_string(),
        };
    }

    let normal_count = component_count.min(max_segments);
    let shortened_count = component_count - normal_count;

    let (shortened_part, normal_part) = components.split_at(shortened_count);

    let shortened = if shortened_part.is_empty() {
        String::new()
    } else {
        let short = shortened_part
            .iter()
            .map(|part| part.chars().next().unwrap_or_default().to_string())
            .collect::<Vec<String>>()
            .join("/");
        format!("{}/", short)
    };

    let normal = normal_part.join("/");

    ShortPath {
        prefix: SYMBOL_ROOT.to_string(),
        shortened,
        normal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_regular_path() {
        let path = "/usr/local/share/man/man1/bash.1";
        let result = create_regular_path(path, 1);
        assert_eq!(result.prefix, "/");
        assert_eq!(result.shortened, "u/l/s/m/m/");
        assert_eq!(result.normal, "bash.1");
        assert_eq!(result.full(), "/u/l/s/m/m/bash.1");

        // Test with more preserved segments
        let result = create_regular_path(path, 2);
        assert_eq!(result.prefix, "/");
        assert_eq!(result.shortened, "u/l/s/m/");
        assert_eq!(result.normal, "man1/bash.1");
        assert_eq!(result.full(), "/u/l/s/m/man1/bash.1");
    }

    #[test]
    fn test_home_path() {
        // This test is a bit tricky since it depends on the home directory
        // We can only check the structure of the output
        if let Some(home_dir) = dirs::home_dir() {
            let test_path = home_dir.join("Documents/projects/notes/todo.txt");
            if let Some(result) = check_home_path(&test_path.to_string_lossy()) {
                assert_eq!(result.prefix, "~/");
                // The shortened and normal parts will depend on the actual path
                assert!(result.shortened.len() > 0 || result.normal.len() > 0);
            }
        }
    }

    #[test]
    fn test_world_tree_path() {
        let path =
            "/Users/username/world/trees/project-name/src/areas/clients/some-web/components";
        let result = check_world_tree_path(path);
        assert!(result.is_some());

        let result = result.unwrap();
        assert_eq!(
            result.prefix,
            format!("{} project-name//some-web/", SYMBOL_WORLD)
        );
        assert_eq!(result.shortened, "");
        assert_eq!(result.normal, "components");
        assert_eq!(
            result.full(),
            format!("{} project-name//some-web/components", SYMBOL_WORLD)
        );
    }

    #[test]
    fn test_create_regular_path_root() {
        let result = create_regular_path("/", 1);
        assert_eq!(result.prefix, "/");
        assert_eq!(result.shortened, "");
        assert_eq!(result.normal, "");
        assert_eq!(result.full(), "/");
    }

    #[test]
    fn test_create_regular_path_with_max_segments() {
        let path = "/a/b/c/d/e";

        // Test with max_segments = 1 (default)
        let result = create_regular_path(path, 1);
        assert_eq!(result.prefix, "/");
        assert_eq!(result.shortened, "a/b/c/d/");
        assert_eq!(result.normal, "e");
        assert_eq!(result.full(), "/a/b/c/d/e");

        // Test with max_segments = 2
        let result = create_regular_path(path, 2);
        assert_eq!(result.prefix, "/");
        assert_eq!(result.shortened, "a/b/c/");
        assert_eq!(result.normal, "d/e");
        assert_eq!(result.full(), "/a/b/c/d/e");

        // Test with max_segments > number of segments
        let result = create_regular_path(path, 10);
        assert_eq!(result.prefix, "/");
        assert_eq!(result.shortened, "");
        assert_eq!(result.normal, "a/b/c/d/e");
        assert_eq!(result.full(), "/a/b/c/d/e");
    }

    #[test]
    fn test_extract_github_info() {
        // Test successful extraction
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

        // Test failures - too many parts (should return None)
        assert_eq!(
            extract_github_info("/some/path/to/github.com/too/many/parts/"),
            None
        );

        assert_eq!(
            extract_github_info("/path/github.com/owner/repo/subdir"),
            None
        );

        // Test failures - too few parts
        assert_eq!(extract_github_info("/path/github.com/onlyowner"), None);

        assert_eq!(extract_github_info("/path/github.com/"), None);

        // Test no github.com in path
        assert_eq!(extract_github_info("/path/gitlab.com/owner/repo"), None);
    }
}
