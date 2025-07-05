# worktree-util

Worktree navigation and path shortening utilities for development workflows.

## Installation

```bash
cargo install --path .
```

## Quick Start

Set up shell integration (Fish example):

```fish
# Add to ~/.config/fish/config.fish
worktree-util shell-init --shell fish --init-navigate --navigate j --init-code --code jc | source
```

This gives you:
- `j <query>` - Jump to any worktree/repository
- `jc <query>` - Open multiple worktrees in VS Code (multi-select with TAB)
- Automatic path shortening in your prompt via environment variables

## Shell Prompt Integration

The shell-init command automatically maintains these variables as you navigate:

### Fish Shell Example

```fish
# Example prompt using the pre-computed path segments
function fish_prompt
    echo -n -s $WORKTREE_PATH_PREFIX $WORKTREE_PATH_SHORTENED $WORKTREE_PATH_NORMAL " ❯ "
end
```

### Starship Example

```toml
# ~/.config/starship.toml
format = "${env_var.WORKTREE_PATH_PREFIX}${env_var.WORKTREE_PATH_SHORTENED}${env_var.WORKTREE_PATH_NORMAL} $character"

# Disable the default directory module
[directory]
disabled = true

# Configure the worktree-util environment variables
[env_var.WORKTREE_PATH_PREFIX]
format = "[$env_value]($style)"
style = "purple"

[env_var.WORKTREE_PATH_SHORTENED]
format = "[$env_value]($style)"
style = "cyan"

[env_var.WORKTREE_PATH_NORMAL]
format = "[$env_value]($style)"
style = "bold cyan"
```

This produces prompts like:
- `🌍 main//frontend ❯` for world tree projects
- ` user/repo ❯` for GitHub repositories
- `~/D/projects ❯` for regular directories

## Navigation Examples

```bash
# Jump to frontend project (fuzzy matching)
$ j fe
# Now in: /Users/you/world/trees/main/src/areas/apps/frontend

# Open multiple projects in VS Code
$ jc backend
# Select with TAB, then Enter to open all selected paths
```

## Additional Features

The `worktree-util` binary provides several subcommands:

- `shortpath` - Manual path shortening with various output formats
- `nav` - Direct navigation with options for listing, filtering, and scoring
- `shell-init` - Generate shell integration for fish or zsh
- Various flags for customization (see `--help` on each subcommand)
