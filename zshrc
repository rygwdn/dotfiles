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

setopt extended_glob
for zshrc_snipplet in ~/.zsh/conf.d/S[0-9][0-9]*[^~][^.zwc][^.old]
do
    source $zshrc_snipplet
done


