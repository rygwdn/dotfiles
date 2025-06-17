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
worktree-nav --init-navigate                    # Default shell ($SHELL), creates 'wl' function
worktree-nav --shell fish --init-navigate       # Fish shell, creates 'wl' function
worktree-nav --shell fish --init-navigate nav   # Fish shell, creates 'nav' function
worktree-nav --shell bash --init-navigate jump  # Bash shell, creates 'jump' function

# Generate VS Code multi-select function
worktree-nav --init-code                        # Default shell ($SHELL), creates 'jc' function
worktree-nav --shell fish --init-code           # Fish shell, creates 'jc' function
worktree-nav --shell fish --init-code mc        # Fish shell, creates 'mc' function

# Generate both functions at once
worktree-nav --shell fish --init-navigate wl --init-code jc

# Multi-select mode
worktree-nav --multi              # Interactive multi-selection with TAB/Shift-TAB
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

### Shell Navigation

The worktree-nav tool provides two types of shell functions:

1. **Navigation functions** (`--init-navigate`): Change directory to selected worktree
2. **VS Code functions** (`--init-code`): Open multiple worktrees in VS Code

Both function types are minimal and do not include completions or comments for simplicity.

#### Setting up navigation function (Fish example)

```fish
# Generate with default name 'wl'
worktree-nav --shell fish --init-navigate | source

# Or with a custom function name
worktree-nav --shell fish --init-navigate nav | source

# Make it permanent
worktree-nav --shell fish --init-navigate nav >> ~/.config/fish/config.fish
```

#### Setting up VS Code multi-select function (Fish example)

```fish
# Generate with default name 'jc'
worktree-nav --shell fish --init-code | source

# Or with a custom function name
worktree-nav --shell fish --init-code mycode | source

# Make it permanent
worktree-nav --shell fish --init-code mycode >> ~/.config/fish/config.fish
```

#### Setting up both functions at once

```fish
# Generate both functions with default names
worktree-nav --shell fish --init-navigate --init-code | source

# Generate both functions with custom names
worktree-nav --shell fish --init-navigate wl --init-code jc | source

# Add to config
worktree-nav --shell fish --init-navigate wl --init-code jc >> ~/.config/fish/config.fish
```

### Multi-Select for VS Code

The VS Code function allows you to select multiple worktree paths and open them all in VS Code:

```fish
# Usage (assuming function name is 'jc')
jc                    # Interactive multi-select, then open in VS Code
jc platform          # Search for 'platform', multi-select matching paths

# How it works:
# 1. Run the function with optional search terms
# 2. Use TAB to select multiple paths
# 3. Use Shift-TAB to deselect
# 4. Press Enter to confirm and open all selected paths in VS Code
```

This is available for all supported shells:
```bash
# Bash - both functions with default names
worktree-nav --shell bash --init-navigate --init-code >> ~/.bashrc

# Zsh - both functions with custom names
worktree-nav --shell zsh --init-navigate wl --init-code jc >> ~/.zshrc

# Fish - both functions with custom names
worktree-nav --shell fish --init-navigate wl --init-code jc >> ~/.config/fish/config.fish

# Auto-detect shell from $SHELL (with custom names)
worktree-nav --init-navigate wl --init-code jc >> ~/.shellrc
```

### Manual Setup (Alternative)

If you prefer to see what the functions do, here's an example of what `--shell fish --init-navigate` generates:

```fish
function wl
    set -l result (/path/to/worktree-nav $argv)
    if test -n "$result"
        cd $result
    end
end
```

And here's what `--shell fish --init-code jc` generates:

```fish
function jc
    set -l paths (/path/to/worktree-nav --multi $argv)
    if test (count $paths) -gt 0
        code $paths
    end
end
```

## Architecture

The project is structured as a Rust workspace with:
- `path_shortener`: Core path shortening logic
- `scorer`: Optimal fuzzy matching algorithm
- `navigator`: Worktree discovery and navigation
- Two binaries that leverage the shared libraries

## License

MIT
