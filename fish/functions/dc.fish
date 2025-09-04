function dc --description "Clone GitHub repo to ~/src/github.com/<owner>/<repo> and cd to it"
    if test -z "$argv"
        echo "Usage: dc <github-url-or-repo>"
        echo "Examples:"
        echo "  dc https://github.com/username/repo"
        echo "  dc git@github.com:username/repo.git"
        echo "  dc username/repo"
        return 1
    end

    set -l repo_arg $argv[1]
    
    # Use gh to get the repo name in owner/repo format
    set -l repo_name (gh repo view $repo_arg --json nameWithOwner --jq .nameWithOwner 2>/dev/null)
    if test $status -ne 0
        echo "Error: Could not find repository '$repo_arg'"
        echo "Make sure the repository exists and you have access to it"
        return 1
    end
    
    # Split into owner and repo
    set -l parts (string split "/" $repo_name)
    set -l owner $parts[1]
    set -l repo $parts[2]
    set -l target_dir "$HOME/src/github.com/$owner/$repo"
    
    # Create the directory structure if it doesn't exist
    if not test -d "$HOME/src/github.com/$owner"
        mkdir -p "$HOME/src/github.com/$owner"
    end
    
    # Clone if the repo doesn't exist, otherwise just cd to it
    if test -d $target_dir
        echo "Repository already exists at $target_dir"
        cd $target_dir
    else
        echo "Cloning $repo_name to $target_dir"
        if gh repo clone $repo_name $target_dir
            cd $target_dir
        else
            echo "Error: Failed to clone repository"
            return 1
        end
    end
end
