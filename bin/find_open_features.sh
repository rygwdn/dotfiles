#!/bin/bash

#git rev-list --all --not origin/rc origin/misc/low origin/misc/high | xargs -L1 git name-rev | grep -oE '[0-9a-f]{40}\\s[^\\~\\^]*' | grep -vE '\\stags/' && true

nomerg () {
    git branch -rl 'origin/feature/*' --no-merged $1 --format='%(refname:short)' | sort
}

unmerged="$(nomerg origin/rc)"
for branch in origin/misc/low origin/misc/high
do
    # intersect..
    unmerged="$(comm -12 <(echo "$unmerged") <(nomerg ${branch}))"
done

echo "${unmerged}" | while read branch
do
    issues="$(git log "${branch}" --not origin/rc origin/misc/high origin/misc/low origin/utilities '--format=format:%B' | grep -o 'ITK[A-Z]*-[0-9]\+' | sort -u | paste -sd "," - | sed 's/,/, /g')"
    echo "${branch} (${issues})"
done

