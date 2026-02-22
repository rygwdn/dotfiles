function fish_title
    # If we're connected via ssh, we print the hostname.
    set -l ssh
    set -q SSH_TTY
    and set ssh "["(prompt_hostname | string sub -l 10 | string collect)"]"

    # An override for the current command is passed as the first parameter.
    # This is used by `fg` to show the true process name, among others.
    set -l cmd
    if set -q argv[1]
        set cmd (string sub -l 20 -- $argv[1])
    else
        # Don't print "fish" because it's redundant
        set -l current_cmd (status current-command)
        if test "$current_cmd" != fish
            set cmd (string sub -l 20 -- $current_cmd)
        end
    end

    set -l path_display (jumpr shortpath --section full $PWD 2>/dev/null)
    test -z "$path_display" && set path_display (prompt_pwd -d 1 -D 1)

    # Build the title: [ssh] command path
    set -l title_parts
    if test -n "$ssh"
        set -a title_parts $ssh
    end
    if test -n "$cmd"
        set -a title_parts $cmd
    end
    if test -n "$path_display"
        set -a title_parts $path_display
    end

    echo (string join " " $title_parts)
end
