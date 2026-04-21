command -q starship || test -x /opt/homebrew/bin/starship || exit 0

# Per-pid tempfile-based async right prompt.
#
# Replaces the previous universal-variable-based implementation so that:
#   - $fish_variables is not polluted with _async_prompt_<pid>_rprompt entries
#   - no cross-session broadcast of prompt state
#   - cleanup is per-pid and automatic via mktemp -d + fish_exit
#
# Flow:
#   fish_prompt event  → spawn a background fish that runs starship, writes
#                        the rendered right prompt atomically to a pid-scoped
#                        tempfile, then SIGUSR1's the parent.
#   SIGUSR1 handler    → `commandline -f repaint`.
#   fish_right_prompt  → reads the tempfile (effectively memory/tmpfs IO).

set -g __async_prompt_tmpdir (command mktemp -d -t fish_async_prompt.XXXXXX)
set -g __async_prompt_rfile $__async_prompt_tmpdir/rprompt

function fish_right_prompt
    # Hide right prompt when transient
    if contains -- --final-rendering $argv
        return
    end

    test -e $__async_prompt_rfile
    and string collect <$__async_prompt_rfile
end

function __async_prompt_fire --on-event fish_prompt
    test -n "$FISH_SIMPLE_TERM" && return

    set -l __async_prompt_last_pipestatus $pipestatus

    # Repaint the existing prompt greyed-out as a loading indicator while the
    # new one renders in the background.
    if test -e $__async_prompt_rfile
        read -zl prev <$__async_prompt_rfile
        echo -n $prev | sed -r 's/\x1B\[[0-9;]*[JKmsu]//g' | read -zl uncolored
        printf '%s' (set_color brblack)$uncolored(set_color normal) >$__async_prompt_rfile
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
    set STARSHIP_DURATION "$CMD_DURATION$cmd_duration"
    set STARSHIP_JOBS (count (jobs -p))

    set -l prompt_cmd "STARSHIP_CONFIG=$STARSHIP_CONFIG $STARSHIP_CMD prompt --right --terminal-width=\"$COLUMNS\" --status=$STARSHIP_CMD_STATUS --pipestatus=\"$STARSHIP_CMD_PIPESTATUS\" --keymap=$STARSHIP_KEYMAP --cmd-duration=$STARSHIP_DURATION --jobs=$STARSHIP_JOBS"

    # Write to a sibling file then rename — avoids torn reads if the parent
    # repaints concurrently with a slow starship run.
    set -l script "
      set -l tmp $__async_prompt_rfile.\$fish_pid
      $prompt_cmd >\$tmp
      and command mv -f \$tmp $__async_prompt_rfile
      kill -s SIGUSR1 $fish_pid &
    "

    set -l fish_bin (status fish-path)
    FISH_BG=1 $fish_bin -c $script &

    builtin disown
end

function __async_prompt_repaint_prompt --on-signal SIGUSR1
    commandline -f repaint >/dev/null 2>/dev/null
end

function __async_prompt_tmpdir_cleanup --on-event fish_exit
    command rm -rf "$__async_prompt_tmpdir"
end
