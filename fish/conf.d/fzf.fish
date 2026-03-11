# Skip in non-interactive shells (coding agents don't need fzf keybindings)
status is-interactive || exit 0
command -q fzf || exit 0

# Cache fzf shell integration (saves ~10ms fork/exec per startup)
set -l fzf_cache ~/.cache/fish/fzf-init.fish
set -l fzf_bin (command -s fzf)
if not test -f $fzf_cache; or test $fzf_bin -nt $fzf_cache
    mkdir -p ~/.cache/fish
    fzf --fish > $fzf_cache
end
source $fzf_cache
