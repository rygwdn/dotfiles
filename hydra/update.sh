#!/bin/bash

mkdir -p ext/grid
curl 'https://raw.githubusercontent.com/sdegutis/hydra-grid/master/init.lua' -o ./ext/grid/init.lua

curl 'https://raw.githubusercontent.com/sdegutis/dotfiles/osx/home/.hydra/init' -o ./sdegutis.lua
