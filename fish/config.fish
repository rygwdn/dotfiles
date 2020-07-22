if not functions -q fisher
    set -q XDG_CONFIG_HOME; or set XDG_CONFIG_HOME ~/.config
    curl https://git.io/fisher --create-dirs -sLo $XDG_CONFIG_HOME/fish/functions/fisher.fish
    fish -c fisher
end


abbr ll ls -l
abbr la ls -A

# abbr h "history search --reverse | grep"

abbr st gite st
abbr ci gite commit
abbr co gite checkout
abbr gd git diff
abbr gdc git diff --cached
abbr gmt git mergetool
abbr br git branch
abbr show git show
abbr rb git rebase
abbr rbc git rebase --continue
abbr rbe gite rebase
abbr rbi git rbi
abbr rbie gite rbi

abbr fugitive vim -c "Ge :"
abbr fu vim -c "Ge :"

abbr po gite push origin
abbr pof gite push origin --force-with-lease
abbr gph gite push origin --set-upstream HEAD

abbr wip git wip
abbr unwip git unwip

abbr rg rg -S
abbr prl pr -l

abbr yt "youtube-dl --no-mtime --ignore-config --recode-video=mp4 --no-playlist --format=best"

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
