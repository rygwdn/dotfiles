if index(keys(g:plugs), 'YouCompleteMe') == -1
    finish
endif


nnoremap <leader>jd :YcmCompleter GoToDeclaration<CR>
autocmd vimrc FileType python nnoremap <buffer> <CR> :YcmCompleter GoToDeclaration<CR>

"let g:ycm_path_to_python_interpreter = '/usr/bin/python2.7'
let g:ycm_key_list_select_completion = ['<TAB>', '<Down>']
let g:ycm_key_list_select_completion = ['<TAB>', '<Down>']
let g:ycm_key_list_previous_completion = ['<S-TAB>', '<Up>']

"let g:ycm_extra_conf_globlist = ['~/git/*','!~/*']

let g:ycm_confirm_extra_conf = 0
let g:ycm_filetype_blacklist = {
    \ 'notes' : 1,
    \ 'text' : 1,
    \ 'ruby' : 1,
    \ 'votl' : 1,
    \ 'yaml' : 1,
    \ 'qf' : 1,
    \}
