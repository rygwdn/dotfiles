# If not running interactively, don't do anything
[[ -z "$PS1" ]] && return

[[ -z "$TRIED_ZSH" && "${SHELL##*/}" != zsh ]] && which zsh &>/dev/null && export TRIED_ZSH=true && zsh && exit

if [[ -e ~/.bash_profile && -z "$SOURCED_PROFILE" ]]
then
    export SOURCED_PROFILE=1
    source ~/.bash_profile
fi

[[ -e /c/cygwin/bin ]] && export CYGWIN=true || CYGWIN=false

$CYGWIN && export PATH="$PATH":"/c/cygwin/bin"

SHELL=$(which bash)

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
hostname=$(hostname | sed 's/\.acadiau\.ca//;s/^CI[0-9]*$/Work/')

# get host and set color
if [ "$(id -u)" -eq 0 ]; then
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
                # Work
                CI*|Work )
                        Color='\[\033[0;36m\]'
                        #Color='\[\033[01;32m\]'
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

if type __git_ps1 >/dev/null 2>&1
then
    PS1="${Color}$psprepend$hostname:\[\033[0;32m\]\$CurDir\[\033[33m\$(__git_ps1)\033[0m\]\$ "
else
    PS1="${Color}$psprepend$hostname:\[\033[0;32m\]\$CurDir\[\033[0m\]\$ "
fi

#PS1='\[\033]0;$MSYSTEM:\w\007
#\033[32m\]\u@\h \[\033[33m\w$(__git_ps1)\033[0m\]
#$ '



# If this is an xterm set the title to user@host:dir
case "$TERM" in
xterm*|rxvt*|cygwin)
    PROMPT_COMMAND="$PROMPT_COMMAND;"'echo -ne "\033]0;${USER}@${HOSTNAME}: ${PWD/$HOME/~}\007"'
    ;;
*)
    ;;
esac


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

# Alias definitions.
# You may want to put all your additions into a separate file like
# ~/.bash_aliases, instead of adding them here directly.
# See /usr/share/doc/bash-doc/examples in the bash-doc package.

if [ -f ~/.bash_aliases ]; then
    . ~/.bash_aliases
elif [ -f ~/.zsh/bash_aliases ]; then
    . ~/.zsh/bash_aliases
elif [ -f ~/conf/zsh/bash_aliases ]; then
    . ~/conf/zsh/bash_aliases
fi



if ! echo "$PATH" | grep -q -e '/opt/subversion/bin' -e '/usr/local/git/bin' -e 'var/lib/gems'
then
    export PATH=$PATH:.:$HOME/bin
    [ -e /opt/local/bin ] && export PATH=$PATH:/opt/local/bin
    [ -e /usr/local/bin ] && export PATH=/usr/local/bin:$PATH
    [ -e "$HOME/.cabal/bin" ] && export PATH=$HOME/.cabal/bin:$PATH
    export PATH=/var/lib/gems/1.8/bin:$PATH
    export PATH=$PATH:/usr/local/git/bin
    export PATH=/opt/subversion/bin:$PATH
fi

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

# virtualenv stuff

vwpth=$(which virtualenvwrapper.sh 2>/dev/null)
[ -z $vwpth ] && vwpth=$(dirname $(which python 2>/dev/null))/Scripts/virtualenvwrapper.sh
if [ -e $vwpth ]; then
    export MSYS_HOME=`python -c "import sys; print sys.argv[1]" $(dirname $(which git))`
    export TMPDIR=$TEMP
    export WORKON_HOME="$HOME/.virtualenvs"
    source $vwpth
fi

PATH=$PATH:$HOME/.rvm/bin # Add RVM to PATH for scripting
