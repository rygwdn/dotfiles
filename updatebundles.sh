#!/bin/sh

echo "Init"
base="$1"
[ -z "$base" ] && [ -e vimrc ] && base=`pwd`
[ -z "$base" ] && base=~/.vim

[ -d "$base/autoload" ] || mkdir "$base/autoload"
[ -d "$base/bundle" ]   || mkdir "$base/bundle"

git submodule update --init

# pathogen and vundle
git submodule foreach 'git checkout master && git pull'
echo

echo Update autoloads
cp -r "$base"/lib/*/autoload/* "$base/autoload/"
echo

echo 'Now to :BundleInstall! from vim'
