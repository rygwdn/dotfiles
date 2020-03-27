function fish_title
    set realhome ~
    set -l tmp (string replace -r '^'"$realhome"'($|/)' '~$1' $PWD)
    set -l tmp (string replace -r '^/mnt/c/Users/ryan.wooden($|/)' '~$1' "$tmp")
    set -l tmp (string replace -r '^~/intellitrack-service($|/)' '~is$1' "$tmp")
    set -l tmp (string replace -r '^~/intellitrack-service-wip($|/)' '~isw$1' "$tmp")
    set -l tmp (string replace -r '^~/intellitrack-service-' '~is' "$tmp")
    string replace -ar '(\.?[^/]{'"$fish_prompt_pwd_dir_length"'})[^/]*/' '$1/' $tmp

    set -l current (status current-command)
    if [ "$current" != "fish" ]
         echo " $current"
    end
end
