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

    # If world-nav hasn't populated path vars, fall back to prompt_pwd
    if not set -q WORKTREE_PATH_NORMAL; or test -z "$WORKTREE_PATH_NORMAL"
        set -fx WORKTREE_PATH_PREFIX ""
        set -fx WORKTREE_PATH_SHORTENED ""
        set -fx WORKTREE_PATH_NORMAL (prompt_pwd -d 1 -D 1)
    else
        set -fx WORKTREE_PATH_PREFIX "$WORKTREE_PATH_PREFIX"
        set -fx WORKTREE_PATH_SHORTENED "$WORKTREE_PATH_SHORTENED"
        set -fx WORKTREE_PATH_NORMAL "$WORKTREE_PATH_NORMAL"
    end

    if contains -- --final-rendering $argv
        # Transient prompt (simplified)
        printf "\e[0J\e[1;32m❯\e[0m "
    else
        # Full prompt
        $STARSHIP_CMD prompt --terminal-width="$COLUMNS" --status=$STARSHIP_CMD_STATUS --pipestatus="$STARSHIP_CMD_PIPESTATUS" --keymap=$STARSHIP_KEYMAP --cmd-duration=$STARSHIP_DURATION --jobs=$STARSHIP_JOBS
    end
end

set -g VIRTUAL_ENV_DISABLE_PROMPT 1

builtin functions -e fish_mode_prompt
