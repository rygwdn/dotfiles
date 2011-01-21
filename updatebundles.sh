#!/bin/sh

git submodule foreach git checkout master
git submodule foreach git pull
echo

vim -e -c 'BundleInstall' -c 'q'
echo

for dir in ~/.vim/bundle/*
do
    (
        cd $dir
        echo $dir
        git pull
    )
done
