function __bobthefish_pretty_parent -S -a child_dir -d 'Print a parent directory, shortened to fit the prompt'
    set -q fish_prompt_pwd_dir_length
    or set -l fish_prompt_pwd_dir_length 1

    # Replace $HOME with ~
    set -l real_home ~
    set -l parent_dir (string replace -r '^'"$real_home"'($|/)' '~$1' (__bobthefish_dirname $child_dir))

    ## TODO: not showing ~win, just ~ because of the code at the bottom. Need to add a new var that will
    ## hold the longer prefix and just strip it from the end..
    #set -l otherhome (string replace -r '^/mnt/c/Users/ryan.wooden($|/)' '~win$1' "$parent_dir")

    set -l parent_dir (string replace -r '^/mnt/c/Users/ryan.wooden($|/)' '~$1' "$parent_dir")

    # Must check whether `$parent_dir = /` if using native dirname
    if [ -z "$parent_dir" ]
        echo -n /
        return
    end

    if [ $fish_prompt_pwd_dir_length -eq 0 ]
        echo -n "$parent_dir/"
        return
    end

    string replace -ar '(\.?[^/]{'"$fish_prompt_pwd_dir_length"'})[^/]*/' '$1/' "$parent_dir/"
end
