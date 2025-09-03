set -g STARSHIP_CMD $(which starship 2>/dev/null || which /usr/local/bin/starship 2>/dev/null || which /opt/homebrew/bin/starship 2>/dev/null)
test -f "$STARSHIP_CMD" || exit 0


set -gx STARSHIP_SESSION_KEY (string sub -s1 -l16 (random)(random)(random)(random)(random)0000000000000000)

function fish_prompt
    switch "$fish_key_bindings"
        case fish_hybrid_key_bindings fish_vi_key_bindings
            set STARSHIP_KEYMAP "$fish_bind_mode"
        case '*'
            set STARSHIP_KEYMAP insert
    end

    set STARSHIP_CMD_PIPESTATUS $pipestatus
    set STARSHIP_CMD_STATUS $status
    set STARSHIP_DURATION "$CMD_DURATION$cmd_duration"
    set STARSHIP_JOBS (count (jobs -p))

    set -fx WORKTREE_PATH_PREFIX "$WORKTREE_PATH_PREFIX"
    set -fx WORKTREE_PATH_SHORTENED "$WORKTREE_PATH_SHORTENED"
    set -fx WORKTREE_PATH_NORMAL "$WORKTREE_PATH_NORMAL"

    if test "$TRANSIENT" = "1"
        set -g TRANSIENT 0
        printf "\e[0J\e[1;32m❯\e[0m "
    else
        $STARSHIP_CMD prompt --terminal-width="$COLUMNS" --status=$STARSHIP_CMD_STATUS --pipestatus="$STARSHIP_CMD_PIPESTATUS" --keymap=$STARSHIP_KEYMAP --cmd-duration=$STARSHIP_DURATION --jobs=$STARSHIP_JOBS
    end
end

set -g VIRTUAL_ENV_DISABLE_PROMPT 1

builtin functions -e fish_mode_prompt

function transient_execute
    if test -z "$FISH_SIMPLE_TERM"
        # Update prompts to show transient prompt
        if commandline --is-valid || test -z (commandline | string collect) && not commandline --paging-mode
            set -g TRANSIENT 1
            set -g RIGHT_TRANSIENT 1
            commandline -f repaint
        end
    end

    commandline -f execute
end

bind --user \r transient_execute
bind --user -M insert \r transient_execute
