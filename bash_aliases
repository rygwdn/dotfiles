#!/bin/bash

# Set up ls
if [ "$TERM" != "dumb" ]; then
    if which dircolors &> /dev/null
    then
        eval "`dircolors -b`"
        alias ls='ls --color=auto'
    elif uname -s | grep -iq "Darwin"
    then
        alias ls='ls -G'
    fi
fi


alias cherokee="ssh linode -L 9090:localhost:9090 -t -C 'sudo killall cherokee-admin; sudo cherokee-admin -b'"
alias psa='ps aux | grep -v grep | grep -e "^USER" -e '
[[ `hostname` == "cherokee" ]] && alias screen='\screen -e x'


alias ll='ls -l'
alias la='ls -A'
alias l='ls -CF'
alias h='fc -l 0 | grep'
alias pp='popd'
alias pd='pushd'
alias ap='sudo aptitude'
alias qmv='\qmv -f destination-only'
alias upnup='ap update && ap full-upgrade'
alias ack='ack-grep'

alias g='&> /dev/null gvim'
alias gvo="vo -g"


function vcs()
{
    if [ -e .svn ]
    then
        svn "$@"
    else
        prog=`(
            while [ "$(pwd)" != "$HOME" ] && [ "$(pwd)" != '/' ]
            do
                [ -e .git ] && echo 'git' && break
                [ -e .bzr ] && echo 'bzr' && break
                [ -e .hg ] && echo 'hg' && break
                cd ..
            done
        )`
        if [[ -n $prog ]]; then
            $prog "$@"
        else
            echo "No vcs known"
        fi
    fi
}
alias ci='vcs ci'
alias co='vcs co'
alias up='vcs up'
alias st='vcs st'
alias a='vcs add'
alias lg='vcs lg'
alias log='vcs log'
alias add='vcs add'
alias addp='vcs add --patch'
alias addi='vcs add -i'

alias gd='git diff'
alias gdc='git diff --cached'
alias gl='git lg | fold -s -w $(expr $COLUMNS + 20) | head -n $(expr $LINES - 2);'
alias gk='gitk --all'


# annoyances
alias c='cd'
alias d='cd'
alias dpgk='dpkg'


alias ..='cd ..'
alias ...='cd ../..'


# better gnome open command
function o()
{
    op_prg=`for op in open gnome-open
    do
        which $op &>/dev/null && echo $op
    done | tail -n 1`

    for file in "$@"
    do
        $op_prg $file
    done
}

complete -F _aptitude -o default ap
