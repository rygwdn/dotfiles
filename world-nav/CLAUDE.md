# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

World-nav is a Rust CLI tool for worktree navigation and path shortening utilities. It provides:
- Fast directory jumping with frecency-based ranking
- Path shortening for shell prompts
- Shell integration for Fish and Zsh
- Version compatibility checking

## Installation

Use the install script for a complete installation with quality checks:

```bash
# Run the install script (includes formatting, linting, and tests)
./install.sh
```

The install script will:
1. Install the Rust toolchain from `rust-toolchain.toml`
2. Run formatter checks (`cargo fmt -- --check`)
3. Run linter checks (`cargo clippy -- -D warnings`)
4. Run all tests (`cargo test`)
5. Build the release binary
6. Install to `~/.cargo/bin/world-nav`

## Development Commands

```bash
# Format code
cargo fmt

# Run linter
cargo clippy -- -W clippy::all

# Run tests
cargo test

# Build debug version
cargo build

# Build release version
cargo build --release

# Run with specific arguments
cargo run -- [SUBCOMMAND] [OPTIONS]

# Update dependencies
cargo update
```

## Architecture

The project is organized into multiple modules:

### Commands
- `shell-init`: Generates shell integration code with version checking
- `shortpath`: Shortens paths for shell prompts
- `navigate`: Jump to directories based on frecency
- `update-frecency`: Updates directory visit statistics
- Other navigation and utility commands

### Key Features

1. **Version Compatibility**: The `shell-init` command supports `--require-version` that accepts either:
   - A version string (e.g., `"^0.5.1"`)
   - A path to a Cargo.toml file to extract version from

2. **Path Shortening**: Custom logic for different path types:
   - Git repository paths (using libgit2)
   - Home directory paths
   - World trees paths (custom pattern)

3. **Shell Integration**: Supports Fish and Zsh with:
   - Directory navigation functions
   - Frecency tracking hooks
   - Path segment updates for prompts

## Shell Integration

To integrate with your shell, add to your config:

```fish
# Fish shell (~/.config/fish/config.fish)
if status is-interactive
    which world-nav &>/dev/null && world-nav shell-init --shell fish --require-version ~/dotfiles/world-nav/Cargo.toml | source
end
```

```zsh
# Zsh shell (~/.zshrc)
if [[ $- == *i* ]] && command -v world-nav &>/dev/null; then
    eval "$(world-nav shell-init --shell zsh --require-version ~/dotfiles/world-nav/Cargo.toml)"
fi
```

## Configuration

The tool uses several configuration files:
- `rust-toolchain.toml`: Specifies Rust version (1.89.0)
- `Cargo.toml`: Project dependencies and linting rules

## Linting Configuration

The project enforces strict linting rules:
- Complexity warnings
- Correctness denials
- Performance warnings
- Style warnings
- Specific warnings for `unwrap_used`, `expect_used`, `panic`, etc.

## Testing

Run all tests:
```bash
cargo test
```

Run specific test:
```bash
cargo test test_name
```

## Troubleshooting

If you encounter version mismatch errors:
1. Run `./install.sh` to rebuild and install the latest version
2. The error message will show the installed version vs required version
3. The build script path is captured at compile time for accurate error messages