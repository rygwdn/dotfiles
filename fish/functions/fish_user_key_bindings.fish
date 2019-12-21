# Defined in /tmp/fish.WlCnUw/fish_user_key_bindings.fish @ line 2
function fish_user_key_bindings
	fish_vi_key_bindings
        type -q fzf_key_bindings; and fzf_key_bindings

	# ctrl-o to push current line to next prompt
	bind \co push-line
	bind -M insert \co push-line

	# Note: fish_key_reader helps build bindings
end

