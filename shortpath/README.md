# Shortpath

A path shortening utility for shell prompts, written in Rust. This tool was mostly AI-generated and is specifically designed for my personal dotfiles setup.

## Features

- Intelligently formats paths for concise, readable shell prompts
- Special handling for git repositories, home directories, and custom paths
- Configurable output with customizable segments
- Designed for use with [Starship](https://starship.rs/) prompt

## Installation

```bash
cargo install --path .
```

## Usage

```bash
shortpath [OPTIONS] [PATH]
```

### Arguments

- `PATH`: Path to shorten (defaults to current directory)

### Options

- `-n, --max-segments <MAX_SEGMENTS>`: Number of segments to keep unshortened (default: 1)
- `-s, --section <SECTION>`: Section to output (prefix, shortened, normal, full)
- `-h, --help`: Print help

## Path Formatting

Shortpath breaks paths into three main parts to make it easier to style:

1. **Prefix**: Special indicators like `~/` for home dir or git branch symbol for repos
2. **Shortened**: Middle path segments, abbreviated to first letter (e.g., `a/b/c/`)
3. **Normal**: The last segment(s) of the path, shown in full

### Path Types

Shortpath handles different path types with specialized formatting:

- **Git repositories**: Shows repo name with git branch symbol
- **Home directory**: Uses `~/` prefix with shortened paths
- **World trees paths**: Custom formatting for specific project organization pattern with format `🌎 work-tree//component/path` (optimized for my personal work development environment)
- **Regular paths**: Standard path shortening

## Integration with Starship

Example configuration in `starship.toml`:

```toml
format = "${custom.path_prefix}${custom.path_shortened}${custom.path_normal}$character"

[custom.path_prefix]
command = "shortpath -s prefix \"$PWD\""
when = "true"
format = "[$output]($style)"
style = "purple"
shell = ["bash", "--noprofile", "--norc"]

[custom.path_shortened]
command = "shortpath -s shortened \"$PWD\""
when = "true"
format = "[$output]($style)"
style = "cyan"
shell = ["bash", "--noprofile", "--norc"]

[custom.path_normal]
command = "shortpath -s normal \"$PWD\""
when = "true"
format = "[$output]($style) "
style = "bold cyan"
shell = ["bash", "--noprofile", "--norc"]
```

## Examples

- `/usr/local/bin` → `/u/l/bin`
- `~/Documents/projects` → `~/D/projects`
- Inside git repo: `⎇ repo-name/s/file.txt`
- World trees path: `~/world/trees/worktree-name/src/areas/clients/project/components` → `🌎 worktree-name//project/components`

## Note

This tool contains custom logic specific to my personal development environment, particularly the "World trees" path handling which is tailored to a specific project structure. It may require modifications to work in other environments.
