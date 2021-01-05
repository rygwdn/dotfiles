function edit_buffer_tmux --description 'Edit the command buffer in a tmux popup'
    set -l f (mktemp)
    if set -q f[1]
        mv $f $f.fish
        set f $f.fish
    else
        # We should never execute this block but better to be paranoid.
        if set -q TMPDIR
            set f $TMPDIR/fish.$fish_pid.fish
        else
            set f /tmp/fish.$fish_pid.fish
        end
        touch $f
        or return 1
    end

    commandline -b >$f
    set -l offset (commandline --cursor)
    # compute cursor line/column
    set -l lines (commandline)\n
    set -l line 1
    while test $offset -ge (string length -- $lines[1])
        set offset (math $offset - (string length -- $lines[1]))
        set line (math $line + 1)
        set -e lines[1]
    end
    set col (math $offset + 1)

    __fish_disable_bracketed_paste

    set -l editor 'env VIM_FISH_BUNDLES=1 nvim'
    set -a editor +$line +"norm $col|" $f
    tmux popup -KER "env VIM_FISH_BUNDLES=1 nvim '+$line' '+norm $col|' '$f'"

    set -l editor_status $status
    __fish_enable_bracketed_paste

    # Here we're checking the exit status of the editor.
    if test $editor_status -eq 0 -a -s $f
        # Set the command to the output of the edited command and move the cursor back
        commandline -r -- (cat $f)
        commandline -C (math $col - 1)
    else
        echo
        echo (_ "Ignoring the output of your editor since its exit status was non-zero")
        echo (_ "or the file was empty")
    end

    command rm $f
    # We've probably opened something that messed with the screen.
    # A repaint seems in order.
    commandline -f repaint
end
