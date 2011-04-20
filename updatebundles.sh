#!/bin/sh

"Echo Init"
base="$1"
[ -z "$base" ] && [ -d vimrc ] && base=`pwd`
[ -z "$base" ] && base=~/.vim

git submodule foreach git checkout master
git submodule foreach git pull
mkdir $base/autoload
mkdir $base/bundle
#cp $base/lib/pathogen/autoload/* $base/autoload
echo

vim -e -c 'BundleInstall' -c 'q'
echo

echo "Update bundles"
for dir in $base/bundle/*
do
    (
        cd $dir
        echo $dir
        git pull
    )
done
echo

echo Update autoloads
for dir in $base/lib/*
do
    cp -r $dir/autoload/* $base/autoload/
done
