if index(keys(g:plugs), 'syntastic') == -1
    finish
endif

function! PylintIgnore()
  let messageUnderCursor = get(get(get(b:syntastic_private_messages, line('.'), []), 0, {}), "text", "")
  let key = matchstr(messageUnderCursor, "^\\[\\zs[^\\]]*\\ze\\]")
  if key != ""
    exec "normal! O# pylint: disable=" . key . "\e"
  endif
endfun

nnoremap ,pi :call PylintIgnore()<CR>
