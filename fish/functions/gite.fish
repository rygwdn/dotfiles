function gite --wraps git --description "use whichever git is needed"
  if type -q git.exe
    set fstype ( stat -f -c %T . )

    if test $fstype = "wslfs"
      git.exe $argv
      return $status
    end
  end

  git $argv
  return $status
end

