#!/bin/sh

git submodule foreach git checkout master
git submodule foreach git pull
echo

vim -e -c 'BundleInstall' -c 'q'
echo

for dir in bundle/*
do
    (
        cd $dir
        echo $dir
        git pull
    )
done
echo

for dir in lib/*
do
    cp -r $dir/autoload/* autoload/
done
