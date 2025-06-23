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

function config_gt_abbrs --on-variable PWD
    set -l git_root (git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo '/dev/null')

    if which gt &>/dev/null && test "$git_root" != /dev/null && test -f "$git_root/.graphite_repo_config"
        abbr gfu gt sync --no-restack
        abbr co gt checkout
        abbr ci gt modify --commit
        abbr pff git pull --ff-only
    else
        if test "$git_root" = /dev/null || git config --list 2>/dev/null | grep -q '^remote\.upstream\.'
            abbr gfu git fetch --prune --tags upstream
        else
            abbr gfu git fetch --prune --tags origin
        end

        abbr co git checkout
        abbr ci git commit
        abbr pff git pull --ff-only

        # disable these abbrs when running with graphite to avoid accidentially breaking stuff with muscle memory
        abbr pof git push origin --force-with-lease
        abbr gph git push origin --set-upstream HEAD
        abbr rbc git rebase --continue
        abbr rbi git rbi
    end
end

config_gt_abbrs

function update_path_segments --on-variable PWD
    if which shortpath &>/dev/null
        set -l segments (shortpath -s prefix,shortened,normal "$PWD")

        set -g STARSHIP_PATH_PREFIX $segments[1]
        set -g STARSHIP_PATH_SHORTENED $segments[2]
        set -g STARSHIP_PATH_NORMAL $segments[3]
    else
        set -g STARSHIP_PATH_PREFIX ""
        set -g STARSHIP_PATH_SHORTENED ""
        set -g STARSHIP_PATH_NORMAL (prompt_pwd -d 1 -D 1)
    end
end

update_path_segments

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

fish_add_path \
    ~/bin \
    ~/.bin \
    ~/dotfiles/bin \
    ~/.local/bin \
    ~/.cabal/bin \
    ~/.cargo/bin \
    ~/.rvm/bin \
    ~/go/bin \
    /usr/local/sbin \
    /usr/local/bin \
    /opt/local/bin \
    /opt/homebrew/bin \
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

set -x STARSHIP_CONFIG "$HOME/dotfiles/starship.toml"

if which starship &>/dev/null
    if test -n "$FISH_SIMPLE_TERM"
        # For FISH_SIMPLE_TERM, use simple prompt without rprompt, async, or transient
        set -x STARSHIP_CONFIG "$HOME/dotfiles/starship-simple.toml"
    else
        # Full starship with all features
        enable_transience
    end
end

if which zoxide &>/dev/null
    zoxide init fish --hook prompt | source
end

if which worktree-nav &>/dev/null
    worktree-nav --shell fish --init-navigate j --init-code jc | source
end

test -e ~/.config.local.fish && source ~/.config.local.fish
