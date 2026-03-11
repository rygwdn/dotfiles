# Install wezterm terminfo if missing (use fast file checks instead of infocmp subprocess)
if test "$TERM" = wezterm
    and not begin
        test -f ~/.terminfo/w/wezterm
        or test -f ~/.terminfo/77/wezterm
        or test -f /usr/share/terminfo/77/wezterm
        or test -f /Applications/WezTerm.app/Contents/Resources/terminfo/77/wezterm
    end
    and command -q curl
    and command -q tic
    curl -fsSL https://raw.githubusercontent.com/wezterm/wezterm/main/termwiz/data/wezterm.terminfo | tic -x -o ~/.terminfo /dev/stdin
end
