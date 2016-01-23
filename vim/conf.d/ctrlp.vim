if index(keys(g:plugs), 'ctrlp.vim') > -1
    let g:ctrlp_extensions = ['buffertag', 'tag', 'mixed']

    nmap <Space> :CtrlPBuffer<CR>
    nmap ,o :CtrlPBufTag<CR>

    let g:ctrlp_map = '<c-s-p>'
    let g:ctrlp_cmd = 'CtrlP'

    let g:ctrlp_custom_ignore = '\v([\/]\.(git|hg|svn)|.*\/docs\/.*|.*\/submodule-gmock\/.*)$'

    "unlet g:ctrlp_user_command
    let g:ctrlp_user_command = {
                \ 'types': {
                    \ 1: ['.git', 'cd %s && git ls-files && git ls-files --exclude-standard --other'],
                \ },
                \ 'fallback': 'find %s -type f'
            \}

    if executable('ag')
        let g:ctrlp_user_command['fallback'] = 'ag %s -l --nocolor -g ""'
        let g:ctrlp_use_caching = 0
    endif
endif
