# Disable default greeting
set -g fish_greeting

# Configure path
fish_add_path -gm \
    ~/bin \
    ~/.bin \
    ~/dotfiles/bin \
    ~/.local/bin \
    ~/.dev/userprofile/bin/ \
    /opt/homebrew/opt/rustup/bin \
    ~/.cabal/bin \
    ~/.cargo/bin \
    ~/.rvm/bin \
    ~/.deno/bin \
    ~/go/bin \
    /usr/local/sbin \
    /usr/local/bin \
    /opt/local/bin \
    /opt/homebrew/bin \
    /opt/homebrew/opt/fish/bin \
    /opt/homebrew/opt/starship/bin \
    ~/.fzf/bin \
    ~/.poetry/bin \
    ~/.local/bin \
    /Applications/Obsidian.app/Contents/MacOS


abbr co  'git checkout'
abbr ci  'git commit'
abbr pff  'git pull --ff-only'
abbr gfu  'git fetch origin'
abbr pof 'git push origin --force-with-lease'
abbr gph 'git push origin --set-upstream HEAD'
abbr rbc 'git rebase --continue'
abbr rbi 'git rbi'
abbr gls 'git log'
abbr glss 'git log --oneline'
abbr frs 'git pull --rebase'
abbr gm 'git commit --amend --no-edit'


abbr ll ls -l
abbr la ls -A
abbr st git st
abbr gd git diff
abbr gdc git diff --cached
abbr br git branch
abbr show git show
abbr "c." code .

abbr mdf cd ~/dotfiles

if status is-interactive
    if not command -q jumpr
        echo "jumpr not found, installing..."
        curl -fsSL https://raw.githubusercontent.com/rygwdn/jump/main/get-jumpr.sh | sh -s -- --install-dir "$HOME/.local/bin"
    end
    if command -q jumpr
        # Cache jumpr shell integration (saves ~10ms fork/exec per startup)
        set -l jumpr_cache ~/.cache/fish/jumpr-init.fish
        set -l jumpr_bin (command -s jumpr)
        if not test -f $jumpr_cache; or test $jumpr_bin -nt $jumpr_cache
            mkdir -p ~/.cache/fish
            jumpr shell-init --shell fish > $jumpr_cache
        end
        source $jumpr_cache
    end
end

test -d ~/Documents/Personal/.obsidian && abbr nn cd ~/Documents/Personal

set -U __done_exclude '(git (?!push|pull)|vim)'

set -x EDITOR vim
set -x VISUAL vim
set -x VPAGER 'vim -R -'

# Set up less
set -x PAGER less
# show colors in less
set -x LESS -R

# locale stuff
set -x LC_ALL 'en_US.UTF-8'
set -x LANG 'en_US.UTF-8'
set -x LC_CTYPE C

set fish_vi_force_cursor 1
set fish_cursor_default block
set fish_cursor_insert line
set fish_cursor_replace_one underscore

set -x SHELL (status fish-path)
set -x STARSHIP_SHELL /bin/sh

if test -n "$COMPOSER_NO_INTERACTION" || ! status is-interactive
    set -x FISH_NOT_INTERACTIVE 1

    set -x PAGER cat
    set -x GIT_PAGER cat
    set -x GH_PAGER cat
    set -x GH_PROMPT_DISABLED true
end

if test "$TERM_PROGRAM" = vscode || test -n "$FISH_NOT_INTERACTIVE"
    set -x FISH_SIMPLE_TERM 1
end

# Suppress OSC 10/11 responses that leak in tmux+vscode
if test "$TERM_PROGRAM" = vscode && set -q TMUX
    printf '\e]10;?\e\\'
    printf '\e]11;?\e\\'
end

if test -n "$FISH_SIMPLE_TERM"
    set -x STARSHIP_CONFIG "$HOME/dotfiles/starship-simple.toml"
    # Disable OSC 133 prompt markers in simple terminals (fish 4.x)
    set -g fish_features no-mark-prompt
else
    set -x STARSHIP_CONFIG "$HOME/dotfiles/starship.toml"
    set -g fish_transient_prompt 1
end

# bun
set --export BUN_INSTALL "$HOME/.bun"
set --export PATH $BUN_INSTALL/bin $PATH
