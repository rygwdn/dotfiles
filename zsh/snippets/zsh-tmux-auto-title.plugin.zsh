_set_title() {
    printf "\e]2;$1\e\\"
}

_zsh_tmux_title_preexec() {
    setopt extended_glob

    local cmd=${1[(wr)^(*=*|sudo|ssh|mosh|-*)]:gs/%/%%}

    [[ -z "$cmd" ]] && return

    _set_title $cmd
}

_zsh_tmux_title_precmd() {
    local title="$(git rev-parse --show-toplevel 2>/dev/null)"
    if [[ -n "$title" ]]
    then
        title="${title:t}"
        local git_rel="$(git rev-parse --show-prefix)"
        if [[ -n "$git_rel" ]]
        then
            title="${title}/${git_rel}"
        fi
        title=":${title%/}"
    else
        title=":$(print -rP %~)"
    fi

    _set_title "zsh${title}"
}

add-zsh-hook preexec _zsh_tmux_title_preexec
add-zsh-hook precmd _zsh_tmux_title_precmd
