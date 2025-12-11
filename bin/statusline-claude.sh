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
  if jq --arg cmd "$SCRIPT_PATH" '.statusLine = {"type": "command", "command": $cmd, "padding": 0}' "$SETTINGS_FILE" >"${SETTINGS_FILE}.tmp"; then
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
  # Known fields (dot-notation paths to leaf values)
  KNOWN_FIELDS=(
    "session_id"
    "transcript_path"
    "cwd"
    "model.id"
    "model.display_name"
    "workspace.current_dir"
    "workspace.project_dir"
    "version"
    "output_style.name"
    "cost.total_cost_usd"
    "cost.total_duration_ms"
    "cost.total_api_duration_ms"
    "cost.total_lines_added"
    "cost.total_lines_removed"
    "context_window.total_input_tokens"
    "context_window.total_output_tokens"
    "context_window.context_window_size"
    "exceeds_200k_tokens"
  )

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
          "output_style": {"name": "default"},
          "cost": {
              "total_cost_usd": 0.042,
              "total_duration_ms": 120000,
              "total_api_duration_ms": 95000,
              "total_lines_added": 50,
              "total_lines_removed": 10
          },
          "context_window": {
              "total_input_tokens": 45000,
              "total_output_tokens": 5000,
              "context_window_size": 200000
          }
      }'
  else
    # Read Claude Code context from stdin
    input=$(cat)
  fi

  # Detect unknown fields
  actual_fields=$(echo "$input" | jq -r '[paths(scalars) | join(".")] | .[]')
  unknown_count=0
  while IFS= read -r field; do
    [[ -z "$field" ]] && continue
    match=0
    for known in "${KNOWN_FIELDS[@]}"; do
      [[ "$field" == "$known" ]] && match=1 && break
    done
    [[ $match -eq 0 ]] && ((unknown_count++))
  done <<< "$actual_fields"

  if [[ $unknown_count -gt 0 ]]; then
    export CLAUDE_NEW_FIELDS="+${unknown_count} new"
    # Dump input to temp file if older than 5 mins (or doesn't exist)
    dump_file="/tmp/claude-statusline-input.json"
    should_dump=0
    if [[ ! -f "$dump_file" ]]; then
      should_dump=1
    elif [[ $(( $(date +%s) - $(stat -f %m "$dump_file") )) -gt 300 ]]; then
      should_dump=1
    fi
    if [[ $should_dump -eq 1 ]]; then
      echo "$input" | jq . > "$dump_file" 2>/dev/null
    fi
  fi

  # Extract and export all Claude variables in one jq expression
  eval $(echo "$input" | jq -r '
    "export CLAUDE_CODE=1",
    "export CLAUDE_MODEL=" + (.model.display_name // .model.id // "Unknown" | @sh),
    "export CLAUDE_VERSION=" + (.version // "Unknown" | @sh),
    "export CLAUDE_SESSION_ID=" + (.session_id // "" | @sh),
    # Only export cost if non-zero, with dollar sign prefix
    "export CLAUDE_COST=" + (
      if (.cost.total_cost_usd // 0) > 0 then
        ("$" + ((.cost.total_cost_usd * 100 | floor) / 100 | tostring)) | @sh
      else
        "" | @sh
      end
    ),
    "export CLAUDE_LINES_ADDED=" + ((.cost.total_lines_added // 0) | tostring | @sh),
    "export CLAUDE_LINES_REMOVED=" + ((.cost.total_lines_removed // 0) | tostring | @sh),
    "export CLAUDE_PROJECT_DIR=" + (.workspace.project_dir // "" | @sh),
    # Create a combined lines format
    "export CLAUDE_LINES_CHANGES=" + (
      if (.cost.total_lines_added // 0) > 0 and (.cost.total_lines_removed // 0) > 0 then
        "+" + ((.cost.total_lines_added // 0) | tostring) + "/-" + ((.cost.total_lines_removed // 0) | tostring)
      elif (.cost.total_lines_added // 0) > 0 then
        "+" + ((.cost.total_lines_added // 0) | tostring)
      elif (.cost.total_lines_removed // 0) > 0 then
        "-" + ((.cost.total_lines_removed // 0) | tostring)
      else
        ""
      end | @sh
    ),
    # Context window percentage used
    (
      (.context_window.total_input_tokens // 0) as $input |
      (.context_window.total_output_tokens // 0) as $output |
      (.context_window.context_window_size // 0) as $size |
      if $size > 0 then
        ((($input + $output) * 100 / $size) | floor) as $pct |
        "export CLAUDE_CONTEXT_PCT=" + ($pct | tostring | @sh),
        "export CLAUDE_CONTEXT_DISPLAY=" + (($pct | tostring) + "%" | @sh)
      else
        "export CLAUDE_CONTEXT_PCT=",
        "export CLAUDE_CONTEXT_DISPLAY="
      end
    ),
    # Lines changed with padding for 4-digit numbers
    "export CLAUDE_LINES_ADDED_PADDED=" + ((.cost.total_lines_added // 0) | tostring | ((" " * (4 - length)) + .) | @sh),
    "export CLAUDE_LINES_REMOVED_PADDED=" + ((.cost.total_lines_removed // 0) | tostring | ((" " * (4 - length)) + .) | @sh)
  ')

  # Set context display in color-specific vars (starship can't do dynamic styling)
  # Colors based on usage: green (<50%), yellow (50-75%), red (>75%)
  if [[ -n "$CLAUDE_CONTEXT_PCT" ]]; then
    if [[ $CLAUDE_CONTEXT_PCT -lt 50 ]]; then
      export CLAUDE_CONTEXT_GREEN="$CLAUDE_CONTEXT_DISPLAY"
    elif [[ $CLAUDE_CONTEXT_PCT -lt 75 ]]; then
      export CLAUDE_CONTEXT_YELLOW="$CLAUDE_CONTEXT_DISPLAY"
    else
      export CLAUDE_CONTEXT_RED="$CLAUDE_CONTEXT_DISPLAY"
    fi
  fi

  # Extract current_dir separately as we need it for cd
  current_dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // "/"')

  # Run world-nav to get path components
  if command -v world-nav &>/dev/null; then
    # Get the different path sections from world-nav
    export WORKTREE_PATH_PREFIX=$(world-nav shortpath --section prefix "$current_dir" 2>/dev/null || echo "")
    export WORKTREE_PATH_SHORTENED=$(world-nav shortpath --section shortened "$current_dir" 2>/dev/null || echo "")
    export WORKTREE_PATH_NORMAL=$(world-nav shortpath --section normal "$current_dir" 2>/dev/null || echo "")
  fi

  # Change to the current directory for accurate git/project context
  cd "$current_dir" 2>/dev/null || cd /

  # Use starship with your custom config to generate the prompt
  export STARSHIP_SHELL=
  export STARSHIP_CONFIG=$HOME/dotfiles/starship-claude.toml
  starship prompt
) | head -1 2>/dev/null
