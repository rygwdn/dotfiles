#! /bin/zsh

autoload -U compinit

[ -z $HOST ] && export HOST=`hostname`

zsh_cache=${HOME}/tmp/.zsh/cache
mkdir -p $zsh_cache

if [ $UID -eq 0 ]; then
    compinit
else
    compinit -d $zsh_cache
fi

find ~/.zsh/conf.d -type f \
    -not -iname '*.zwc' -and \
    -not -iname '*~' -and \
    -not -iname '*.old' \
    | sort \
    | while read snipplet
do
    source $snipplet
done


