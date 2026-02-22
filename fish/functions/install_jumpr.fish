function install_jumpr --description "Install or update jumpr from GitHub pre-built binary"
    if curl -fsSL https://raw.githubusercontent.com/rygwdn/jump/main/get-jumpr.sh | sh -s -- --install-dir "$HOME/.local/bin"
        source "$HOME/.config/fish/config.fish"
    else
        return 1
    end
end
