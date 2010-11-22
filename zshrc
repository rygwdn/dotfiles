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

for snipplet in `find ~/.zsh/conf.d -type f \
    -name 'S*' -and \
    -not -iname '*.zwc' -and \
    -not -iname '*~' -and \
    -not -iname '*.old' \
    | sort`
do
    source $snipplet
done


