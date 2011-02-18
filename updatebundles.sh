#!/bin/sh

base="$1"
[ -z "$base" ] && [ -d vimrc ] && base=`pwd`
[ -z "$base" ] && base=~/.vim

git submodule foreach git checkout master
git submodule foreach git pull
mkdir $base/autoload
mkdir $base/bundle
cp $base/lib/pathogen/autoload/* $base/autoload
echo

vim -e -c 'BundleInstall' -c 'q'
echo

for dir in $base/bundle/*
do
    (
        cd $dir
        echo $dir
        git pull
    )
done
