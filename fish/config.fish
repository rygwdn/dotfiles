# if not functions fisher
#     set -q XDG_CONFIG_HOME; or set XDG_CONFIG_HOME ~/.config
#     curl -sL https://git.io/fisher | source && fisher install jorgebucaran/fisher
#     fisher update
# end
#

# Disable default greeting
set -g fish_greeting

abbr ll ls -l
abbr la ls -A

function _is_gt
    set -l git_root (git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo '/dev/null')
    test "$git_root" != /dev/null && test -f "$git_root/.graphite_repo_config"
end

function _abbr_if_gt -a abbr gt git
    if which gt &>/dev/null
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
_abbr_if_gt pff 'gt sync --no-restack  --no-interactive && git merge --ff-only' 'git pull --ff-only'
_abbr_if_gt gfu 'gt sync --no-restack --no-interactive' 'git fetch --prune --tags origin'
_abbr_if_gt pof '' 'git push origin --force-with-lease'
_abbr_if_gt gph '' 'git push origin --set-upstream HEAD'
_abbr_if_gt rbc '' 'git rebase --continue'
_abbr_if_gt rbi '' 'git rbi'

if status is-interactive && which world-nav &>/dev/null
    world-nav shell-init --shell fish --require-version ~/dotfiles/world-nav/Cargo.toml | source
end

abbr st git st
abbr gd git diff
abbr gdc git diff --cached
abbr gmt git mergetool
abbr br git branch
abbr show git show
abbr "c." code .

abbr rg rg -S

abbr mdf cd ~/dotfiles

set -U __done_exclude '(git (?!push|pull)|vim)'

fish_add_path -m \
    ~/bin \
    ~/.bin \
    ~/dotfiles/bin \
    ~/.local/bin \
    /opt/homebrew/opt/rustup/bin \
    ~/.cabal/bin \
    ~/.cargo/bin \
    ~/.rvm/bin \
    ~/go/bin \
    /usr/local/sbin \
    /usr/local/bin \
    /opt/local/bin \
    /opt/homebrew/bin \
    /opt/homebrew/opt/ruby/bin \
    /opt/homebrew/opt/fish/bin \
    /opt/homebrew/opt/starship/bin \
    ~/.fzf/bin \
    ~/.poetry/bin

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

set -x SHELL (which fish)
set -x STARSHIP_SHELL fish

if test -n "$COMPOSER_NO_INTERACTION" || ! status is-interactive
    set -x FISH_NOT_INTERACTIVE 1

    set -x PAGER cat
    set -x GIT_PAGER cat
    set -x GH_PAGER cat
    set -x GH_PROMPT_DISABLED true
    set -x DEV_NO_AUTO_UPDATE 1
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
else
    set -x STARSHIP_CONFIG "$HOME/dotfiles/starship.toml"
    set -g fish_transient_prompt 1
end
