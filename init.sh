#!/bin/bash

for file in *
do
    hf=$HOME/.$file
    if [ -e $hf ]
    then
        echo $hf exists 1>&2
    else
        ln -s $PWD/$file $hf
    fi
done

for file in */*rc
do
    bn=`basename $file`
    hf=$HOME/.$bn
    if [ -e $hf ]
    then
        echo $hf exists 1>&2
    else
        ln -s $PWD/$file $hf
    fi
done
