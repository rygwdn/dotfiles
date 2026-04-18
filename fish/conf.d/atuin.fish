# Skip in non-interactive shells (coding agents don't need atuin keybindings)
status is-interactive || exit 0
command -q atuin || exit 0

# Cache atuin shell integration (saves ~10ms fork/exec per startup)
set -l atuin_cache ~/.cache/fish/atuin-init.fish
set -l atuin_bin (command -s atuin)
if not test -f $atuin_cache; or test $atuin_bin -nt $atuin_cache
    mkdir -p ~/.cache/fish
    atuin init fish > $atuin_cache
end
source $atuin_cache
