#!/usr/bin/env python3
"""
Claude Code Statusline Script
Docs: https://docs.anthropic.com/en/docs/claude-code/statusline
      https://code.claude.com/docs/en/statusline.md
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

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
    "hook_event_name",
    "session_id",
    "transcript_path",
    "cwd",
    "model.id",
    "model.display_name",
    "workspace.current_dir",
    "workspace.project_dir",
    "version",
    "output_style.name",
    "cost.total_cost_usd",
    "cost.total_duration_ms",
    "cost.total_api_duration_ms",
    "cost.total_lines_added",
    "cost.total_lines_removed",
    "context_window.total_input_tokens",
    "context_window.total_output_tokens",
    "context_window.context_window_size",
    "context_window.current_usage",
    "context_window.current_usage.input_tokens",
    "context_window.current_usage.output_tokens",
    "context_window.current_usage.cache_creation_input_tokens",
    "context_window.current_usage.cache_read_input_tokens",
    "exceeds_200k_tokens",
    "vim.mode",
    "context_window.used_percentage",
    "context_window.remaining_percentage",
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
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=cwd,
            text=True,
        )
    except Exception:
        procs["git"] = None

    # Start world-nav process (single call with full output)
    if shutil.which("world-nav"):
        try:
            procs["path"] = subprocess.Popen(
                ["world-nav", "shortpath", "--section", "full", cwd],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
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


def get_circle_emoji(percentage, time_remaining_hours, total_window_hours):
    """
    Convert percentage to circle filling emoji based on burn rate.

    Args:
        percentage: Current utilization percentage
        time_remaining_hours: Hours until reset
        total_window_hours: Total hours in the usage window (5 or 168 for 7 days)

    Returns:
        Emoji representing usage health based on burn rate
    """
    # Calculate time elapsed as percentage of total window
    time_elapsed_pct = (
        (total_window_hours - time_remaining_hours) / total_window_hours
    ) * 100

    # Calculate burn rate ratio: how fast we're using vs time passing
    # If we're at 50% usage with 50% time elapsed, burn_rate = 1.0 (perfect pace)
    # If we're at 75% usage with 50% time elapsed, burn_rate = 1.5 (too fast)
    # If we're at 25% usage with 50% time elapsed, burn_rate = 0.5 (slow pace)
    if time_elapsed_pct > 0:
        burn_rate = percentage / time_elapsed_pct
    else:
        burn_rate = 0

    # Projected usage at end of window based on current burn rate
    if time_remaining_hours > 0:
        projected_usage = percentage + (
            burn_rate * (time_remaining_hours / total_window_hours) * 100
        )
    else:
        projected_usage = percentage

    # Color based on projected outcome
    if projected_usage > 100 or percentage >= 95:
        return "🔴"  # Will likely exceed limit
    elif projected_usage > 90 or percentage >= 85:
        return "🟠"  # Cutting it close
    elif projected_usage > 70 or percentage >= 60:
        return "🟡"  # Moderate usage
    elif projected_usage > 40:
        return "🟢"  # Good pace
    else:
        return "⚪"  # Light usage, plenty of headroom


def format_time_until(reset_time_str):
    """
    Format time until reset in a concise way.

    Returns:
        tuple: (formatted_string, hours_remaining)
    """
    try:
        reset_time = datetime.fromisoformat(reset_time_str.replace("+00:00", "+00:00"))
        now = datetime.now(reset_time.tzinfo)
        delta = reset_time - now

        hours_remaining = delta.total_seconds() / 3600

        if delta.total_seconds() < 0:
            return "soon", 0

        hours = int(delta.total_seconds() / 3600)
        minutes = int((delta.total_seconds() % 3600) / 60)

        if hours >= 24:
            days = hours // 24
            return f"{days}d", hours_remaining
        elif hours > 0:
            return f"{hours}h{minutes}m", hours_remaining
        else:
            return f"{minutes}m", hours_remaining
    except Exception:
        return "", 0


def get_usage_data():
    """Fetch usage data from Anthropic API using built-in urllib."""
    try:
        # Get access token from keychain
        token_cmd = [
            "security",
            "find-generic-password",
            "-a",
            os.environ.get("USER", ""),
            "-w",
            "-s",
            "Claude Code-credentials",
        ]
        token_proc = subprocess.run(
            token_cmd, capture_output=True, text=True, timeout=2
        )
        if token_proc.returncode != 0:
            return None

        credentials = json.loads(token_proc.stdout.strip())
        access_token = credentials.get("claudeAiOauth", {}).get("accessToken")
        if not access_token:
            return None

        # Fetch usage data using urllib
        url = "https://api.anthropic.com/api/oauth/usage"
        request = Request(url)
        request.add_header("Authorization", f"Bearer {access_token}")
        request.add_header("anthropic-beta", "oauth-2025-04-20")

        with urlopen(request, timeout=3) as response:
            usage_data = json.loads(response.read().decode())
            return usage_data
    except (URLError, HTTPError, json.JSONDecodeError, subprocess.TimeoutExpired):
        return None
    except Exception:
        return None


def install_statusline():
    """Register this script as the Claude Code statusline script."""
    config_dir = Path.home() / ".claude"
    config_file = config_dir / "settings.json"

    # Ensure directory exists
    config_dir.mkdir(parents=True, exist_ok=True)

    # Get the absolute path to this script
    script_path = os.path.abspath(__file__)

    # Load existing settings or create new ones
    if config_file.exists():
        with open(config_file, "r") as f:
            try:
                settings = json.load(f)
            except json.JSONDecodeError:
                print(f"Error: Could not parse existing {config_file}")
                sys.exit(1)
    else:
        settings = {}

    # Add/update statusLine configuration
    settings["statusLine"] = {"type": "command", "command": script_path}

    # Write back the configuration
    with open(config_file, "w") as f:
        json.dump(settings, f, indent=2)

    print(f"{GREEN}✓{RESET} Statusline installed: {CYAN}{script_path}{RESET}")
    print(f"{GREEN}✓{RESET} Configuration saved to: {CYAN}{config_file}{RESET}")
    print(
        f"\n{BOLD_YELLOW}Note:{RESET} Restart Claude Code for changes to take effect."
    )


def main():
    parser = argparse.ArgumentParser(description="Claude Code Statusline Script")
    parser.add_argument(
        "--self-install",
        action="store_true",
        help="Register this script as the Claude Code statusline",
    )
    parser.add_argument(
        "--test",
        "-t",
        action="store_true",
        help="Run with test data instead of reading from stdin",
    )
    parser.add_argument(
        "--no-usage", action="store_true", help="Disable API usage data display"
    )

    args = parser.parse_args()

    if args.self_install:
        install_statusline()
        return

    if args.test:
        data = {
            "model": {"id": "claude-opus-4-1", "display_name": "Opus 4.1"},
            "workspace": {"current_dir": os.getcwd()},
            "version": "0.1.0",
            "cost": {
                "total_cost_usd": 0.042,
                "total_lines_added": 50,
                "total_lines_removed": 10,
            },
            "context_window": {
                "context_window_size": 200000,
                "current_usage": {
                    "input_tokens": 30000,
                    "output_tokens": 5000,
                    "cache_creation_input_tokens": 10000,
                    "cache_read_input_tokens": 5000,
                },
            },
        }
    else:
        data = json.load(sys.stdin)

    cwd = data.get("workspace", {}).get("current_dir") or data.get("cwd", os.getcwd())

    # Extract values
    model = data.get("model", {}).get("display_name") or data.get("model", {}).get(
        "id", "Unknown"
    )
    version = data.get("version", "Unknown")
    cost = data.get("cost", {})
    cost_usd = cost.get("total_cost_usd", 0)
    lines_added = cost.get("total_lines_added", 0)
    lines_removed = cost.get("total_lines_removed", 0)
    ctx = data.get("context_window", {})
    ctx_size = ctx.get("context_window_size", 0)

    # Prefer used_percentage if available, otherwise calculate from tokens
    ctx_pct = ctx.get("used_percentage")
    if ctx_pct is None:
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
    else:
        ctx_pct = int(ctx_pct)
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

    parts.extend(
        [
            f"{BOLD_YELLOW}⚡{model}{RESET}",
            f"{ctx_color}{ctx_pct}%{RESET}",
            f"{DIM}v{version}{RESET}",
            f"{GREEN}+{lines_added}{RESET}/{YELLOW}-{lines_removed:<4}{RESET}",
        ]
    )
    if cost_usd > 0:
        parts.append(f"{CYAN}${cost_usd:.2f}{RESET}")

    # Add usage data (unless disabled)
    if not args.no_usage:
        usage = get_usage_data()
        if usage:
            five_hour = usage.get("five_hour", {})
            seven_day = usage.get("seven_day", {})

            if five_hour and five_hour.get("utilization") is not None:
                util_5h = five_hour.get("utilization", 0)
                reset_5h = five_hour.get("resets_at", "")
                time_5h, hours_remaining_5h = format_time_until(reset_5h)
                emoji_5h = get_circle_emoji(util_5h, hours_remaining_5h, 5)
                parts.append(f"{emoji_5h}{int(util_5h)}%/{time_5h}")

            if seven_day and seven_day.get("utilization") is not None:
                util_7d = seven_day.get("utilization", 0)
                reset_7d = seven_day.get("resets_at", "")
                time_7d, hours_remaining_7d = format_time_until(reset_7d)
                emoji_7d = get_circle_emoji(
                    util_7d, hours_remaining_7d, 168
                )  # 7 days = 168 hours
                parts.append(f"{emoji_7d}{int(util_7d)}%/{time_7d}")

    if unknown_str:
        parts.append(unknown_str)

    print(" ".join(parts))


if __name__ == "__main__":
    main()
