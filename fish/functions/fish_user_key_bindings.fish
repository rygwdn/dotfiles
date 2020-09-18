function fish_user_key_bindings
    fish_vi_key_bindings

    type -q fzf_key_bindings; and fzf_key_bindings

    # ctrl-o to push current line to next prompt
    bind \co push-line
    bind -M insert \co push-line

    # fix some vi keybindings:
    _better_vi_mode

    # Note: fish_key_reader helps build bindings
end

function _better_vi_mode
    # default keybindings miss 1 char
    bind dt begin-selection forward-jump kill-selection end-selection
    bind df begin-selection forward-jump forward-char kill-selection end-selection

    bind ct -m insert begin-selection forward-jump kill-selection end-selection force-repaint
    bind cf -m insert begin-selection forward-jump forward-char kill-selection end-selection force-repaint

    # better tilde..
    bind '~' vimtilde
    bind --preset '~' vimtilde

    bind w _vi_forward_word

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

function vimtilde
    set -l cur_chr (_cur_chr)

    set upper_chr (string upper $cur_chr)
    set lower_chr (string lower $cur_chr)

    if test $upper_chr = $lower_chr
        commandline -f forward-char
        commandline -f repaint
        return
    end

    set new_chr (
        if test x$cur_chr = x$upper_chr
            echo $lower_chr
        else
            echo $upper_chr
        end
    )

    commandline -i $new_chr
    commandline -f delete-char
    commandline -f repaint
end

function _cur_chr
    set -l buf (commandline -b | string split0)
    set -l pos (math (commandline -C) + 1)
    string sub -s $pos -l 1 $buf
end

function _get_rest_of_buf
    set -l buf (commandline -b | string split0)
    set -l pos (math (commandline -C) + 1)
    string sub -s $pos $buf
end

# vim: sw=4,noet
