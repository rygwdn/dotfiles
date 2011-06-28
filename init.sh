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

    if [ -e $hf ]
    then
        echo $hf exists 1>&2
    elif $win
        echo "link $tf -> $hf"
        [ -d $hf ] && mklink \d $tf $hf || mklink $tf $hf
    else
        echo "link $tf -> $hf"
        ln -s $tf $hf
    fi
}
    

for lfile in * */bash_aliases */*rc
do
    dolink $lfile
done
