fpath+=(${0:A:h})

autoload h
autoload setup_macos

autoload _git-fixup
compdef _git-fixup git-fixup

path+=("$HOME/dotfiles/bin")

# Keys {{{ 

# Keep keys in here so that zsh-vi-mode doesn't overwrite them

# Allow Alt+N+. to pick the N-to-last argument
bindkey '^[1' digit-argument
bindkey '^[2' digit-argument
bindkey '^[3' digit-argument
bindkey '^[4' digit-argument
bindkey '^[5' digit-argument
bindkey '^[6' digit-argument
bindkey '^[7' digit-argument
bindkey '^[8' digit-argument
bindkey '^[9' digit-argument
bindkey '^[.' insert-last-word

bindkey '^A' beginning-of-line
bindkey '^[OH' beginning-of-line
bindkey '^[[1~' beginning-of-line

bindkey '^E' end-of-line
bindkey '^[OF' end-of-line
bindkey '^[[4~' end-of-line

bindkey '<M-b>' backward-word
bindkey '<M-f>' forward-word

# Alt-Comma to copy earlier arguments after Alt-Dot
autoload -U copy-earlier-word
zle -N copy-earlier-word
bindkey '^[,' copy-earlier-word

# Ctrl-O to stash the current line
bindkey '^o' push-line

# }}}
# Aliases {{{ 

alias st='git status'
alias ci='git commit'
alias co='git checkout'
alias gd='git diff'
alias gdc='git diff --cached'
alias gmt='git mergetool'
alias br='git branch'
alias show='git show'
alias rb='git rebase'
alias rbc='git rebase --continue'
alias rbi='git rebase -i --autosquash'
alias rbim='git rebase -i --autosquash origin/main'
alias fup='git fixup'
alias f='git fixup'
alias fa='git fixup --amend'
alias af='git add . && git fixup'
alias afa='git add . && git fixup --amend'

alias pff='git pull --ff-only'
alias pnf='git pull --no-ff'

alias mff='git merge --ff-only'
alias mnf='git merge --no-ff'

alias po='git push origin'
alias pof='git push origin --force-with-lease'
alias gph='git push origin --set-upstream HEAD'

alias ga='git add'
alias gap='git add --patch'

alias gfu='git fetch origin'
alias gfo='git fetch origin'

alias pr='gh pr create --web'

alias rg='rg -S'
alias prl='pr -l'

alias stfu="osascript -e 'set volume output muted true'"
alias flushdns="dscacheutil -flushcache"

alias vw="nvim +VimwikiIndex +'lcd %:p:h'"

alias tm='tmux new-session -A'

# }}}

# vim:foldmethod=marker:foldlevel=0:
