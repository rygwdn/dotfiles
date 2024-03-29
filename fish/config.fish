if not functions -q fisher
    set -q XDG_CONFIG_HOME; or set XDG_CONFIG_HOME ~/.config
    curl -sL https://git.io/fisher | source && fisher install jorgebucaran/fisher
    fisher update
end


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

abbr yt "youtube-dl --no-mtime --ignore-config --recode-video=mp4 --no-playlist --format=best"
abbr yta "youtube-dl --no-mtime --ignore-config --no-playlist --format=best --extract-audio --audio-format=aac"

set -U __done_exclude '(git (?!push|pull)|vim)'

if uname -a | grep -q 'Microsoft'
    set win_home $HOME/.windows/bin
    set -x BROWSER "win-start"
    set fish_term24bit 1
end


set -x PATH \
    $HOME/bin \
    $HOME/.bin \
    $HOME/Dotfiles/bin \
    $HOME/Ryan/Dotfiles/bin \
    $win_home \
    $HOME/.local/bin \
    $HOME/Dropbox/bin \
    $HOME/conf/bin \
    $HOME/.cabal/bin \
    $HOME/.cargo/bin \
    $HOME/.rvm/bin \
    /usr/local/sbin \
    /usr/local/bin \
    /opt/local/bin \
    $HOME/.fzf/bin \
    $HOME/.poetry/bin \
    $PATH \
    /mnt/c/tools \
    /mnt/c/Program\ Files\ \(x86\)/MSBuild/14.0/Bin \
    .


set -x EDITOR 'vim'
set -x VISUAL 'vim'
set -x VPAGER 'vim -R -'

# Set up less
set -x PAGER 'less'
# show colors in less
set -x LESS "-R"

# local stuff
set -x LC_ALL 'en_US.UTF-8'
set -x LANG 'en_US.UTF-8'
set -x LC_CTYPE 'C'

# timeout after 8h
set -x LPASS_AGENT_TIMEOUT 2880


# TODO: only if mintty?
set fish_vi_force_cursor 1
set fish_cursor_default block
set fish_cursor_insert line
set fish_cursor_replace_one underscore
#fish_vi_cursor 

if which docker-compose.exe &>/dev/null
    abbr dc docker-compose.exe
else if which docker-compose &> /dev/null
    abbr dc docker-compose
end

if which docker.exe &>/dev/null
    abbr d docker.exe
else if which docker &>/dev/null
    abbr d docker
end

if which powershell.exe &>/dev/null
    abbr psh powershell.exe
    abbr apsh powershell.exe Start-Process powershell -Verb runas
else if which powershell &>/dev/null
    abbr psh powershell
end

# Generated for envman. Do not edit.
test -s "$HOME/.config/envman/load.fish"; and source "$HOME/.config/envman/load.fish"

if which zoxide &>/dev/null
    zoxide init fish | source
end
