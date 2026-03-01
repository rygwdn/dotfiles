# If not running interactively, don't do anything
[[ -z "$PS1" ]] && return

if [[ -e ~/.bash_profile && -z "$SOURCED_PROFILE" ]]
then
    export SOURCED_PROFILE=1
    source ~/.bash_profile
fi

export HISTCONTROL=ignoredups
export HISTCONTROL=ignoreboth

unset HISTFILESIZE
export HISTSIZE=10000

shopt -s histappend

export EDITOR=vim
export PAGER=less

[[ -x /opt/homebrew/bin/brew ]] && eval $(/opt/homebrew/bin/brew shellenv)
