function h --wraps grep --description "search history"
  if test -z "$argv"
    fzf-history-widget
  else
    history search --reverse | grep $argv
  end
end

