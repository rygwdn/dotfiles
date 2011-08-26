#!/bin/bash

if test "$1" = "win" || test "$OS" = "Windows_NT"
then
    win="true"
else
    win="false"
fi

mklink() { cmd /c mklink "$@"; }

function dolink()
{
    file=$1
    hf=$HOME/.`basename $file`
    if $win
    then
        [ $file = "vim" ] && hf=$HOME/vimfiles
        [ $file = "vim/vimrc" ] && file="vim/_vimrc" && hf=$HOME/_vimrc
    fi

    tf=`readlink -f $file`
    [ "`readlink -f $hf`" = "$tf" ] && echo "$file" already linked && return

    if [ -e $hf ]
    then
        echo $hf exists 1>&2
    elif $win
    then
        tf=`cygpath -w $tf`
        hf=`cygpath -w $hf`
        echo "mklink $tf -> $hf"
        [ -d $hf ] && mklink \d $hf $tf || mklink $hf $tf
    else
        echo "link $tf -> $hf"
        ln -s $tf $hf
    fi
}
    

for lfile in * */bash_aliases
do
    if [ $lfile != "init.sh" ]
    then
        dolink $lfile
    fi
    if [ -e $lfile/"$lfile"rc ]
    then
        dolink $lfile/"$lfile"rc
    fi
done
