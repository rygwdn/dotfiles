#!/usr/bin/env python3
"""
Claude Code Statusline Script
Docs: https://docs.anthropic.com/en/docs/claude-code/statusline
      https://code.claude.com/docs/en/statusline.md
"""
import json
import os
import shutil
import subprocess
import sys

# ANSI color codes
GREEN = "\033[32m"
YELLOW = "\033[33m"
BOLD_YELLOW = "\033[1;33m"
RED = "\033[1;31m"
CYAN = "\033[36m"
DIM = "\033[2;37m"
PURPLE = "\033[35m"
BOLD_PURPLE = "\033[1;35m"
BOLD_CYAN = "\033[1;36m"
RESET = "\033[0m"

KNOWN_FIELDS = {
    "hook_event_name", "session_id", "transcript_path", "cwd",
    "model.id", "model.display_name",
    "workspace.current_dir", "workspace.project_dir",
    "version", "output_style.name",
    "cost.total_cost_usd", "cost.total_duration_ms", "cost.total_api_duration_ms",
    "cost.total_lines_added", "cost.total_lines_removed",
    "context_window.total_input_tokens", "context_window.total_output_tokens",
    "context_window.context_window_size",
    "context_window.current_usage", "context_window.current_usage.input_tokens",
    "context_window.current_usage.output_tokens",
    "context_window.current_usage.cache_creation_input_tokens",
    "context_window.current_usage.cache_read_input_tokens",
    "exceeds_200k_tokens",
}

NEW_FIELDS_FILE = "/tmp/claude/statusline-new-fields.txt"


def get_paths(obj, prefix=""):
    """Get all leaf paths from a JSON object."""
    paths = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            path = f"{prefix}.{k}" if prefix else k
            if isinstance(v, (dict, list)):
                paths.extend(get_paths(v, path))
            else:
                paths.append(path)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            paths.extend(get_paths(v, f"{prefix}.{i}"))
    return paths


def get_git_and_path(cwd):
    """Get git branch and path in parallel using Popen."""
    procs = {}

    # Start git process
    try:
        procs["git"] = subprocess.Popen(
            ["git", "symbolic-ref", "--short", "HEAD"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=cwd, text=True
        )
    except Exception:
        procs["git"] = None

    # Start world-nav process (single call with full output)
    if shutil.which("world-nav"):
        try:
            procs["path"] = subprocess.Popen(
                ["world-nav", "shortpath", "--section", "full", cwd],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
            )
        except Exception:
            procs["path"] = None

    # Collect results
    results = {}
    for name, proc in procs.items():
        if proc:
            try:
                stdout, _ = proc.communicate(timeout=1)
                results[name] = stdout.strip() if proc.returncode == 0 else ""
            except Exception:
                results[name] = ""
        else:
            results[name] = ""

    git_branch = results.get("git", "")
    path = results.get("path", "")

    # Build path display with single color
    if path:
        path_display = f"{PURPLE}{path}{RESET}"
    else:
        path_display = f"{PURPLE}{cwd}{RESET}"

    return git_branch, path_display


def persist_new_fields(unknown: set):
    """Write unknown fields to tmp file if not already present."""
    if not unknown:
        return

    os.makedirs(os.path.dirname(NEW_FIELDS_FILE), exist_ok=True)

    existing = set()
    if os.path.exists(NEW_FIELDS_FILE):
        with open(NEW_FIELDS_FILE, "r") as f:
            existing = set(line.strip() for line in f if line.strip())

    truly_new = unknown - existing
    if not truly_new:
        return

    with open(NEW_FIELDS_FILE, "a") as f:
        for field in sorted(truly_new):
            f.write(f"{field}\n")


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("--test", "-t"):
        data = {
            "model": {"id": "claude-opus-4-1", "display_name": "Opus 4.1"},
            "workspace": {"current_dir": os.getcwd()},
            "version": "0.1.0",
            "cost": {"total_cost_usd": 0.042, "total_lines_added": 50, "total_lines_removed": 10},
            "context_window": {
                "context_window_size": 200000,
                "current_usage": {
                    "input_tokens": 30000,
                    "output_tokens": 5000,
                    "cache_creation_input_tokens": 10000,
                    "cache_read_input_tokens": 5000,
                }
            }
        }
    else:
        data = json.load(sys.stdin)

    cwd = data.get("workspace", {}).get("current_dir") or data.get("cwd", os.getcwd())

    # Extract values
    model = data.get("model", {}).get("display_name") or data.get("model", {}).get("id", "Unknown")
    version = data.get("version", "Unknown")
    cost = data.get("cost", {})
    cost_usd = cost.get("total_cost_usd", 0)
    lines_added = cost.get("total_lines_added", 0)
    lines_removed = cost.get("total_lines_removed", 0)
    ctx = data.get("context_window", {})
    ctx_size = ctx.get("context_window_size", 0)

    # Use current_usage for accurate context % (null means no messages yet)
    current = ctx.get("current_usage")
    if current:
        ctx_used = (
            current.get("input_tokens", 0)
            + current.get("cache_creation_input_tokens", 0)
            + current.get("cache_read_input_tokens", 0)
        )
        ctx_pct = int(ctx_used * 100 / ctx_size) if ctx_size > 0 else 0
    else:
        ctx_pct = 0
    if ctx_pct < 50:
        ctx_color = GREEN
    elif ctx_pct < 75:
        ctx_color = YELLOW
    else:
        ctx_color = RED

    # Unknown fields
    actual = set(get_paths(data))
    unknown = actual - KNOWN_FIELDS
    unknown_str = f"{RED}+{len(unknown)} new{RESET}" if unknown else ""
    persist_new_fields(unknown)

    # Build output
    git_branch, path_display = get_git_and_path(cwd)
    parts = [path_display]

    if git_branch:
        parts.append(f"{BOLD_PURPLE}\ue0a0 {git_branch}{RESET}")

    parts.extend([
        f"{BOLD_YELLOW}⚡{model}{RESET}",
        f"{ctx_color}{ctx_pct}%{RESET}",
        f"{DIM}v{version}{RESET}",
        f"{GREEN}+{lines_added}{RESET}/{YELLOW}-{lines_removed:<4}{RESET}",
    ])
    if cost_usd > 0:
        parts.append(f"{CYAN}${cost_usd:.2f}{RESET}")
    if unknown_str:
        parts.append(unknown_str)

    print(" ".join(parts))


if __name__ == "__main__":
    main()
