if index(keys(g:plugs), 'neomake') == -1
    finish
endif


function! PylintIgnore()
    redir => message
    silent call neomake#EchoCurrentError()
    redir END

    if ! empty(message)
        let key = matchstr(message, "^.*pylint: \\[\\zs[^\\]]*\\ze\\]")
        exec "normal! O# pylint: disable=" . key . "\e"
    endif
endfun

nnoremap ,pi :call PylintIgnore()<CR>

autocmd! BufWritePost * Neomake
