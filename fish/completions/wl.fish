# Disable file completions
complete -c wl -f

# Use the Ruby script to generate completions
complete -c wl -a '(ruby ~/.config/fish/wl.rb --list)' -d 'Navigate to project'