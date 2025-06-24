function install_worktree_util --description "Install or update worktree-util from dotfiles"
    if cargo install --path "$HOME/dotfiles/worktree-util" --force
        source "$HOME/.config/fish/config.fish"
    else
        return 1
    end
end 