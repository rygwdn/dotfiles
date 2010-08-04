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


sp(){
    smplayer "$@" &
}


alias ll='ls -l'
alias la='ls -A'
alias l='ls -CF'
alias d='cd'
alias psa='ps aux | grep -v grep | grep -e "^USER" -e '
alias h='cat ~/.*history* | grep'
alias cl='rm *~'
alias work='. work'
alias recup='sudo /etc/init.d/cupsys restart'
alias pp='popd'
alias pd='pushd'
alias nnice='ionice -c2 -n7 nice -n10'
alias cmmi='./configure && make && sudo make install'
alias tt='sudo atop -r /var/log/atop.log'
alias ap='sudo aptitude'
alias up='my-net up && echo Yes || echo No'
alias qmv='\qmv -f destination-only'
alias upnup='ap update && ap full-upgrade'
alias ack='ack-grep'
alias ak='ack -a'

alias g='&> /dev/null gvim'
alias gr='g --remote-silent'
alias gs='g --servername'
alias grs='gr --servername'

alias db2s='sudo su db2inst2 -c bash'

alias dirs='dirs -v'

# temp hack
alias media='sshfs wired:media ~/tmp/mnt ; cd ~/tmp/mnt'

[[ `hostname` != "razz" ]] && alias r='ssh razz'


function media()
{
    gt=$1
    [[ -z $gt ]] && gt=wired
    mount ~/mnt/$gt
    cd ~/mnt/$gt
}

function xr()
{
    to=-1
    [[ "$1" == "2" ]] && to=0
    [[ "$1" == "1" ]] && to=1
    [[ $to < 0 ]] && echo "failed" && return 1
    xrandr -s $to && ( kr avant-window-navigator &> /dev/null )
}


function vcs()
{
    if [ -e .svn ]
    then
        svn "$@"
    else
        prog=`(
            while [ $(pwd) != $HOME ] && [ $(pwd) != '/' ]
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
alias dci='git svn dcommit'
alias rb='git svn rebase'
alias gd='git diff'
alias gdc='git diff --cached'
alias gl='git lg | head -n $(expr $LINES - 2)'


# pull examples from shell-fu
function examples { lynx -width=$COLUMNS -nonumbers -dump "http://www.shell-fu.org/lister.php?tag=$1" | \
sed -n '/^[a-zA-Z]/,$p' | egrep -v '^http|^javas|View Comm|HIDE|] \+|to Share|^ +\*|^ +[HV][a-z]* l|^ .*efu.*ep.*!$' | \
sed -e '/^  *__*/N;s/\n$//g' | less -r; }

# annoyances
alias c='cd'
alias d='cd'
alias dpgk='dpkg'

# share current tree over the web - http://www.shell-fu.org/lister.php?id=54
function webshare()
{
    if [ x$1 = x ]
    then
        port=8080
    elif expr "1 + $1" &> /dev/null
    then
        port=$1
    else
        echo "Invalid port"
        return 1
    fi

    echo "Serve on:"
    ifconfig | grep -o "inet addr:[^ ]*" | grep -v ":127" | sed "s/inet addr://;s/$/:$port/"
    echo "Ctrl-C to quit"
    python -m SimpleHTTPServer $port
}

alias webserve='webshare'

alias md='mkdir -p'
alias rd=rmdir
alias ..='cd ..'
alias ...='cd ../..'


function rr ()
{
    sudo dhclient -r $@
    sudo dhclient $@
}

# better gnome open command
alias o=`
for op in open gnome-open; do
    which $op &>/dev/null && echo $op
done | tail -n 1`

alias here='ack "TODO[: ]*here"'

alias gvo="vo -g"

complete -F _aptitude -o default ap
complete -F _svn -o default -X '@(*/.svn|*/.svn/|.svn|.svn/)' s

# completion stuff
_tnote()
{
    local cur prev opts notes
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    opts="-h --help -e --editor -g --gvim -v --view -l --list -x --xml -c --create"
    notes="`tnote --list | sed "s/ /\ /;"`"

    COMPREPLY=( $(compgen -W "${opts} ${notes}" -- ${cur}) )
    return 0
}
complete -F _tnote tnote
