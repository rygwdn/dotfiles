#!/bin/sh

install=false
[ "$1" = "-i" ] && shift && install=true

echo "Init"
base="$1"
[ -z "$base" ] && [ -d vimrc ] && base=`pwd`
[ -z "$base" ] && base=~/.vim

[ -d $base/autoload ] || mkdir $base/autoload
[ -d $base/bundle ]   || mkdir $base/bundle

# pathogen and vundle
git submodule foreach git checkout master
git submodule foreach git pull
echo

echo Update autoloads
cp -r $base/lib/*/autoload/* $base/autoload/
echo

echo "Update bundles"
$install && bi='BundleInstall' || bi='BundleInstall!'
vim -u bundles.vim -e -c $bi -c 'q'

exit 0
