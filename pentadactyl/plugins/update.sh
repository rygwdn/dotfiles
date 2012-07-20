#!/bin/sh

for file in *-dev.js
do
    echo update $file
    curl http://5digits.org/cgi-bin/hgweb.cgi/raw-file/tip/htdocs/plugins/$file -o $file
done
