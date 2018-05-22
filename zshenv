typeset -U path

[[ -f /usr/libexec/path_helper ]] && eval `/usr/libexec/path_helper -s`

uname -a | grep -q 'Microsoft' && win_home=$HOME/.windows/bin

path=(
    $HOME/bin
    $HOME/.bin
    $win_home
    $HOME/.local/bin
    $HOME/Dropbox/bin
    $HOME/conf/bin
    $HOME/.cabal/bin
    $HOME/.rvm/bin
    /usr/local/sbin
    /usr/local/bin
    /opt/local/bin

    $path
    .
)


EDITOR='vim'
VISUAL='vim'
VPAGER='vim -R -'

# Set up less
PAGER='less'
# show colors in less
LESS="-R"

# local stuff
LC_ALL='en_US.UTF-8'
LANG='en_US.UTF-8'
LC_CTYPE='C'

# timeout after 8h
LPASS_AGENT_TIMEOUT=2880
