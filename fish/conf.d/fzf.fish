# Skip in non-interactive shells (coding agents don't need fzf keybindings)
status is-interactive || exit 0
command -q fzf && fzf --fish | source
