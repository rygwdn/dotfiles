"" Highlight EOL whitespace, http://vim.wikia.com/wiki/Highlight_unwanted_spaces
"highlight ExtraWhitespace ctermbg=red guibg=red
"autocmd ColorScheme * highlight ExtraWhitespace ctermbg=red guibg=red
"
"autocmd BufWinEnter * call s:HighlightWhitespace(0)
"
"" The above flashes annoyingly while typing, be calmer in insert mode
"autocmd InsertLeave * call s:HighlightWhitespace(0)
"autocmd InsertEnter * call s:HighlightWhitespace(1)
"
"function! s:HighlightWhitespace(insert)
"    if &filetype == 'unite'
"        return
"    elseif a:insert
"        match ExtraWhitespace /\s\+\%#\@<!$/
"    else
"        match ExtraWhitespace /\s\+$/
"    endif
"endfunction
"
"function! s:FixWhitespace(line1,line2)
"    let l:save_cursor = getpos(".")
"    silent! execute ':' . a:line1 . ',' . a:line2 . 's/\s\+$//'
"    call setpos('.', l:save_cursor)
"endfunction
"
"" Run :FixWhitespace to remove end of line white space
"command! -range=% FixWhitespace call <SID>FixWhitespace(<line1>,<line2>)
