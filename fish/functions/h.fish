function h --wraps grep --description "search history"
    if test -z "$argv"
        if type -q fzf-history-widget
            fzf-history-widget
        else
            history search --reverse -n 10 | cat
        end
    else
        history search --reverse | grep $argv
    end
end
