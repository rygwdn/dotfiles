function wl --description "Navigate to worktrees and repositories"
    set -l result (ruby ~/.config/fish/wl.rb $argv)
    
    # If the result is a directory path, cd to it
    if test -d "$result"
        cd "$result"
    else if test -n "$result"
        # If it's not a directory but we got output, print it
        echo "$result"
    end
end