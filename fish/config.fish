if not functions -q fisher
    set -q XDG_CONFIG_HOME; or set XDG_CONFIG_HOME ~/.config
    curl https://git.io/fisher --create-dirs -sLo $XDG_CONFIG_HOME/fish/functions/fisher.fish
    fish -c fisher
end

if type -q powershell.exe
    set -U __done_notification_command 'powershell.exe -command New-BurntToastNotification -Text WSL-ok'
end

abbr co git checkout
abbr st git st

abbr ll ls -l
abbr la ls -A

abbr ci git commit
abbr co git checkout
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


abbr po gite push origin
abbr pof po --force-with-lease
abbr gph po --set-upstream HEAD

abbr wip git wip
abbr unwip git unwip

abbr rg rg -S
abbr prl pr -l

