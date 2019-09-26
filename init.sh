#!/bin/bash

set -e

if test "$1" = "-c"
then
    clean=true
    shift
else
    clean=false
fi

if test "$1" = "cp"
then
    copy=true
    shift
else
    copy=false
fi

if test "$1" = "win" || test "$OS" = "Windows_NT"
then
    win="true"
else
    win="false"
fi

abspath() { cd "`dirname \"$1\"`" ; echo -n "`pwd`/" ; basename "$1" ; }

rl() {
    out=$(
        if test `uname` = "Darwin"
        then
            readlink "$1"
        else
            readlink -f "$1"
        fi
    )
    if [ -z "$out" ]
    then
        abspath "$1"
    else
        abspath "$out"
    fi
}

function dolink()
{
    file=$1
    [ -n "$2" ] && hf="$2" || hf=$HOME/.`basename $file`
    if $win
    then
        [ $file = "vim" ] && hf="$HOME/vimfiles"
        [ $file = "vim/vimrc" ] && file="vim/_vimrc" && hf="$HOME/_vimrc"
    fi

    tf=`rl "$file"`
    hl=`rl "$hf"`

    prn() {
        echo -n "`basename \"$file\" | sed -e :a -e 's/^.\{1,15\}$/& /;ta'`"
        echo "$@"
    }

    if [ "$hl" = "$tf" ]
    then
        if $clean
        then
            prn clean up linked
            rm $hf
        else
            prn "do nothing"
            return
        fi
    elif [ -e "$hf" ]
    then
        prn non-link file exists
    elif [ ! -e "$hf" -a "$hf" != "$hl" ]
    then
        if $clean
        then
            prn "removing broken link: $hf <-"
            rm $hf
        else
            prn "apparently broken link: $hf -> $hl (-c to delete)"
        fi
    elif $clean
    then
        prn "ignoring (clean)"
    elif $copy
    then
        prn "copy -> $hf"
        cp -r "$tf" "$hf"
    else
        prn "link -> $hf"
        ln -s "$tf" "$hf"
    fi
}
    

xdg_configs="awesome pgcli fish"
skip_files="init.sh bin README.md Vagrantfile.d"

function contains() {
    for x in $1; do
        [[ "$x" == "$2" ]] && return 0
    done
    return 1
}


for lfile in * */bash_aliases
do
    if (contains "$xdg_configs" $lfile || contains "$skip_files" $lfile); then
        #echo skipping $lfile
        continue
    fi

    if [[ -e $lfile ]]; then
        dolink $lfile
        $win && [ $lfile = "vim" ] && dolink $lfile "$HOME/vimfiles"
    fi

    if [[ -e $lfile/"$lfile"rc ]]; then
        dolink $lfile/"$lfile"rc
        $win && [ $lfile = "vim" ] && dolink "vim/_vimrc" "$HOME/_vimrc"
    fi
done

test -d $HOME/.config || mkdir $HOME/.config

for lfile in $xdg_configs
do
    dolink $lfile $HOME/.config/$lfile
done

test -d $HOME/.vagrant.d && dolink Vagrantfile.d $HOME/.vagrant.d/Vagrantfile

exit 0
