if test "$TERM" = wezterm
    and not infocmp wezterm &>/dev/null
    and command -q curl
    and command -q tic
    curl -fsSL https://raw.githubusercontent.com/wezterm/wezterm/main/termwiz/data/wezterm.terminfo | tic -x -o ~/.terminfo /dev/stdin
end
