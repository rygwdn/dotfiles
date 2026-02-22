function install_world_nav --description "Install or update world-nav from dotfiles"
    if cargo install --path "$HOME/src/github.com/rygwdn/jump" --force
        source "$HOME/.config/fish/config.fish"
    else
        return 1
    end
end

