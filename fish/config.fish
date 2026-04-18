# if not functions fisher
#     set -q XDG_CONFIG_HOME; or set XDG_CONFIG_HOME ~/.config
#     curl -sL https://git.io/fisher | source && fisher install jorgebucaran/fisher
#     fisher update
# end
#

# Disable default greeting
set -g fish_greeting

# Configure path
fish_add_path -gm \
    ~/bin \
    ~/.bin \
    ~/dotfiles/bin \
    ~/.local/bin \
    ~/.dev/userprofile/bin/ \
    /opt/homebrew/opt/rustup/bin \
    ~/.cabal/bin \
    ~/.cargo/bin \
    ~/.rvm/bin \
    ~/.deno/bin \
    ~/go/bin \
    /usr/local/sbin \
    /usr/local/bin \
    /opt/local/bin \
    /opt/homebrew/bin \
    /opt/homebrew/opt/fish/bin \
    /opt/homebrew/opt/starship/bin \
    ~/.fzf/bin \
    ~/.poetry/bin \
    ~/.local/bin \
    /Applications/Obsidian.app/Contents/MacOS


function _is_gt
    set -l git_root (git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo '/dev/null')
    test "$git_root" != /dev/null && test -f "$git_root/.graphite_repo_config"
end

# Check for gt once, not per-abbreviation (saves ~24ms of `which` spawns)
if command -q gt
    set -g __has_gt 1
end

function _abbr_if_gt -a abbr gt git
    if test "$__has_gt" = 1
        eval "$(
    echo "function _abbr_$abbr"
    echo "  _is_gt && echo '$gt' || echo '$git'"
    echo "end"
    echo "abbr $abbr -f _abbr_$abbr"
  )"
    else
        abbr $abbr $git
    end
end

_abbr_if_gt co 'gt checkout' 'git checkout'
_abbr_if_gt ci 'gt modify --commit' 'git commit'
_abbr_if_gt pff 'gt sync --no-restack  --no-interactive' 'git pull --ff-only'
_abbr_if_gt gfu 'gt sync --no-restack --no-interactive' 'git fetch --prune --tags origin'
_abbr_if_gt pof '' 'git push origin --force-with-lease'
_abbr_if_gt gph 'gt submit' 'git push origin --set-upstream HEAD'
_abbr_if_gt gs 'gt submit' 'git push origin --set-upstream HEAD'
_abbr_if_gt gss 'gt submit --stack --update-only' ''
_abbr_if_gt po 'gt submit' 'git push origin --set-upstream HEAD'
_abbr_if_gt rbc 'gt continue' 'git rebase --continue'
_abbr_if_gt rbi '' 'git rbi'
_abbr_if_gt gls 'gt log --stack' 'git log'
_abbr_if_gt glss 'gt log short --stack' 'git log --oneline'
_abbr_if_gt rs 'gt restack' 'rs'
_abbr_if_gt frs 'gt sync --no-restack --no-interactive && gt restack' 'git pull --rebase'
_abbr_if_gt gm 'gt modify' 'git commit --amend --no-edit'

# Clean up setup-only globals
set -e __has_gt

abbr ll ls -l
abbr la ls -A
abbr st git st
abbr gd git diff
abbr gdc git diff --cached
abbr gmt git mergetool
abbr br git branch
abbr show git show
abbr "c." code .

abbr rg rg -S

abbr mdf cd ~/dotfiles

if status is-interactive
    if not command -q jumpr
        echo "jumpr not found, installing..."
        curl -fsSL https://raw.githubusercontent.com/rygwdn/jump/main/get-jumpr.sh | sh -s -- --install-dir "$HOME/.local/bin"
    end
    if command -q jumpr
        # Cache jumpr shell integration (saves ~10ms fork/exec per startup)
        set -l jumpr_cache ~/.cache/fish/jumpr-init.fish
        set -l jumpr_bin (command -s jumpr)
        if not test -f $jumpr_cache; or test $jumpr_bin -nt $jumpr_cache
            mkdir -p ~/.cache/fish
            jumpr shell-init --shell fish > $jumpr_cache
        end
        source $jumpr_cache
    end
end

set -U __done_exclude '(git (?!push|pull)|vim)'

set -x EDITOR vim
set -x VISUAL vim
set -x VPAGER 'vim -R -'

# Set up less
set -x PAGER less
# show colors in less
set -x LESS -R

# locale stuff
set -x LC_ALL 'en_US.UTF-8'
set -x LANG 'en_US.UTF-8'
set -x LC_CTYPE C

set fish_vi_force_cursor 1
set fish_cursor_default block
set fish_cursor_insert line
set fish_cursor_replace_one underscore

set -x SHELL (status fish-path)
set -x STARSHIP_SHELL 'sh'

if test -n "$COMPOSER_NO_INTERACTION" || ! status is-interactive
    set -x FISH_NOT_INTERACTIVE 1

    set -x PAGER cat
    set -x GIT_PAGER cat
    set -x GH_PAGER cat
    set -x GH_PROMPT_DISABLED true
end

if test "$TERM_PROGRAM" = vscode || test -n "$FISH_NOT_INTERACTIVE"
    set -x FISH_SIMPLE_TERM 1
end

# Suppress OSC 10/11 responses that leak in tmux+vscode
if test "$TERM_PROGRAM" = vscode && set -q TMUX
    printf '\e]10;?\e\\'
    printf '\e]11;?\e\\'
end

if test -n "$FISH_SIMPLE_TERM"
    set -x STARSHIP_CONFIG "$HOME/dotfiles/starship-simple.toml"
    # Disable OSC 133 prompt markers in simple terminals (fish 4.x)
    set -g fish_features no-mark-prompt
else
    set -x STARSHIP_CONFIG "$HOME/dotfiles/starship.toml"
    set -g fish_transient_prompt 1
end

# bun
set --export BUN_INSTALL "$HOME/.bun"
set --export PATH $BUN_INSTALL/bin $PATH
