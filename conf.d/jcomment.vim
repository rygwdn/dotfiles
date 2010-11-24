
command! JCommentWriter silent call JCommentWriter()
autocmd FileType java :nnoremap <silent> <buffer> <leader>jc :call JCommentWriter()<cr>
