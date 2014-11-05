let g:multi_cursor_exit_from_insert_mode = 1

" Called once right before you start selecting multiple cursors
function! Multiple_cursors_before()
  call youcompleteme#DisableCursorMovedAutocommands()
endfunction

" Called once only when the multiple selection is canceled (default <Esc>)
function! Multiple_cursors_after()
  call youcompleteme#EnableCursorMovedAutocommands()
endfunction
