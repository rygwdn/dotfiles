# worktree-util

Worktree navigation and path shortening utilities for development workflows.

## Installation

```bash
cargo install --path .
```

## Binaries

### shortpath

A path shortening utility for shell prompts that intelligently handles:
- World tree projects (~/world/trees/*)
- Git repositories with special handling for GitHub repos
- Home directory paths
- Regular paths

#### Usage

```bash
# Shorten current directory
shortpath

# Shorten specific path
shortpath /path/to/directory

# Output specific sections
shortpath -s prefix,normal  # Output prefix and normal parts separately
shortpath -s shortened      # Output only the shortened middle part

# Batch mode - read paths from stdin
find . -type d | shortpath --stdin

# Control number of unshortened segments
shortpath -n 2 /very/long/path/to/file  # Keep last 2 segments unshortened
```

#### Examples

```bash
$ shortpath ~/world/trees/root/src/areas/clients/checkout-web
🌍 root//checkout-web

$ shortpath ~/src/github.com/user/repo
 user/repo

$ shortpath ~/Documents/projects
~/D/projects
```

### worktree-nav

Fast fuzzy path navigation for world trees and Git repositories.

#### Usage

```bash
# Interactive fuzzy search with fzf
worktree-nav

# Jump directly to a match
worktree-nav checkout-web

# List all available paths
worktree-nav --list

# List with scores (zoxide integration)
worktree-nav --list --scores

# Filter paths (for integration with fzf)
worktree-nav --filter "query"

# Run tests
worktree-nav --test

# Generate shell integration script
worktree-nav --init=fish         # Default: creates 'wl' function
worktree-nav --init=fish:nav     # Custom: creates 'nav' function
worktree-nav --init=fish:jump    # Custom: creates 'jump' function
```

#### Features

- **Intelligent Scoring**: Integrates with zoxide for frecency-based ranking
- **Fuzzy Matching**: Uses an optimal scoring algorithm that prefers:
  - Word boundaries (e.g., 'cw' matches [c]heckout-[w]eb)
  - Consecutive characters
  - Matches in project/repo names over path components
- **Branch Awareness**: Shows non-default branches in square brackets
- **Context Awareness**: Prioritizes projects in your current worktree

#### Examples

```bash
# Jump to checkout-web in any worktree
$ worktree-nav cw
/Users/you/world/trees/root/src/areas/clients/checkout-web

# List all projects with scores
$ worktree-nav --list --scores
total:250 (zoxide:50, base:200, query:0) root/shopify
total:180 (zoxide:80, base:100, query:0) other/platform
total:50 (zoxide:100, base:-50, query:0) github.com/user/repo

# Filter with query
$ worktree-nav --filter "plat"
🌍 root//platform    /Users/you/world/trees/root/src/areas/services/platform
🌍 other//platform   /Users/you/world/trees/other/src/areas/services/platform
```

## Integration

### Shell Prompt (Fish example)

```fish
function fish_prompt
    set -l last_status $status
    set -l normal_color (set_color normal)

    # Use shortpath for directory display
    set -l pwd_string (shortpath $PWD)

    echo -n -s $pwd_string $normal_color " ❯ "
end
```

### Shell Navigation (Fish example)

```fish
# Set up the wl function by running this once:
worktree-nav --init=fish | source

# Or with a custom function name:
worktree-nav --init=fish:nav | source
worktree-nav --init=fish:jump | source

# Make it permanent by adding to config.fish:
worktree-nav --init=fish >> ~/.config/fish/config.fish

# The generated function provides:
# - Navigation command with your chosen name
# - Tab completion support
# - Full path to worktree-nav (works even if not in PATH)
# - Optional keybinding (uncomment in generated output)
```

### Manual Setup (Alternative)

If you prefer to customize the function, here's what `--init=fish` generates:

```fish
function wl --description "Navigate to worktree projects"
    set -l result (/full/path/to/worktree-nav $argv)
    if test -n "$result"
        cd $result
    end
end

# Add tab completion
complete -c wl -f -a "(/full/path/to/worktree-nav --list)"

# Optional: Bind to a key (Ctrl+G)
bind \cg wl
```

## Architecture

The project is structured as a Rust workspace with:
- `path_shortener`: Core path shortening logic
- `scorer`: Optimal fuzzy matching algorithm
- `navigator`: Worktree discovery and navigation
- Two binaries that leverage the shared libraries

## License

MIT
