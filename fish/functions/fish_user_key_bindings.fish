# Hacks to make vi mode a bit more like vim. Hopefully will get some of these upstream soon

function fish_user_key_bindings
    # Note: fish_key_reader helps build bindings

    fish_vi_key_bindings

    type -q fzf_key_bindings; and fzf_key_bindings

    # ctrl-o to push current line to next prompt
    bind \co push-line
    bind -M insert \co push-line

    # fix some vi keybindings:
    _better_vi_mode

    # TODO: if tmux popup is available AND nvim is present..
    bind \ei edit_buffer_tmux
    bind -M insert \ei edit_buffer_tmux
end

function _better_vi_mode
    # TODO: hack in external program instead..
    # https://github.com/fish-shell/fish-shell/issues/1931
    #bind w _vi_forward_word

    # TODO: fix in C++
    bind --preset -e gu
    bind --preset -e gU

    if type -q tr
        bind guu '_downcase_x -b'
        bind gUU '_upcase_x -b'

        bind guiw '_downcase_x -t'
        bind guiW '_downcase_x -t'

        bind gUiw '_upcase_x -t'
        bind gUiW '_upcase_x -t'
    end
end

function _upcase_x
    set cur (commandline -C)
    commandline $argv (commandline $argv | tr '[[:lower:]]' '[[:upper:]]' )
    commandline -C $cur
    commandline -f repaint
end

function _downcase_x
    set cur (commandline -C)
    commandline $argv (commandline $argv | tr '[[:upper:]]' '[[:lower:]]' )
    commandline -C $cur
    commandline -f repaint
end

function _vi_forward_word
    set rest (_get_rest_of_buf | string split0)

    # get the index of the next word boundary with regex
    if set dist (string match -n -r '(?<!\A)\b(?=\w)' $rest | string split ' ')[1]
        commandline -C (math (commandline -C) + $dist - 1)
        commandline -f repaint
    end
end

function _get_rest_of_buf
    set -l buf (commandline -b | string split0)
    set -l pos (math (commandline -C) + 1)
    string sub -s $pos $buf
end

# vim: shiftwidth=4 tabstop=4 expandtab
