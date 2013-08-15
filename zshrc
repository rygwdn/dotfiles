#! /bin/zsh

[[ -z "$TIMEIT" ]] && TIMEIT=false
#TIMEIT=true

if $TIMEIT
then
    export logfile=$(mktemp)

    typeset -F SECONDS=0
    zmodload zsh/datetime
    typeset -F START_TIME=$EPOCHREALTIME
    typeset -i 10 diff_time=0
    typeset -i 10 from_start=0

    function logTime() {
        (( diff_time = SECONDS * 1000 ))
        (( from_start = (EPOCHREALTIME - START_TIME) * 1000 ))

        [[ ${diff_time} -gt 20 ]] && echo "\t+${diff_time}ms" >> "$logfile"
        echo "${from_start}ms\t$@" >> "$logfile"
        SECONDS=0
    }

    zmodload zsh/zprof
else
    function logTime {}
fi

logTime "start zshrc"

source /etc/profile

logTime "did profile"

# update the function path to include custom stuff
fpath=(~/.zsh/completion $fpath) 

[ -z $HOST ] && export HOST=`hostname`

for file in $(find ~/.zsh/conf.d -type f \
    -name 'S*' -and \
    -not -iname '*.zwc' -and \
    -not -iname '*~' -and \
    -not -iname '*.old' \
    | sort)
do
    logTime "$(basename $file) source"
    source $file
    logTime "$(basename $file) done"
done

logTime "done zshrc"

if $TIMEIT
then
    (cat "$logfile" ; zprof ) | $PAGER
    zmodload -u zsh/zprof
    rm "$logfile"
fi
