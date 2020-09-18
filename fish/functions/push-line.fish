# https://gist.github.com/dedeibel/471526594cdb7f53cbfb354ba22d3ab5

# Save this file to ~/.config/fish/functions/push-line.fish

# Bind the function by using this in ~/.config/fish/functions/fish_user_key_bindings.fish
# function fish_user_key_bindings
#   # For example alt+q
#   bind \eq push-line
# end

function push-line
  commandline -f kill-whole-line
  function restore_line -e fish_postexec
    commandline -f yank
    functions -e restore_line
  end
end
