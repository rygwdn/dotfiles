# Find starship binary — prefer PATH lookup (builtin, no subprocess), fall back to known locations
if command -q starship
    set -g STARSHIP_CMD (command -s starship)
else if test -x /opt/homebrew/bin/starship
    set -g STARSHIP_CMD /opt/homebrew/bin/starship
else if test -x /usr/local/bin/starship
    set -g STARSHIP_CMD /usr/local/bin/starship
else
    exit 0
end


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
