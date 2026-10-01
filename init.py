#!/usr/bin/env python3

import argparse
import platform
import os
import shutil
import sys
import subprocess
from datetime import datetime
from pathlib import Path

REPO_URL = "https://github.com/rygwdn/dotfiles"
DOTFILES_DEST = Path.home() / "dotfiles"


def bootstrap():
    """Clone or update the repo, then re-exec init.py from it."""
    if DOTFILES_DEST.exists():
        print("Updating existing dotfiles...")
        subprocess.run(["git", "-C", str(DOTFILES_DEST), "pull"], check=True)
    else:
        print("Cloning dotfiles...")
        subprocess.run(["git", "clone", REPO_URL, str(DOTFILES_DEST)], check=True)

    script = DOTFILES_DEST / "init.py"
    os.execv(sys.executable, [sys.executable, str(script)] + sys.argv[1:])


all_platforms = [
    "bashrc",
    "bin",
    "zsh",
    "zsh/zshrc",
    "ripgreprc",
    "hammerspoon",
    "wezterm.lua",
    ("tridactyl", ".config/tridactyl"),
    ("kitty.conf", ".config/kitty/kitty.conf"),
]

fish_contents = [
    ("fish/completions", ".config/fish/completions"),
    ("fish/conf.d", ".config/fish/conf.d"),
    ("fish/config.fish", ".config/fish/config.fish"),
    ("fish/functions", ".config/fish/functions"),
]

windows_links = all_platforms + fish_contents + [
    ("nvim", ".config/nvim"),
    ("_vsvimrc", "_vsvimrc"),
    ("windows/profile.ps1", "Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1"),
    ("win-vind", ".win-vind"),
]

unix_links = all_platforms + fish_contents + [
    ("nvim", ".config/nvim"),
    "flexget",
    "tmux.conf",
    ("omp/secrets/extension.ts", ".omp/agent/extensions/omp-secrets.ts"),
]

DOTFILES_DIR = Path(__file__).resolve().parent


def _backup(path):
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = path.parent / (path.name + f".bak.{stamp}")
    path.rename(backup)
    return backup


def dolink(file, destname=None, force=False):
    src = (DOTFILES_DIR / file).resolve()
    dest = Path.home() / (destname or "." + src.name)
    label_dest = "~/" + str(dest.relative_to(Path.home()))
    label_src = src.relative_to(DOTFILES_DIR)

    if not src.exists():
        print(f"✘ {label_src} does not exist, skipping")
        return

    if dest.exists() and src.samefile(dest):
        print(f"✔ {label_src} -> {label_dest}")
        return

    if dest.is_file():
        same = dest.read_text() == src.read_text()
        block_desc = f"exists & {'contains same content as' if same else 'differs from'} {label_src}"
        replace_msg = "replacing identical file" if same else "backing up & replacing"
        def action(): _backup(dest); dest.symlink_to(src)
    elif dest.exists():
        block_desc = f"exists & not linked to {label_src}"
        replace_msg = "backing up & replacing"
        def action(): _backup(dest); dest.symlink_to(src)
    elif dest.is_symlink():
        block_desc = "is a broken link"
        replace_msg = "removing broken link & replacing"
        def action(): dest.unlink(); dest.symlink_to(src)
    else:
        print(f"↷ {label_src} -> {label_dest}")
        return lambda: dest.symlink_to(src)

    if force:
        print(f"↷ {label_src} -> {label_dest} ({replace_msg})")
        return action
    else:
        print(f"✘ {label_dest} {block_desc}")


def dounlink(file, destname=None):
    src = (DOTFILES_DIR / file).resolve()
    dest = Path.home() / (destname or "." + src.name)
    label_dest = "~/" + str(dest.relative_to(Path.home()))
    label_src = src.relative_to(DOTFILES_DIR)

    if dest.is_symlink() and dest.exists() and src.samefile(dest):
        print(f"✘ {label_src} -> {label_dest} (removing)")
        return lambda: dest.unlink()
    else:
        print(f"  {label_dest} not linked to {label_src}, skipping")


def check_windows_env():
    env_issues = []
    home = Path.home()
    expected_config = f"{home}\\.config"
    if os.environ.get("XDG_CONFIG_HOME") != expected_config:
        env_issues.append(f'Please set XDG_CONFIG_HOME to "{expected_config}"')
    if os.environ.get("HOME") != str(home):
        env_issues.append(f'Please set HOME to "{home}"')
    if env_issues:
        print("-------------------------------------")
        for ei in env_issues:
            print(ei)
        print("-------------------------------------")


