#!/bin/sh

install=false
[ "$1" = "-i" ] && shift && install=true

nobundle=false
[ "$1" = "-n" ] && shift && nobundle=true

echo "Init"
base="$1"
[ -z "$base" ] && [ -e vimrc ] && base=`pwd`
[ -z "$base" ] && base=~/.vim

[ -d "$base/autoload" ] || mkdir "$base/autoload"
[ -d "$base/bundle" ]   || mkdir "$base/bundle"

$install && git submodule init
$install && git submodule update

# pathogen and vundle
git submodule foreach git checkout master
git submodule foreach git pull
echo

echo Update autoloads
cp -r "$base"/lib/*/autoload/* "$base/autoload/"
echo

$nobundle && echo "Now to :BundleInstall from vim" && exit 0

echo "Update bundles"
$install && bi='BundleInstall' || bi='BundleInstall!'
vim -u bundles.vim -e +$bi +'qall'

exit 0
