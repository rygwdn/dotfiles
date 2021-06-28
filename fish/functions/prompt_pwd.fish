# Personal implementation to handle some additional directories
function prompt_pwd --description 'Print the current working directory, shortened to fit the prompt'
    set -l options h/help
    argparse -n prompt_pwd --max-args=0 $options -- $argv
    or return

    if set -q _flag_help
        __fish_print_help prompt_pwd
        return 0
    end

    # This allows overriding fish_prompt_pwd_dir_length from the outside (global or universal) without leaking it
    set -q fish_prompt_pwd_dir_length
    or set -l fish_prompt_pwd_dir_length 1

    # Replace $HOME with "~"
    set -l realhome ~
    set -l tmp (string replace -r '^'"$realhome"'($|/)' '~$1' $PWD)

    set -l tmp (string replace -r '^/mnt/c/Users/ryan.wooden($|/)' '~win$1' $tmp)
    set -l tmp (string replace -r '^'"$is"'($|/)' '~\\\$is$1' $tmp)
    set -l tmp (string replace -r '^'"$isw"'($|/)' '~\\\$isw$1' $tmp)
    set -l tmp (string replace -r '^'"$ist"'($|/)' '~\\\$ist$1' $tmp)
    set -l tmp (string replace -r '^'"$isp"'($|/)' '~\\\$isp$1' $tmp)
    set -l tmp (string replace -r '^/mnt/d/src($|/)' '~src$1' $tmp)

    if [ $fish_prompt_pwd_dir_length -eq 0 ]
        echo $tmp
    else
        # Shorten to at most $fish_prompt_pwd_dir_length characters per directory
        #string replace -ar '(\.?[^/]{'"$fish_prompt_pwd_dir_length"'})[^/]*/' '$1/' $tmp
        string replace -ar '(~[^/]*|\.?[^/]{'"$fish_prompt_pwd_dir_length"'})[^/]*/' '$1/' $tmp
    end
end
