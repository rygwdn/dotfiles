#!/bin/bash

if test "$1" = "cp"
then
    win="true"
else
    win="false"
fi

function dolink()
{
    file=$1
    hf=$HOME/.`basename $file`

    tf=`readlink -f $file`
    [ "`readlink -f $hf`" = "$tf" ] && continue

    if $win
    then
        [ -e $hf ] && rm -rf $hf
        echo "copy $tf to $hf"
        cp -r $tf $hf
    else
        if [ -e $hf ]
        then
            echo $hf exists 1>&2
        else
            echo "link $tf -> $hf"
            ln -s $tf $hf
        fi
    fi
}
    

for lfile in * */bash_aliases */*rc
do
    dolink $lfile
done
