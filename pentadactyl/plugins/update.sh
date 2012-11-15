#!/bin/sh

for file in *-dev.js
do
    echo update $file
    curl http://5digits.org/plugins/$file -o $file
done
