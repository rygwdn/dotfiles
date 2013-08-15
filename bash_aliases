#!/bin/bash

# Set up ls
RUNNING_IN_WINDOWS=false
if [[ "$TERM" != "dumb" ]]; then
    if [[ "$TERM" == "cygwin" || "$CYGWIN" == "true" || -n "$MSYSTEM" ]]
    then
        alias ls='ls --color'
        export LS_COLORS=
        RUNNING_IN_WINDOWS=true
    elif which dircolors &> /dev/null
    then
        eval "$(dircolors -b)"
        alias ls='ls --color=auto'
    elif uname -s | grep -iq "Darwin"
    then
        alias ls='ls -G'
    fi
fi

alias cherokee="ssh linode -L 9090:localhost:9090 -t -C 'sudo killall cherokee-admin; sudo cherokee-admin -b'"
alias psa='ps aux | grep -v grep | grep -e "^USER" -e '


alias ll='ls -l'
alias la='ls -A'
alias l='ls -CF'
alias h="([ '$(basename $SHELL)' = 'zsh' ] && fc -l 0 || history) | grep"
alias pp='popd'
alias pd='pushd'
alias ap='sudo aptitude'
alias qmv='\qmv -f destination-only'
alias upnup='ap update && ap full-upgrade'
which ack-grep 1>/dev/null 2>/dev/null && alias ack='ack-grep'

function g {
    if $RUNNING_IN_WINDOWS; then
        ( /dev/null gvim --fork=1 ) &>/dev/null
    else
        ( gvim -f "$@" & ) &>/dev/null
    fi
}
function gmod {
    local _path=$(git rev-parse --show-toplevel || pwd)
    local _files=
    # changed files
    #echo "1: $1"
    [[ -z "$1" ]] && _files="$(cd $_path ; git status --porcelain | sed 's/^ *[^ ]* *//' | sort -u)"
    #echo "f1: $_files"
    # files changed in HEAD
    [[ -z $_files ]] && _files="$(cd $_path; git diff-tree --no-commit-id --name-only -r ${1:-HEAD})"
    #echo "f2: $_files"
    _files=$(echo "$_files" | sed "s!^!$_path/!" | grep -v '/images/' | while read line ; do file "$line" | grep -q '\btext\b' && echo $line ; done)
    #echo "f3: $_files"
    g $(echo "$_files" | xargs echo)
}
alias gses="g --servername"
alias gn="gses"
alias gchanged="gmod"

function vcs()
{
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
        svn "$@"
    fi
}
__define_git_completion () {
    eval "
    _git_$2_shortcut () {
        COMP_LINE=\"git $2\${COMP_LINE#$1}\"
        let COMP_POINT+=$((4+${#2}-${#1}))
        COMP_WORDS=(git $2 \"\${COMP_WORDS[@]:1}\")
        let COMP_CWORD+=1

        local cur words cword prev
        _get_comp_words_by_ref -n =: cur words cword prev
        _git_$2
    }
    "
}

__git_shortcut () {
    type _git_$2_shortcut &>/dev/null || __define_git_completion $1 $2
    alias $1="git $2 $3"
    complete -o default -o nospace -F _git_$2_shortcut $1
}

__git_shortcut ci commit
__git_shortcut co checkout
__git_shortcut a add
__git_shortcut lg lg
__git_shortcut log log
__git_shortcut add add
__git_shortcut addp add --patch
__git_shortcut addi add -i
__git_shortcut gd diff
__git_shortcut gdc diff --cached
__git_shortcut br branch
__git_shortcut show show
__git_shortcut rb rebase
__git_shortcut rbi rebase "-i --autosquash"
alias st='git st'

alias gl='lg -n-1 --all'
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
    op_prg=`for op in gnome-open open cygstart start explorer.exe
    do
        which $op &>/dev/null && echo $op && break
    done | tail -n 1`

    for file in "$@"
    do
        if [[ "$op_prg" = "explorer.exe" ]] && $CYGWIN; then
            $op_prg "`cygpath -w "$file"`"
        else
            file=`echo "$file" | sed 's/\/$//'`
            $op_prg "$file"
        fi
    done
}

complete -F _aptitude -o default ap

[ -e ~/.bash_aliases_local ] && source ~/.bash_aliases_local
