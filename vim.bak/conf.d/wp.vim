" Word processing (latex, some? plain text)

fun! Wp()
    set wrap
    set linebreak
    runtime autocorrect.vim
    nnoremap j gj
    nnoremap k gk
    nnoremap 0 g0
    nnoremap $ g$
    nnoremap <Home> g0
    nnoremap <End> g$
    set spell spelllang=en_us
    set display+=lastline
endfu

command! Wp call Wp()

autocmd vimrc FileType tex,pdc,mail Wp
