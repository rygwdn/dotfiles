if index(keys(g:plugs), 'vim-livedown') == -1
    finish
endif

let g:vim_markdown_new_list_item_indent = 2

command! LivedownStart call LivedownPreview()
autocmd FileType mkd nmap <buffer> gm :LivedownStart<CR>
autocmd FileType mkd nmap <buffer> zp 1z=


augroup rcmarkdown
    autocmd!
    autocmd FileType mkd setlocal comments=fb:*,fb:-,fb:+,n:> commentstring=>\ %s
    autocmd FileType mkd setlocal formatoptions+=tcqln formatoptions-=r formatoptions-=o
    autocmd FileType mkd setlocal formatlistpat=^\\s*\\d\\+\\.\\s\\+\\\|^[-*+]\\s\\+\\\|^\\[^\\ze[^\\]]\\+\\]:
    autocmd FileType mkd setlocal indentexpr=
    autocmd FileType mkd Wp
augroup end

