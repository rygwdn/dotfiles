# Skip async prompt for simple terminals and non-interactive shells
test -n "$FISH_SIMPLE_TERM" && exit 0
status is-interactive || exit 0

set -g STARSHIP_CMD $(which starship || /usr/local/bin/starship)
test -f "$STARSHIP_CMD" || exit 0

set -g __async_prompt_var _async_prompt_$fish_pid'_rprompt'

# Setup after the user defined prompt functions are loaded.
function __async_prompt_setup_on_startup --on-event fish_prompt
    functions -e (status current-function)

    set -U $__async_prompt_var

    function fish_right_prompt
        if test "$RIGHT_TRANSIENT" = 1
            set -g RIGHT_TRANSIENT 0
            return
        end

        if set -q $__async_prompt_var
            echo -n $$__async_prompt_var
        end
    end
end

function __async_prompt_fire --on-event fish_prompt
    set -l __async_prompt_last_pipestatus $pipestatus

    if test "$RIGHT_TRANSIENT" = 1
        set -g RIGHT_TRANSIENT 0
        return
    end

    if set -q $__async_prompt_var
        # Strip ANSI colors and show in brblack
        echo -n $$__async_prompt_var | sed -r 's/\x1B\[[0-9;]*[JKmsu]//g' | read -zl uncolored_prompt
        set $__async_prompt_var (set_color brblack)"$uncolored_prompt"(set_color normal)
    end

    __async_prompt_spawn
end

function __async_prompt_spawn
    switch "$fish_key_bindings"
        case fish_hybrid_key_bindings fish_vi_key_bindings
            set STARSHIP_KEYMAP "$fish_bind_mode"
        case '*'
            set STARSHIP_KEYMAP insert
    end
    set STARSHIP_CMD_PIPESTATUS $__async_prompt_last_pipestatus
    set STARSHIP_CMD_STATUS $status
    # Account for changes in variable name between v2.7 and v3.0
    set STARSHIP_DURATION "$CMD_DURATION$cmd_duration"
    set STARSHIP_JOBS (count (jobs -p))

    set -l prompt_cmd "STARSHIP_CONFIG=$STARSHIP_CONFIG $STARSHIP_CMD prompt --right --terminal-width=\"$COLUMNS\" --status=$STARSHIP_CMD_STATUS --pipestatus=\"$STARSHIP_CMD_PIPESTATUS\" --keymap=$STARSHIP_KEYMAP --cmd-duration=$STARSHIP_DURATION --jobs=$STARSHIP_JOBS"

    set -l script "
      set -U $__async_prompt_var ($prompt_cmd)
      kill -s SIGUSR1 $fish_pid &
    "

    fish -c $script &

    builtin disown
end

function __async_prompt_repaint_prompt --on-signal SIGUSR1
    commandline -f repaint >/dev/null 2>/dev/null
end

function __async_prompt_variable_cleanup --on-event fish_exit
    set -l prefix _async_prompt_
    set -l prompt_vars (set --show | string match -rg '^\$('"$prefix"'\d+_rprompt):' | uniq)
    for var in $prompt_vars
        set -l pid (string match -rg '^'"$prefix"'(\d+)_rprompt' $var)
        if not ps $pid &>/dev/null
            or test $pid -eq $fish_pid
            set -Ue $var
        end
    end
    set -ge __async_prompt_var
end
