#!/bin/sh

git submodule foreach git checkout master
git submodule foreach git pull
vim -e -c 'BundleInstall' -c 'q'
