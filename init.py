#!/usr/bin/env python3

import argparse
import platform
from pathlib import Path

all_platforms = [
    "bashrc",
    "bin",
    "gitconfig",
    "zsh",
    "zshenv",
    "zsh/zshrc",
    "zsh/bash_aliases",
    "ripgreprc",
    ("fish", ".config/fish"),
]

windows_links = all_platforms + [
    ("tridactylrc", "_tridactylrc"),
    ("vim", "vimfiles"),
    ("vim/_vimrc",  "_vimrc"),
    ("windows/profile.ps1",  "Documents/WindowsPowerShell/profile.ps1"),
]

unix_links = all_platforms + [
    "vim",
    "vim/vimrc",
    "flexget",
    "tmux.conf",
    "tridactylrc",
]

def dolink(file, destname=None):
    src = Path(file).resolve()
    dest = Path(Path.home(), destname or "." + src.name).resolve()

    destname = "~/" + (destname or str(dest.relative_to(Path.home())))
    srcname = src.relative_to(Path.cwd())

    if not src.exists():
        raise Exception(f"{src} does not exist!")

    if src.exists() and dest.exists() and src.samefile(dest):
        print(f"✔ {srcname}")
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

def main():
    parser = argparse.ArgumentParser(description='Initialize dotfiles')
    parser.add_argument('--dry', action='store_true', help='do a dry run')
    parser.add_argument('--clean', action='store_true', help='remove links')

    args = parser.parse_args()

    is_windows = platform.system() == "Windows"
    links = is_windows and windows_links or unix_links

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
