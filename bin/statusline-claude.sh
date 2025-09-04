#!/bin/bash
#
# Claude Code Statusline Script
# Docs: https://docs.anthropic.com/en/docs/claude-code/statusline
#
# This script generates a custom status line for Claude Code using Starship
# 
# Available JSON fields from Claude Code:
#   - session_id: The current session ID
#   - transcript_path: Path to the transcript file
#   - cwd: Current working directory (deprecated, use workspace.current_dir)
#   - model: Object with 'id' and 'display_name' fields
#   - workspace: Object with 'current_dir' and 'project_dir' fields
#   - version: Claude Code version string
#   - output_style: Current output style configuration
#   - cost: Object with 'total_cost', 'duration', 'lines_added', 'lines_removed'
#
# Test with: ./statusline-claude.sh --test
# Install to Claude config: ./statusline-claude.sh --install
# Configure in: ~/.claude/settings.json

# Check for install flag
if [[ "$1" == "--install" ]] || [[ "$1" == "-i" ]]; then
    SETTINGS_FILE="$HOME/.claude/settings.json"
    SCRIPT_PATH="$(realpath "$0")"
    
    # Check if settings file exists
    if [[ ! -f "$SETTINGS_FILE" ]]; then
        echo "Error: Claude settings file not found at $SETTINGS_FILE"
        echo "Please ensure Claude Code is installed and configured first."
        exit 1
    fi
    
    # Update the settings file with the statusLine configuration
    if jq --arg cmd "$SCRIPT_PATH" '.statusLine = {"type": "command", "command": $cmd, "padding": 0}' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp"; then
        mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"
        echo "Successfully installed statusline to Claude config:"
        echo "  Script: $SCRIPT_PATH"
        echo "  Config: $SETTINGS_FILE"
        echo ""
        echo "Test the statusline with: $0 --test"
    else
        echo "Error: Failed to update Claude settings file"
        rm -f "${SETTINGS_FILE}.tmp"
        exit 1
    fi
    exit 0
fi

(
  # Check for test flag
  if [[ "$1" == "--test" ]] || [[ "$1" == "-t" ]]; then
      # Use test values with all available fields
      input='{
          "session_id": "test-session-123",
          "transcript_path": "/tmp/test-transcript.md",
          "model": {"id": "claude-opus-4-1", "display_name": "Opus 4.1"},
          "workspace": {
              "current_dir": "'$(pwd)'",
              "project_dir": "'$(pwd)'"
          },
          "version": "0.1.0",
          "cost": {
              "total_cost": "0.042",
              "duration": "120",
              "lines_added": 50,
              "lines_removed": 10
          }
      }'
  else
      # Read Claude Code context from stdin
      input=$(cat)
  fi

  # Extract and export all Claude variables in one jq expression
  eval $(echo "$input" | jq -r '
    "export CLAUDE_CODE=1",
    "export CLAUDE_MODEL=" + (.model.display_name // .model.id // "Unknown" | @sh),
    "export CLAUDE_VERSION=" + (.version // "Unknown" | @sh),
    "export CLAUDE_SESSION_ID=" + (.session_id // "" | @sh),
    # Only export cost if non-zero, with dollar sign prefix
    "export CLAUDE_COST=" + (
      if (.cost.total_cost // "0") != "0" then
        ("$" + .cost.total_cost | @sh)
      else
        ("" | @sh)
      end
    ),
    "export CLAUDE_LINES_ADDED=" + ((.cost.lines_added // 0) | tostring | @sh),
    "export CLAUDE_LINES_REMOVED=" + ((.cost.lines_removed // 0) | tostring | @sh),
    "export CLAUDE_PROJECT_DIR=" + (.workspace.project_dir // "" | @sh),
    # Create a combined lines format
    "export CLAUDE_LINES_CHANGES=" + (
      if (.cost.lines_added // 0) > 0 and (.cost.lines_removed // 0) > 0 then
        "+" + ((.cost.lines_added // 0) | tostring) + "/-" + ((.cost.lines_removed // 0) | tostring)
      elif (.cost.lines_added // 0) > 0 then
        "+" + ((.cost.lines_added // 0) | tostring)
      elif (.cost.lines_removed // 0) > 0 then
        "-" + ((.cost.lines_removed // 0) | tostring)
      else
        ""
      end | @sh
    )
  ')
  
  # Extract current_dir separately as we need it for cd
  current_dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // "/"')

  # Run world-nav to get path components
  if command -v world-nav &> /dev/null; then
      # Get the different path sections from world-nav
      export WORKTREE_PATH_PREFIX=$(world-nav shortpath --section prefix "$current_dir" 2>/dev/null || echo "")
      export WORKTREE_PATH_SHORTENED=$(world-nav shortpath --section shortened "$current_dir" 2>/dev/null || echo "")
      export WORKTREE_PATH_NORMAL=$(world-nav shortpath --section normal "$current_dir" 2>/dev/null || echo "")
  fi

  # Change to the current directory for accurate git/project context
  cd "$current_dir" 2>/dev/null || cd /

  # Use starship with your custom config to generate the prompt
  STARSHIP_CONFIG=/Users/ryanwooden/dotfiles/starship-claude.toml starship prompt #--terminal-width=${cols:-120}
) | head -1 2> /dev/null
