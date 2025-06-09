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

if which gt &>/dev/null
    abbr co gt checkout
    abbr ci gt modify --commit
    abbr pff git pull --ff-only
else
    abbr co git checkout
    abbr ci git commit
    abbr pff git pull --ff-only

    # disable these abbrs when running with graphite to avoid accidentially breaking stuff with muscle memory
    abbr pof git push origin --force-with-lease
    abbr gph git push origin --set-upstream HEAD
    abbr rbc git rebase --continue
    abbr rbi git rbi
end

abbr st git st
abbr gd git diff
abbr gdc git diff --cached
abbr gmt git mergetool
abbr br git branch
abbr show git show

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
end

if test "$TERM_PROGRAM" = vscode || test -n "$FISH_NOT_INTERACTIVE"
    set -x FISH_SIMPLE_TERM 1
end

set -x STARSHIP_CONFIG "$HOME/dotfiles/starship.toml"

if which starship &>/dev/null && test -z $FISH_SIMPLE_TERM
    starship init fish | source
    enable_transience

    set -U async_prompt_functions fish_right_prompt
    set async_prompt_inherit_variables all
end

function fish_right_prompt_loading_indicator -a last_prompt
    echo -n "$last_prompt" | sed -r 's/\x1B\[[0-9;]*[JKmsu]//g' | read -zl uncolored_last_prompt
    echo -n (set_color brblack)"$uncolored_last_prompt"(set_color normal)
end

if which zoxide &>/dev/null
    zoxide init fish --cmd j --hook prompt | source
end

test -e ~/.config.local.fish && source ~/.config.local.fish
