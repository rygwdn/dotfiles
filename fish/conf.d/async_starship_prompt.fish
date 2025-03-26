status is-interactive
or exit 0

set -g STARSHIP_CMD $(which starship || /usr/local/bin/starship)

test -f STARSHIP_CMD
or exit 0

set -g __async_prompt_var _async_prompt_$fish_pid

# Setup after the user defined prompt functions are loaded.
function __async_prompt_setup_on_startup --on-event fish_prompt
    functions -e (status current-function)

    set func fish_right_prompt

    functions --copy $func __async_orig_$func

    set -U $__async_prompt_var'_'$func

    function $func -V func
        if test "$RIGHT_TRANSIENT" = 1
            set -g RIGHT_TRANSIENT 0
            return
        end

        if set -q $__async_prompt_var'_'$func
            set -l result $__async_prompt_var'_'$func
            echo -n $$result
        end
    end
end

function __async_prompt_keep_last_pipestatus
    set -g __async_prompt_last_pipestatus $pipestatus
end

function __async_prompt_fire --on-event fish_prompt
    set -l __async_prompt_last_pipestatus $pipestatus

    set -l func fish_right_prompt
    if test "$RIGHT_TRANSIENT" = 1
        set -g RIGHT_TRANSIENT 0
        return
    end

    if functions -q $func'_loading_indicator' && set -q $__async_prompt_var'_'$func
        set -l func_var $__async_prompt_var'_'$func
        set $__async_prompt_var'_'$func ($func'_loading_indicator' $$func_var)
    end

    __async_prompt_spawn $func
end

function __async_prompt_spawn -a cmd
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

    set -l prompt_cmd "$STARSHIP_CMD prompt --right --terminal-width=\"$COLUMNS\" --status=$STARSHIP_CMD_STATUS --pipestatus=\"$STARSHIP_CMD_PIPESTATUS\" --keymap=$STARSHIP_KEYMAP --cmd-duration=$STARSHIP_DURATION --jobs=$STARSHIP_JOBS"

    set -l script "
      set -U $__async_prompt_var"_"$cmd ($prompt_cmd)
      kill -s \"$(__async_prompt_config_internal_signal)\" $fish_pid &
    "

    fish -c $script &

    builtin disown
end

function __async_prompt_config_internal_signal
    if test -z "$async_prompt_signal_number"
        echo SIGUSR1
    else
        echo "$async_prompt_signal_number"
    end
end

function __async_prompt_repaint_prompt --on-signal (__async_prompt_config_internal_signal)
    commandline -f repaint >/dev/null 2>/dev/null
end

function __async_prompt_variable_cleanup --on-event fish_exit
    set -l prefix (string replace $fish_pid '' $__async_prompt_var)
    set -l prompt_vars (set --show | string match -rg '^\$('"$prefix"'\d+_[a-z_]+):' | uniq)
    for var in $prompt_vars
        set -l pid (string match -rg '^'"$prefix"'(\d+)_[a-z_]+' $var)
        if not ps $pid &>/dev/null
            or test $pid -eq $fish_pid
            set -Ue $var
        end
    end
    set -ge __async_prompt_var
end
