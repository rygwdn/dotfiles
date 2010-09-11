#!/bin/bash

for file in *
do
    hf=$HOME/.$file
    tf=`readlink -f $file`
    [ "`readlink -f $hf`" = "$tf" ] && continue

    if [ -e $hf ]
    then
        echo $hf exists 1>&2
    else
        ln -s $tf $hf
    fi
done

for file in */*rc
do
    bn=`basename $file`
    hf=$HOME/.$bn
    tf=`readlink -f $file`
    [ "`readlink -f $hf`" = "$tf" ] && continue

    if [ -e $hf ]
    then
        echo $hf exists 1>&2
    else
        ln -s $tf $hf
    fi
done
