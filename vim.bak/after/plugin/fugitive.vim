function! FugitiveGitPath(path) abort
  return substitute(a:path, '^/mnt/\(\a\)/', '\1:/', '')
endfunction

function! FugitiveVimPath(path) abort
  return substitute(a:path, '^\(\a\):/', '/mnt/\1/', '')
endfunction
