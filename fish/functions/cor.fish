function cor --description "checkout a recent branch"
  set -l branch (_pick_different_branch)
  if test $status -eq 0
    commandline git checkout $branch
    commandline -f execute
  end
end

