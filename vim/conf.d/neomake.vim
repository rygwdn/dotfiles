if index(keys(g:plugs), 'neomake') == -1
    finish
endif

autocmd! BufWritePost * Neomake
