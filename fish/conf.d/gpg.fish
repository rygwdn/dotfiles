if status --is-interactive && test -f /etc/fish/conf.d/gpg.fish
    # This causes problems when loaded from async prompt
    source /etc/fish/conf.d/gpg.fish
end
