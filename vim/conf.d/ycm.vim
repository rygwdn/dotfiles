nnoremap <leader>jd :YcmCompleter GoToDefinitionElseDeclaration<CR>

let g:ycm_key_list_select_completion = ['<TAB>', '<Down>']
let g:ycm_key_list_previous_completion = ['<S-TAB>', '<Up>']

"let g:ycm_extra_conf_globlist = ['~/git/*','!~/*']

let g:ycm_confirm_extra_conf = 0
let g:ycm_filetype_blacklist = {
    \ 'notes' : 1,
    \ 'markdown' : 1,
    \ 'text' : 1,
    \ 'ruby' : 1,
    \ 'votl' : 1,
    \ 'yaml' : 1,
    \ 'rst' : 1,
    \}