def check_tools(install=False):
    is_mac = platform.system() == "Darwin"
    is_linux = platform.system() == "Linux"

    tools = [
        {
            "cmd": "starship",
            "desc": "prompt theme",
            "mac": "brew install starship",
            "linux": "curl -sS https://starship.rs/install.sh | sh",
        },
        {
            "cmd": "jumpr",
            "desc": "smart directory navigation (used in prompt)",
            "mac": 'curl -fsSL https://raw.githubusercontent.com/rygwdn/jump/main/get-jumpr.sh | sh -s -- --install-dir "$HOME/.local/bin"',
            "linux": 'curl -fsSL https://raw.githubusercontent.com/rygwdn/jump/main/get-jumpr.sh | sh -s -- --install-dir "$HOME/.local/bin"',
        },
    ]

    missing = [t for t in tools if not shutil.which(t["cmd"])]
    if not missing:
        return

    if install:
        for tool in missing:
            cmd = tool["mac"] if is_mac else tool["linux"] if is_linux else None
            if not cmd:
                print(f"  ✘ {tool['cmd']} — no install command for this platform")
                continue
            print(f"\n⬇ Installing {tool['cmd']} ({tool['desc']})...")
            result = subprocess.run(cmd, shell=True)
            if result.returncode != 0:
                print(f"  ✘ Failed to install {tool['cmd']}")
            elif shutil.which(tool["cmd"]):
                print(f"  ✔ {tool['cmd']} installed")
            else:
                print(f"  ⚠ Install ran but {tool['cmd']} not found in PATH")
    else:
        print("\n⚠ Missing tools (run with --install-tools to install):")
        for tool in missing:
            cmd = tool["mac"] if is_mac else tool["linux"] if is_linux else None
            print(f"  ✘ {tool['cmd']} — {tool['desc']}")
            if cmd:
                print(f"      Install: {cmd}")
        print()


def set_shell_fish():
    fish = shutil.which("fish")
    if not fish:
        print("✘ fish not found in PATH")
        return

    shells_file = Path("/etc/shells")
    if fish not in shells_file.read_text().splitlines():
        print(f"Adding {fish} to /etc/shells (requires sudo)...")
        subprocess.run(["sudo", "sh", "-c", f"echo {fish} >> /etc/shells"], check=True)

    if os.environ.get("SHELL") == fish:
        print(f"✔ shell is already {fish}")
    else:
        print(f"Setting default shell to {fish} (requires sudo)...")
        subprocess.run(["chsh", "-s", fish], check=True)


def main():
    parser = argparse.ArgumentParser(description="Initialize dotfiles")
    parser.add_argument("--dry", action="store_true", help="do a dry run")
    parser.add_argument("--clean", action="store_true", help="remove dotfile symlinks")
    parser.add_argument("--fish", action="store_true", help="set default shell to fish")
    parser.add_argument("--force", action="store_true", help="back up existing files/dirs and replace with symlinks")
    parser.add_argument("--install-tools", action="store_true", help="install missing tools (starship, jumpr)")

    args = parser.parse_args()

    if args.fish:
        set_shell_fish()

    check_tools(install=args.install_tools)

    is_windows = platform.system() == "Windows"
    links = windows_links if is_windows else unix_links
    if is_windows:
        check_windows_env()

    operations = []
    for link in links:
        src, dest = link if isinstance(link, tuple) else (link, None)
        op = dounlink(src, dest) if args.clean else dolink(src, dest, force=args.force)
        if op:
            operations.append(op)

    if args.dry:
        sys.exit(1 if operations else 0)
    else:
        if not args.clean:
            Path.home().joinpath(".config").mkdir(exist_ok=True)
            Path.home().joinpath(".config/fish").mkdir(exist_ok=True)
            Path.home().joinpath(".config/kitty").mkdir(exist_ok=True)
            Path.home().joinpath(".config/tridactyl").mkdir(exist_ok=True)
            if not is_windows:
                Path.home().joinpath(".omp/agent/extensions").mkdir(parents=True, exist_ok=True)

        for op in operations:
            op()


if __name__ == "__main__":
    if __file__ == "<stdin>":
        bootstrap()
    main()
