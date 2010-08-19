[ -e ~/.bash_profile ] && source ~/.bash_profile

# ~/.bashrc: executed by bash(1) for non-login shells.
# see /usr/share/doc/bash/examples/startup-files (in the package bash-doc)
# for examples

# If not running interactively, don't do anything
[ -z "$PS1" ] && return


# I choose ZSH!!
if which zsh &> /dev/null && ! echo $SHELL | grep -q zsh
then
    if zsh
    then
        exit
    else
        echo clean bash
        return
    fi
else
    echo Bash
fi

SHELL=`which bash`

# don't put duplicate lines in the history. See bash(1) for more options
export HISTCONTROL=ignoredups
# ... and ignore same sucessive entries.
export HISTCONTROL=ignoreboth

# no limit on histfile size, I advise using a cron job to clean the file
unset HISTFILESIZE
export HISTSIZE=10000
export PROMPT_COMMAND="history -a"

shopt -s histappend

export EDITOR=vim
export PAGER=less

# check the window size after each command and, if necessary,
# update the values of LINES and COLUMNS.
shopt -s checkwinsize

# make less more friendly for non-text input files, see lesspipe(1)
[ -x /usr/bin/lesspipe ] && eval "$(lesspipe)"

# set variable identifying the chroot you work in (used in the prompt below)
#if [ -z "$debian_chroot" ] && [ -r /etc/debian_chroot ]; then
#    debian_chroot=$(cat /etc/debian_chroot)
#fi

# set a fancy prompt (non-color, unless we know we "want" color)

# Comment in the above and uncomment this below for a color prompt
#PS1='${debian_chroot:+($debian_chroot)}\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '

# deal with stupid hostnames
hostname=`hostname`
hostname=`echo "$hostname" | sed 's/\.acadiau\.ca//'`

# get host and set color
if [ `id -u` -eq 0 ]; then
        Color='\[\033[1;31m\]'  # red background for root
else
        case "$hostname" in
                razz )
                        Color='\[\033[0;36m\]'
                ;;
                jazz )
                        Color='\[\033[01;32m\]'
                ;;
                # Acadia computers
                dyna174* )
                        Color='\[\033[01;32m\]'
                        ;;
                * )
		    # red for unknown host
                        Color='\[\033[1;31m\]'
                ;;
        esac
fi

if [ -n "$SSH_TTY" ]
then
    psprepend="ssh-"
fi

PROMPT_COMMAND="$PROMPT_COMMAND;"'DIR=`pwd|sed -e "s!$HOME!~!"`; if [ ${#DIR} -gt 20 ]; then CurDir=`echo $DIR | sed -e "s!\([^/]\{1,2\}\)[^/]*/!\1/!g"`; else CurDir=$DIR; fi'

PS1="${Color}$psprepend$hostname:\[\033[00m\]\$CurDir\$ "


# If this is an xterm set the title to user@host:dir
case "$TERM" in
xterm*|rxvt*)
    PROMPT_COMMAND="$PROMPT_COMMAND;"'echo -ne "\033]0;${USER}@${HOSTNAME}: ${PWD/$HOME/~}\007"'
    ;;
*)
    ;;
esac


if [ "$scr" == script ]
then
    PS1='\$'
    PROMPT_COMMAND=
fi

# catch failures
#catch_failure()
#{
    #pt=$?
    #if [[ "$pt" != 0 ]]
    #then
	#hist=`history 1 | sed -e "s/^ *[0-9]* *//"`
	#failure="`history 1 | sed -e "s/^ *\([0-9]*\) *.*/\1/"`"
	#[[ "$failure" = "$LAST_FAILURE" ]] && return
	#export LAST_FAILURE=$failure
	#echo -e "\033[1;31m'$hist' Failed ($pt)"
    #fi
#}

#PROMPT_COMMAND='catch_failure'";$PROMPT_COMMAND"


# alias for dev/null
bind '"\C-n": " > /dev/null"'

# cycle tab completes
bind '"\C-t": menu-complete'

# check history file
max_hist_lines=`[ -n $HISTSIZE ] && echo $HISTSIZE || echo 10000`
hist_line_count=$(wc -l < ~/.bash_history)

if (($hist_line_count > $max_hist_lines)); then
    echo "History file is getting big!"
fi

# Alias definitions.
# You may want to put all your additions into a separate file like
# ~/.bash_aliases, instead of adding them here directly.
# See /usr/share/doc/bash-doc/examples in the bash-doc package.

if [ -f ~/.bash_aliases ]; then
    . ~/.bash_aliases
fi


export PATH=$PATH:.:$HOME/bin
[ -e /opt/local/bin ] && export PATH=$PATH:/opt/local/bin
[ -e /usr/local/bin ] && export PATH=/usr/local/bin:$PATH
[ -e $HOME/.cabal/bin ] && export PATH=$HOME/.cabal/bin:$PATH
export PATH=/var/lib/gems/1.8/bin:$PATH
export PATH=$PATH:/usr/local/git/bin
export PATH=/opt/subversion/bin:$PATH

export NXJ_HOME=/home/rwooden/src/lejos_nxj
export PATH=$PATH:$NXJ_HOME/bin
export LD_LIBRARY_PATH=$NXJ_HOME/bin

# enable programmable completion features (you don't need to enable
# this, if it's already enabled in /etc/bash.bashrc and /etc/profile
# sources /etc/bash.bashrc).
if [ -f /etc/bash_completion ]; then
    . /etc/bash_completion
fi

if [ -f /opt/local/etc/bash_completion ]; then
    . /opt/local/etc/bash_completion
fi

# screen stuff
if [[ "$TERM" = "screen" ]]
then
    export PS1='\[\033k\033\\\]'"$PS1"
fi
