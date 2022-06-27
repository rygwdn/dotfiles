#!/usr/bin/env python3

import argparse
import platform
import os
from pathlib import Path

all_platforms = [
    "bashrc",
    "bin",
    "zsh",
    "zsh/zshenv",
    "zsh/zshrc",
    "zsh/zpreztorc",
    "ripgreprc",
    ("fish", ".config/fish"),
    ("tridactyl", ".config/tridactyl"),
]

windows_links = all_platforms + [
    ("vim", "vimfiles"),
    #("vim", "AppData/Local/nvim"),
    ("vim", ".config/nvim"),
    ("vim/_vimrc",  "_vimrc"),
    ("_vsvimrc",  "_vsvimrc"),
    ("windows/profile.ps1",  "Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1"),
    ("win-vind",  ".win-vind"),
]

unix_links = all_platforms + [
    "vim",
    "vim/vimrc",
    ("vim", ".config/nvim"),
    "flexget",
    "tmux.conf",
]

def dolink(file, destname=None):
    src = Path(file).resolve()
    orig_dest = Path(Path.home(), destname or "." + src.name)
    dest = orig_dest.resolve()

    destname = "~/" + (destname or str(dest.relative_to(Path.home())))
    srcname = src.relative_to(Path.cwd())

    if not src.exists():
        raise Exception(f"{src} does not exist!")

    if src.exists() and dest.exists() and src.samefile(dest):
        #destname = orig_dest
        #srcname = src
        print(f"✔ {srcname} -> {destname}")
    elif dest.exists() and dest.is_file():
        with dest.open() as dFile:
            with src.open() as sFile:
                if dFile.readlines() == sFile.readlines():
                    print(f"✘ {destname} exists & contains same content as {srcname}")
                else:
                    print(f"✘ {destname} exists & differs from {srcname}")
    elif dest.exists():
        print(f"✘ {destname} exists & not linked to {srcname}")
    elif dest.is_symlink():
        print(f"✘ {destname} is a broken link")
    else:
        print(f"↷ {srcname} -> {destname}")
        return lambda: dest.symlink_to(src.resolve())

def check_windows_env():
    env_issues = []

    home = Path.home()
    expected_config = f"{home}\\.config"
    if 'XDG_CONFIG_HOME' not in os.environ or os.environ['XDG_CONFIG_HOME'] != expected_config:
        env_issues.append(f'Please set XDG_CONFIG_HOME to "{expected_config}"')
    if 'HOME' not in os.environ or os.environ["HOME"] != home:
        env_issues.append(f'Please set HOME to "{home}"')

    if env_issues:
        print("-------------------------------------")
        for ei in env_issues:
            print(ei)
        print("-------------------------------------")

def main():
    parser = argparse.ArgumentParser(description='Initialize dotfiles')
    parser.add_argument('--dry', action='store_true', help='do a dry run')
    parser.add_argument('--clean', action='store_true', help='remove links')

    args = parser.parse_args()

    is_windows = platform.system() == "Windows"
    links = is_windows and windows_links or unix_links
    if is_windows:
        check_windows_env()

    operations = []
    for link in links:
        if type(link) is tuple:
            operations.append(dolink(link[0], link[1]))
        else:
            operations.append(dolink(link))

    if not args.dry:
        Path(Path.home(), ".config").mkdir(exist_ok=True)

        for op in operations:
            if op:
                op()

if __name__ == "__main__":
    main()
