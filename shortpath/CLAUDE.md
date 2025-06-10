# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Shortpath is a Rust CLI tool that shortens file system paths for shell prompts. It's designed specifically for integration with Starship prompt and contains custom logic for the author's development environment.

## Build and Development Commands

```bash
# Build the project
cargo build

# Run tests
cargo test

# Format code (configured via rustfmt.toml)
cargo fmt

# Run linter (configured in Cargo.toml)
cargo clippy

# Install locally
cargo install --path .

# Run with specific arguments
cargo run -- [OPTIONS] [PATH]

# Update dependencies
cargo update
```

## Architecture

The project follows a single-file architecture with all code in `src/main.rs`. Key components:

1. **ShortPath struct**: Core data structure with `prefix`, `shortened`, and `normal` fields
2. **Path processing priority** (highest to lowest):
   - World trees paths (custom `/world/trees/` pattern)
   - Git repository paths (using libgit2)
   - Home directory paths
   - Regular paths

3. **Symbol constants**:
   - `SYMBOL_WORLD`: `\u{f484}` (nf-oct-globe)
   - `SYMBOL_GIT`: `\u{e0a0}` (nf-pl-branch)
   - `SYMBOL_HOME`: `~`
   - `SYMBOL_ROOT`: `/`

## Special Considerations

1. **World Trees Path Pattern**: Highly specific to author's environment
   - Pattern: `/world/trees/[project]/src/areas/[area]/[component]/...`
   - Output: `[SYMBOL_WORLD] [project]//[component]/...`

2. **Rust Edition**: Uses 2024 edition
3. **Dependencies**: Uses latest versions of clap, dirs, git2, and regex
4. **Linting**: Strict Clippy configuration with warnings for unwrap_used, expect_used, etc.

## Testing

All tests are in the main source file. Run specific tests with:
```bash
cargo test test_name
```