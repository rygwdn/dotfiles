function __check_worktree_util_version
    set -l required_version '^0.4.0'
    set -l version_result (which worktree-util &>/dev/null && worktree-util version-check $required_version 2>&1)
    if test $status -eq 0
        return 0
    else
        if status is-interactive
            if test -z "$version_result"
                if not set -q __worktree_util_missing_warned
                    set -g __worktree_util_missing_warned 1
                    echo "⚠️  worktree-util not found - features disabled" >&2
                    echo "   Install with: cargo install --path ~/dotfiles/worktree-util" >&2
                end
            else
                if not set -q __worktree_util_version_warned
                    set -g __worktree_util_version_warned 1
                    echo "⚠️  worktree-util version incompatible - features disabled" >&2
                    echo "   $version_result" >&2
                    echo "   Update with: cargo install --path ~/dotfiles/worktree-util --force" >&2
                end
            end
        end
        return 1
    end
end 