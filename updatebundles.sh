#!/bin/sh

echo "Init"
base="$1"
[ -z "$base" ] && [ -d vimrc ] && base=`pwd`
[ -z "$base" ] && base=~/.vim
[ -d $base/autoload ] || mkdir $base/autoload
[ -d $base/bundle ]   || mkdir $base/bundle

git submodule foreach git checkout master
git submodule foreach git pull
echo

echo Update autoloads
for dir in $base/lib/*
do
    cp -r $dir/autoload/* $base/autoload/
done
echo

echo "Update bundles"
vim -e -c 'BundleInstall!' -c 'q'
#for dir in $base/bundle/*
#do
#    (
#        cd $dir
#        echo $dir
#        git pull
#    )
#done
