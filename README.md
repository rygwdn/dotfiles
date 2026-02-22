dotfiles
========

my dot files

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/rygwdn/dotfiles/master/init.py | python3
```

This clones the repo to `~/dotfiles` (or pulls if it already exists) and symlinks everything.

To preview what would be linked without making changes:

```sh
python3 ~/dotfiles/init.py --dry
```
