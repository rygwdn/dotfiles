# if not functions fisher
#     set -q XDG_CONFIG_HOME; or set XDG_CONFIG_HOME ~/.config
#     curl -sL https://git.io/fisher | source && fisher install jorgebucaran/fisher
#     fisher update
# end
#
abbr ll ls -l
abbr la ls -A

# abbr h "history search --reverse | grep"

abbr st git st
abbr ci git commit
abbr co git checkout
abbr gd git diff
abbr gdc git diff --cached
abbr gmt git mergetool
abbr br git branch
abbr show git show
abbr rb git rebase
abbr rbc git rebase --continue
abbr rbi git rbi

abbr pff git pull --ff-only
abbr pnf git pull --no-ff

abbr mff git merge --ff-only
abbr mnf git merge --no-ff

abbr fugitive vim -c "Ge :"
abbr fu vim -c "Ge :"

abbr po git push origin
abbr pof git push origin --force-with-lease
abbr gph git push origin --set-upstream HEAD

abbr wip git wip
abbr unwip git unwip

abbr rg rg -S
abbr prl pr -l

set -U __done_exclude '(git (?!push|pull)|vim)'

fish_add_path \
    ~/bin \
    ~/.bin \
    ~/dotfiles/bin \
    ~/.local/bin \
    ~/.cabal/bin \
    ~/.cargo/bin \
    ~/.rvm/bin \
    /usr/local/sbin \
    /usr/local/bin \
    /opt/local/bin \
    ~/.fzf/bin \
    ~/.poetry/bin

set -x EDITOR vim
set -x VISUAL vim
set -x VPAGER 'vim -R -'

# Set up less
set -x PAGER less
# show colors in less
set -x LESS -R

# local stuff
set -x LC_ALL 'en_US.UTF-8'
set -x LANG 'en_US.UTF-8'
set -x LC_CTYPE C

set fish_vi_force_cursor 1
set fish_cursor_default block
set fish_cursor_insert line
set fish_cursor_replace_one underscore
#fish_vi_cursor 

if which zoxide &>/dev/null
    zoxide init fish | source
end

function starship_transient_rprompt_func
    starship module time
end

if which starship &>/dev/null
    starship init fish | source
    enable_transience
end

set -U async_prompt_functions fish_right_prompt

function fish_right_prompt_loading_indicator -a last_prompt
    echo -n "$last_prompt" | sed -r 's/\x1B\[[0-9;]*[JKmsu]//g' | read -zl uncolored_last_prompt
    echo -n (set_color brblack)"$uncolored_last_prompt"(set_color normal)
end
